import joplin from 'api';
import { Note } from '../../data/Types';
import { NoteRepository } from '../../data/NoteRepository';
import { NotePreprocessor } from '../../data/NotePreprocessor';
import { EventsRepository } from '../../data/EventsRepository';
import { GraphCacheRepository } from '../../data/Database/GraphCacheRepository';
import { AnalysisController } from '../AnalysisController';
import { GraphDiff } from '../graph/GraphDiffer';
import { GraphData } from '../graph/types';
import { JoplinAiApi, isIndexUsable } from '../embeddings/providers/JoplinNativeProvider';
import { isAiAnalysisEnabled } from '../settings/GraphSettings';

const ITEM_CHANGE_DELETE = 3;

const EMBEDDINGS_PAGE_SIZE = 1000;
const EMBEDDINGS_MAX_PAGES = 500;
const DEFAULT_COALESCE_WINDOW_MS = 1000;
const MAX_CONSECUTIVE_RETRY_SKIPS = 5;

export class IncrementalUpdater {
	private readonly pendingUpsertIds = new Set<string>();
	private readonly pendingRemovedIds = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushChain: Promise<void> = Promise.resolve();
	private consecutiveRetrySkips = 0;

	public constructor(
		private readonly analysisController: AnalysisController,
		private readonly onGraphPatch: (diff: GraphDiff, fullGraphData: GraphData) => void,
		private readonly onFullReloadNeeded: () => Promise<void>,
		private readonly noteRepository = new NoteRepository(),
		private readonly preprocessor = new NotePreprocessor(),
		private readonly eventsRepository = new EventsRepository(),
		private readonly graphCache = new GraphCacheRepository(),
		private readonly coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS,
		private readonly checkAiEnabled: () => Promise<boolean> = isAiAnalysisEnabled
	) {}

	public handleNoteChange(event: { id: string; event: number }): void {
		if (event.event === ITEM_CHANGE_DELETE) {
			this.scheduleRemoval(event.id);
		} else {
			this.scheduleUpsert(event.id);
		}
	}

	public handleSelectionChange(event: { value: string[] }): void {
		for (const id of event.value) {
			this.scheduleUpsert(id);
		}
	}

	public async handleSyncComplete(): Promise<void> {
		if (!this.analysisController.hasNotes()) return;

		try {
			const aiEnabled = await this.checkAiEnabled();
			let embeddingsSweepFailed = false;

			if (aiEnabled) {
				try {
					const upsertIds = await this.detectEmbeddingUpserts();
					for (const id of upsertIds) this.scheduleUpsert(id);
				} catch (e) {
					console.error('Embeddings sweep failed, falling back to /events for this sync:', e);
					embeddingsSweepFailed = true;
				}
			}

			const { upsertIds, removedIds } = await this.detectEventChanges();
			if (!aiEnabled || embeddingsSweepFailed) {
				for (const id of upsertIds) this.scheduleUpsert(id);
			}
			for (const id of removedIds) this.scheduleRemoval(id);

			await this.flush();
		} catch (e) {
			console.error('Incremental sync sweep failed, falling back to a full reload:', e);
			await this.onFullReloadNeeded();
		}
	}

	private async detectEmbeddingUpserts(): Promise<string[]> {
		const cursor = await this.graphCache.loadEmbeddingsCursor();
		const api = this.getAiApi();
		await this.ensureIndexUsable(api);

		const noteIds = new Set<string>();
		let currentCursor = cursor ?? undefined;
		let pageCount = 0;

		while (pageCount < EMBEDDINGS_MAX_PAGES) {
			pageCount++;

			const page = await api.getEmbeddings({ cursor: currentCursor, limit: EMBEDDINGS_PAGE_SIZE });
			for (const chunk of page.chunks) {
				noteIds.add(chunk.noteId);
			}

			if (!page.nextCursor) break;
			currentCursor = page.nextCursor;
		}

		if (pageCount >= EMBEDDINGS_MAX_PAGES) {
			console.info(
				`Embeddings sweep hit the ${EMBEDDINGS_MAX_PAGES}-page safety cap; remaining changes will be picked up on the next sync.`
			);
		}

		if (currentCursor) {
			await this.graphCache.saveEmbeddingsCursor(currentCursor);
		}

		return Array.from(noteIds);
	}

	private getAiApi(): JoplinAiApi {
		const api = joplin.ai as unknown as JoplinAiApi | undefined;
		if (!api) {
			throw new Error('joplin.ai is not available. Enable AI in Settings → AI.');
		}
		return api;
	}

	private async ensureIndexUsable(api: JoplinAiApi): Promise<void> {
		const status = await api.getIndexStatus();
		if (!status || !isIndexUsable(status.state)) {
			throw new Error(
				`Joplin AI index is not usable yet (state: ${status?.state ?? 'unknown'}). ` +
					'Enable AI and wait for the embedding model to finish loading in Settings → AI.'
			);
		}
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
			const { upserts, discoveredRemovals } = await this.fetchAndEnrich(upsertIds);
			const graphData = await this.analysisController.applyDelta(upserts, [
				...removedIds,
				...discoveredRemovals,
			]);
			if (!graphData) {
				if (this.analysisController.wasLastDeltaSkippedForRetry()) {
					for (const id of upsertIds) this.pendingUpsertIds.add(id);
					for (const id of removedIds) this.pendingRemovedIds.add(id);
					this.consecutiveRetrySkips++;
					if (this.consecutiveRetrySkips < MAX_CONSECUTIVE_RETRY_SKIPS) {
						this.scheduleFlush();
					} else {
						console.info(
							`Giving up automatic retry after ${this.consecutiveRetrySkips} consecutive skipped updates; will retry on the next edit or sync.`
						);
					}
				} else {
					this.consecutiveRetrySkips = 0;
				}
				return;
			}

			this.consecutiveRetrySkips = 0;
			const removedCount = removedIds.length + discoveredRemovals.length;
			console.info(`Incremental update applied: ${upserts.length} upserted, ${removedCount} removed.`);

			const diff = this.analysisController.getLastDiff();
			if (diff) {
				this.onGraphPatch(diff, graphData);
			}
		} catch (e) {
			this.consecutiveRetrySkips = 0;
			console.error('Incremental flush failed, falling back to a full reload:', e);
			try {
				await this.onFullReloadNeeded();
			} catch (fallbackError) {
				console.error('Full-reload fallback also failed after an incremental flush error:', fallbackError);
				for (const id of upsertIds) this.pendingUpsertIds.add(id);
				for (const id of removedIds) this.pendingRemovedIds.add(id);
			}
		}
	}

	private async fetchAndEnrich(
		ids: string[]
	): Promise<{ upserts: Note[]; discoveredRemovals: string[] }> {
		const upserts: Note[] = [];
		const discoveredRemovals: string[] = [];

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
