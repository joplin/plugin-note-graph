import { Note } from '../../data/Types';
import { NoteRepository } from '../../data/NoteRepository';
import { NotePreprocessor } from '../../data/NotePreprocessor';
import { EventsRepository } from '../../data/EventsRepository';
import { GraphCacheRepository } from '../../data/Database/GraphCacheRepository';
import { AnalysisController } from '../AnalysisController';
import { GraphData } from '../graph/types';
import { isAiAnalysisEnabled } from '../settings/GraphSettings';
import { EmbeddingChangeDetector } from './EmbeddingChangeDetector';
import { Logger, consoleLogger } from '../../utils/Logger';

const ITEM_CHANGE_DELETE = 3;

const DEFAULT_COALESCE_WINDOW_MS = 1000;

/** Joplin only re-embeds edits every few minutes, so sweeping more often than this finds nothing. */
const EMBEDDINGS_SWEEP_MIN_INTERVAL_MS = 150 * 1000;

/** Past this many changed notes, one full reload is cheaper than fetching each note on its own. */
const MAX_INCREMENTAL_UPSERTS = 1000;

export interface IncrementalUpdaterOptions {
	analysisController: AnalysisController;
	onGraphChanged: (graphData: GraphData) => void;
	onFullReloadNeeded: () => Promise<void>;
	noteRepository?: NoteRepository;
	preprocessor?: NotePreprocessor;
	eventsRepository?: EventsRepository;
	graphCache?: GraphCacheRepository;
	changeDetector?: Pick<EmbeddingChangeDetector, 'detect'>;
	coalesceWindowMs?: number;
	checkAiEnabled?: () => Promise<boolean>;
	now?: () => number;
	onEnrichmentProgress?: (progress: { current: number; total: number }) => void;
	logger?: Logger;
}

export class IncrementalUpdater {
	private readonly pendingUpsertIds = new Set<string>();
	private readonly pendingRemovedIds = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushChain: Promise<void> = Promise.resolve();
	private lastEmbeddingsSweepAt = 0;
	private embeddingsSweepInFlight = false;

	private readonly analysisController: AnalysisController;
	private readonly onGraphChanged: (graphData: GraphData) => void;
	private readonly onFullReloadNeeded: () => Promise<void>;
	private readonly noteRepository: NoteRepository;
	private readonly preprocessor: NotePreprocessor;
	private readonly eventsRepository: EventsRepository;
	private readonly graphCache: GraphCacheRepository;
	private readonly changeDetector: Pick<EmbeddingChangeDetector, 'detect'>;
	private readonly coalesceWindowMs: number;
	private readonly checkAiEnabled: () => Promise<boolean>;
	private readonly now: () => number;
	private readonly onEnrichmentProgress: (progress: { current: number; total: number }) => void;
	private readonly logger: Logger;

	private lastSelectedIds: string[] = [];

	public constructor(options: IncrementalUpdaterOptions) {
		this.analysisController = options.analysisController;
		this.onGraphChanged = options.onGraphChanged;
		this.onFullReloadNeeded = options.onFullReloadNeeded;
		this.noteRepository = options.noteRepository ?? new NoteRepository();
		this.preprocessor = options.preprocessor ?? new NotePreprocessor();
		this.eventsRepository = options.eventsRepository ?? new EventsRepository();
		this.graphCache = options.graphCache ?? new GraphCacheRepository();
		this.changeDetector =
			options.changeDetector ?? new EmbeddingChangeDetector(this.graphCache);
		this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
		this.checkAiEnabled = options.checkAiEnabled ?? isAiAnalysisEnabled;
		this.now = options.now ?? Date.now;
		this.onEnrichmentProgress = options.onEnrichmentProgress ?? (() => undefined);
		this.logger = options.logger ?? consoleLogger;
	}

	public handleNoteChange(event: { id: string; event: number }): void {
		if (event.event === ITEM_CHANGE_DELETE) {
			this.scheduleRemoval(event.id);
		} else {
			this.scheduleUpsert(event.id);
		}
	}

	/**
	 * Joplin only reports changes to the selected note, and moving a note to another
	 * notebook stops it being selected, so the note just left is checked as well.
	 */
	public handleSelectionChange(event: { value: string[] }): void {
		for (const id of [...this.lastSelectedIds, ...event.value]) {
			this.scheduleUpsert(id);
		}
		this.lastSelectedIds = event.value;
	}

	public async handleSyncComplete(): Promise<void> {
		if (!this.analysisController.hasNotes()) return;

		try {
			await this.sweepEmbeddings();

			const { upsertIds, removedIds } = await this.detectEventChanges();
			for (const id of upsertIds) this.scheduleUpsert(id);
			for (const id of removedIds) this.scheduleRemoval(id);

			await this.flush();
		} catch (e) {
			this.logger.error('Incremental sync sweep failed, falling back to a full reload:', e);
			await this.onFullReloadNeeded();
		}
	}

	/**
	 * Compares the notes in memory with what the vault really holds, and applies
	 * any difference. This catches what events can't: a change made while the plugin
	 * was off, or one whose graph write was lost when Joplin closed.
	 */
	public async reconcileWithVault(): Promise<void> {
		if (!this.analysisController.hasNotes()) return;

		const { versions, complete } = await this.noteRepository.getNoteVersions();
		if (!complete) {
			this.logger.info(
				'Could not list every note, so the graph was not checked against the vault.'
			);
			return;
		}

		const current = this.analysisController.getCurrentNotes();
		const updatedTimeById = new Map(current.map((note) => [note.id, note.updated_time]));
		for (const note of current) {
			if (!versions.has(note.id)) this.scheduleRemoval(note.id);
		}
		for (const [id, updatedTime] of versions) {
			if (updatedTimeById.get(id) !== updatedTime) this.scheduleUpsert(id);
		}

		await this.flush();
	}

	/** Looks for re-embedded notes between syncs, so people who never sync still get fresh semantic edges. */
	public async handleEmbeddingTick(): Promise<void> {
		if (!this.analysisController.hasNotes()) return;
		await this.sweepEmbeddings();
	}

	/** Never throws: a failed sweep only means semantic edges stay as they are until the next one. */
	private async sweepEmbeddings(): Promise<void> {
		if (this.embeddingsSweepInFlight) return;
		if (this.now() - this.lastEmbeddingsSweepAt < EMBEDDINGS_SWEEP_MIN_INTERVAL_MS) return;

		this.embeddingsSweepInFlight = true;
		try {
			if (!(await this.checkAiEnabled())) return;

			const { noteIds, modelChanged, isBaseline } = await this.changeDetector.detect();
			this.lastEmbeddingsSweepAt = this.now();

			if (modelChanged) {
				this.logger.info('Embedding model changed; reloading the graph.');
				await this.onFullReloadNeeded();
				return;
			}

			if (isBaseline) {
				this.analysisController.markMissingVectorsStale(noteIds);
			} else {
				this.analysisController.markVectorsStale(noteIds);
			}
			const graphData = await this.analysisController.refreshStaleVectors();
			if (graphData) {
				this.logger.info(`Embeddings refreshed for up to ${noteIds.length} note(s).`);
				this.publish(graphData);
			}
		} catch (e) {
			this.logger.error('Embeddings sweep failed; semantic edges stay as they are for now:', e);
		} finally {
			this.embeddingsSweepInFlight = false;
		}
	}

	private publish(graphData: GraphData): void {
		this.onGraphChanged(graphData);
		this.runEnrichmentFollowUp().catch((e) => {
			this.logger.error('LLM enrichment follow-up failed:', e);
		});
	}

	private async detectEventChanges(): Promise<{ upsertIds: string[]; removedIds: string[] }> {
		const cursor = await this.graphCache.loadEventsCursor();
		const { events, cursor: nextCursor } = await this.eventsRepository.getNoteEventsSince(
			cursor ?? undefined
		);

		const upsertIds: string[] = [];
		const removedIds: string[] = [];
		for (const event of events) {
			if (event.type === 'deleted') {
				removedIds.push(event.noteId);
			} else {
				upsertIds.push(event.noteId);
			}
		}

		if (nextCursor) {
			await this.graphCache.saveEventsCursor(nextCursor);
		}

		return { upsertIds, removedIds };
	}

	private scheduleUpsert(id: string): void {
		this.pendingRemovedIds.delete(id);
		this.pendingUpsertIds.add(id);
		this.scheduleFlush();
	}

	private scheduleRemoval(id: string): void {
		this.pendingUpsertIds.delete(id);
		this.pendingRemovedIds.add(id);
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, this.coalesceWindowMs);
	}

	private flush(): Promise<void> {
		const task = this.flushChain.then(() => this.flushInternal());
		this.flushChain = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}

	private async flushInternal(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}

		const upsertIds = Array.from(this.pendingUpsertIds);
		const removedIds = Array.from(this.pendingRemovedIds);
		this.pendingUpsertIds.clear();
		this.pendingRemovedIds.clear();

		if (upsertIds.length === 0 && removedIds.length === 0) return;
		if (!this.analysisController.hasNotes()) return;

		try {
			if (upsertIds.length > MAX_INCREMENTAL_UPSERTS) {
				this.logger.info(
					`${upsertIds.length} notes changed; reloading instead of updating each one.`
				);
				await this.onFullReloadNeeded();
				return;
			}

			const { upserts, discoveredRemovals } = await this.fetchAndEnrich(upsertIds);
			const graphData = await this.analysisController.applyDelta(upserts, [
				...removedIds,
				...discoveredRemovals,
			]);
			if (!graphData) return;

			const removedCount = removedIds.length + discoveredRemovals.length;
			this.logger.info(
				`Incremental update applied: ${upserts.length} upserted, ${removedCount} removed.`
			);
			this.publish(graphData);
		} catch (e) {
			this.logger.error('Incremental flush failed, falling back to a full reload:', e);
			try {
				await this.onFullReloadNeeded();
			} catch (fallbackError) {
				this.logger.error(
					'Full-reload fallback also failed after an incremental flush error:',
					fallbackError
				);
				for (const id of upsertIds) this.pendingUpsertIds.add(id);
				for (const id of removedIds) this.pendingRemovedIds.add(id);
			}
		}
	}

	/**
	 * Runs LLM enrichment (Pass B) against the graph just committed and publishes
	 * it again if it changed anything. Kept separate so the update reaches the
	 * panel immediately, before the much slower LLM pass runs.
	 */
	private async runEnrichmentFollowUp(): Promise<void> {
		const enriched = await this.analysisController.enrichCurrentGraph(this.onEnrichmentProgress);
		if (enriched) this.onGraphChanged(enriched);
	}

	private async fetchAndEnrich(
		ids: string[]
	): Promise<{ upserts: Note[]; discoveredRemovals: string[] }> {
		const upserts: Note[] = [];
		const discoveredRemovals: string[] = [];
		if (ids.length === 0) {
			return { upserts, discoveredRemovals };
		}

		for (const id of ids) {
			const raw = await this.noteRepository.getNote(id);
			if (!raw) {
				discoveredRemovals.push(id);
				continue;
			}
			upserts.push(await this.preprocessor.processOne(raw));
		}

		return { upserts, discoveredRemovals };
	}
}
