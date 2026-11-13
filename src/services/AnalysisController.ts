import { Note } from '../data/Types';
import { GraphBuilder } from './graph/GraphBuilder';
import { GraphData, GraphNode, RenderedEdge } from './graph/types';
import { clampSize } from './graph/CentralityScorer';
import { CachedVector, VectorRepository } from '../data/Database/VectorRepository';
import { BODY_EXCERPT_LENGTH } from '../data/NotePreprocessor';
import { GraphCacheRepository, PersistedEnrichment } from '../data/Database/GraphCacheRepository';
import { ProviderResolver } from './embeddings/ProviderResolver';
import { EmbeddingOrchestrator } from './embeddings/Orchestrator';
import { EmbeddedNote, EmbeddingProvider, BatchProgress } from './embeddings/Types';
import { LLMEnricher, EnrichmentNodeInput, EnrichmentEdgeInput, EnrichmentProgress, EnrichmentResult, CacheSeed } from './llm/LLMEnricher';
import { NodeEnrichment, EdgeEnrichment } from './llm/ResponseParser';
import {
	isAiAnalysisEnabled,
	isLlmEnrichmentEnabled,
	getSimilaritySettings,
} from './settings/GraphSettings';
import { Logger, consoleLogger } from '../utils/Logger';

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };

/** Joplin saves a note being typed every few seconds, and the cache holds the whole vault, so text edits are written rarely. */
const TEXT_EDIT_CACHE_WRITE_DELAY_MS = 60_000;

export interface SemanticBuildResult {
	graphData: GraphData;
	usedAi: boolean;
	/** Set when `usedAi` is false because AI analysis was on but failed — the reason to surface to the user. Absent when AI analysis is simply off. */
	fallbackReason?: string;
}

/**
 * Coordinates turning notes into a GraphData, deciding between the plain
 * structural graph and the AI-enhanced one, and caching the last successful
 * embedding so threshold/top-K changes can recompute without re-embedding.
 */
export class AnalysisController {
	private lastNotes: Note[] | null = null;
	private lastEmbeddedNotes: EmbeddedNote[] | null = null;
	private lastGraphData: GraphData | null = null;
	private runToken = 0;
	private cancelledAtToken: number | null = null;
	/** Bumped whenever a change replaces the graph, so a Pass B run started before it knows it is out of date. */
	private graphVersion = 0;
	private semanticRunsInFlight = 0;
	/** Set by a cancel during embedding, so the sweep doesn't quietly finish what the user stopped. Cleared when the user starts embedding again. */
	private embeddingCancelled = false;
	private readonly staleVectorIds = new Set<string>();
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private persistDueAt = 0;
	private currentOrchestrator: EmbeddingOrchestrator | null = null;
	private enrichmentInFlight: Promise<GraphData | null> | null = null;
	private cachePersistenceEnabled = true;

	public constructor(
		private readonly builder = new GraphBuilder(),
		private readonly graphCache: GraphCacheRepository = new GraphCacheRepository(),
		private readonly enrichmentService: LLMEnricher = new LLMEnricher(),
		private readonly vectorStore: VectorRepository = new VectorRepository(),
		/** Waits this long and writes only the latest graph, so a burst of changes means one write. */
		private readonly cachePersistDelayMs: number = 0,
		private readonly logger: Logger = consoleLogger,
		/** The notes in the view the user is looking at, whose connections are explained first. */
		private readonly onScreenNoteIds: () => ReadonlySet<string> = () => new Set()
	) {}

	public getLastGraphData(): GraphData | null {
		return this.lastGraphData;
	}

	public hasNotes(): boolean {
		return this.lastNotes !== null;
	}

	public hasEmbeddedNotes(): boolean {
		return this.lastEmbeddedNotes !== null;
	}

	public cancelCurrentRun(): void {
		if (this.enrichmentInFlight) {
			this.logger.info('LLM enrichment: cancelled by user.');
		} else if (this.semanticRunsInFlight > 0) {
			this.logger.info('AI analysis: cancelled by user.');
			this.embeddingCancelled = true;
		}
		this.currentOrchestrator?.cancel();
		++this.runToken;
		this.cancelledAtToken = this.runToken;
	}

	public clearCancellation(): void {
		this.cancelledAtToken = null;
	}

	/** Lets Pass B label another batch of edges, after the user asks for it. */
	public allowMoreEnrichment(): void {
		this.enrichmentService.resetSessionBudget();
	}

	public getCurrentNotes(): Note[] {
		return this.lastNotes ?? [];
	}

	/** Disable while the loaded notes are incomplete, so a partial graph can't replace a good cached one. */
	public setCachePersistenceEnabled(enabled: boolean): void {
		this.cachePersistenceEnabled = enabled;
	}

	public async loadFromCache(): Promise<GraphData | null> {
		try {
			const cached = await this.graphCache.loadGraph();
			if (!cached) return null;
			this.lastNotes = this.trimOversizedBodies(cached.notes);
			this.builder.rememberCommunities(cached.graphData);
			this.lastGraphData = cached.graphData;
			this.seedEnrichmentCache(cached.notes, cached.graphData);
			return cached.graphData;
		} catch (e) {
			this.logger.error('Failed to load cached graph, starting fresh:', e);
			return null;
		}
	}

	public async seedEnrichmentFromStore(): Promise<void> {
		try {
			const records = await this.graphCache.loadEnrichments();
			const nodeSeeds: CacheSeed<NodeEnrichment>[] = [];
			const edgeSeeds: CacheSeed<EdgeEnrichment>[] = [];
			for (const record of records) {
				if (record.kind === 'node') {
					nodeSeeds.push({
						id: record.id,
						updatedTime: record.updatedTime,
						enrichment: record.enrichment as unknown as NodeEnrichment,
					});
				} else {
					edgeSeeds.push({
						id: record.id,
						updatedTime: record.updatedTime,
						enrichment: record.enrichment as unknown as EdgeEnrichment,
					});
				}
			}
			this.enrichmentService.seedCache(nodeSeeds, edgeSeeds);
		} catch (e) {
			this.logger.error('Failed to seed LLM enrichment cache from disk:', e);
		}
	}

	public async migrateCachedEnrichment(): Promise<void> {
		try {
			if (await this.graphCache.hasEnrichments()) return;
			const cached = await this.graphCache.loadGraph();
			if (!cached) return;
			const records = this.buildEnrichmentRecords(cached.notes, cached.graphData);
			if (records.length === 0) return;
			await this.graphCache.saveEnrichments(records);
		} catch (e) {
			this.logger.error('Failed to migrate cached LLM enrichment:', e);
		}
	}

	private seedEnrichmentCache(notes: Note[], graphData: GraphData): void {
		const noteById = new Map(notes.map((note) => [note.id, note]));

		const nodeSeeds: CacheSeed<NodeEnrichment>[] = [];
		for (const node of graphData.nodes) {
			if (node.data.category === undefined) continue;
			const note = noteById.get(node.data.id);
			if (!note) continue;
			nodeSeeds.push({
				id: node.data.id,
				updatedTime: note.updated_time,
				enrichment: { category: node.data.category },
			});
		}

		const edgeSeeds: CacheSeed<EdgeEnrichment>[] = [];
		for (const edge of graphData.edges) {
			if (edge.data.type !== 'semantic' || edge.data.relationshipLabel === undefined)
				continue;
			const source = noteById.get(edge.data.source);
			const target = noteById.get(edge.data.target);
			if (!source || !target) continue;
			edgeSeeds.push({
				id: edge.data.id,
				updatedTime: Math.max(source.updated_time, target.updated_time),
				enrichment: { relationshipLabel: edge.data.relationshipLabel },
			});
		}

		this.enrichmentService.seedCache(nodeSeeds, edgeSeeds);
	}

	public buildStructural(notes: Note[]): GraphData {
		++this.runToken;
		this.lastNotes = notes;
		this.lastEmbeddedNotes = null;
		const graphData = this.builder.build(notes);
		this.commitGraphData(graphData);
		return graphData;
	}

	/**
	 * `usedAi: false` covers two different situations the caller must treat the
	 * same way (render the structural graph) but may want to message
	 * differently: AI analysis is off, or it's on but unavailable/failed (see
	 * `fallbackReason`). Check `isAiAnalysisEnabled()` separately if that
	 * distinction matters.
	 *
	 * Returns `null` if a newer call to this method started before this one
	 * finished — its result is stale and superseded, so the caller should
	 * discard it rather than pushing it to the graph.
	 */
	public async embedAndBuildSemantic(
		notes: Note[],
		onProgress?: (progress: BatchProgress) => void
	): Promise<SemanticBuildResult | null> {
		const token = ++this.runToken;
		this.embeddingCancelled = false;
		const guardedProgress = onProgress ? this.guardStaleProgress(token, onProgress) : undefined;

		this.semanticRunsInFlight++;
		try {
			return await this.buildFrom(notes, token, guardedProgress);
		} finally {
			this.semanticRunsInFlight--;
		}
	}

	private async buildFrom(
		notes: Note[],
		token: number,
		onProgress?: (progress: BatchProgress) => void
	): Promise<SemanticBuildResult | null> {
		const hadSemanticGraph = this.hasSemanticEdges();
		const notesAtStart = this.lastNotes;
		const { embeddedNotes, reason, aiWasEnabled } = await this.tryEmbed(notes, onProgress);
		if (token !== this.runToken) return null;

		// Edits that landed during this long run are already in lastNotes, so build from those.
		const currentNotes = this.lastNotes && this.lastNotes !== notesAtStart ? this.lastNotes : notes;

		if (!embeddedNotes) {
			if (hadSemanticGraph && aiWasEnabled) {
				this.logger.info(
					'AI re-embed failed; keeping the existing semantic graph instead of downgrading it.',
					reason
				);
				return null;
			}
			const graphData = this.builder.build(currentNotes);
			this.lastNotes = currentNotes;
			this.lastEmbeddedNotes = null;
			this.commitGraphData(graphData);
			return { graphData, usedAi: false, fallbackReason: reason };
		}

		this.logger.info(
			`AI analysis: ${embeddedNotes.length}/${currentNotes.length} notes embedded, building semantic graph.`
		);
		const { threshold, topK } = await getSimilaritySettings();
		const enrichmentEnabled = await isLlmEnrichmentEnabled();
		const similarityGraph = await this.builder.buildWithSimilarity(
			currentNotes,
			embeddedNotes,
			threshold,
			topK,
			() => token !== this.runToken
		);

		if (token !== this.runToken) return null;

		const latestNotes = this.lastNotes && this.lastNotes !== notesAtStart ? this.lastNotes : notes;
		const graphData =
			latestNotes === currentNotes
				? similarityGraph
				: this.builder.rebuildStructure(latestNotes, similarityGraph);

		this.lastNotes = latestNotes;
		this.lastEmbeddedNotes = embeddedNotes;
		const committedGraph = enrichmentEnabled
			? this.replayCachedEnrichment(graphData, latestNotes)
			: graphData;
		this.commitGraphData(committedGraph);
		return { graphData: committedGraph, usedAi: true };
	}

	/**
	 * Rebuilds the graph from the last successful embedding using the current
	 * threshold/top-K settings. Like `embedAndBuildSemantic`, does not run
	 * LLM enrichment itself — call `enrichCurrentGraph()` afterward.
	 */
	public async recompute(): Promise<GraphData | null> {
		this.semanticRunsInFlight++;
		try {
			return await this.recomputeFromCurrentVectors();
		} finally {
			this.semanticRunsInFlight--;
		}
	}

	private async recomputeFromCurrentVectors(): Promise<GraphData | null> {
		if (!this.lastNotes || !this.lastEmbeddedNotes) {
			return null;
		}
		const token = ++this.runToken;
		const notesAtStart = this.lastNotes;
		const { threshold, topK } = await getSimilaritySettings();
		this.logger.info(
			`Recomputing graph: threshold=${threshold}, topK=${topK}, ${this.lastEmbeddedNotes.length} cached vectors.`
		);
		const enrichmentEnabled = await isLlmEnrichmentEnabled();
		const similarityGraph = await this.builder.buildWithSimilarity(
			notesAtStart,
			this.lastEmbeddedNotes,
			threshold,
			topK,
			() => token !== this.runToken
		);

		if (token !== this.runToken) return null;

		// An edit may have landed while similarity was being computed.
		const latestNotes = this.lastNotes;
		const graphData =
			latestNotes === notesAtStart
				? similarityGraph
				: this.builder.rebuildStructure(latestNotes, similarityGraph);

		const committedGraph = enrichmentEnabled
			? this.replayCachedEnrichment(graphData, latestNotes)
			: graphData;
		this.commitGraphData(committedGraph);
		return committedGraph;
	}

	public async enrichCurrentGraph(
		onProgress?: (progress: EnrichmentProgress) => void
	): Promise<GraphData | null> {
		if (!this.lastGraphData || !this.lastNotes) return null;

		const inFlight = this.enrichmentInFlight;
		if (inFlight) {
			await inFlight;
			return this.enrichCurrentGraph(onProgress);
		}

		const token = this.runToken;
		const graphVersion = this.graphVersion;
		const isOutOfDate = (): boolean =>
			token !== this.runToken || graphVersion !== this.graphVersion;
		if (token === this.cancelledAtToken) return null;
		const graphData = this.lastGraphData;
		const notes = this.lastNotes;
		const guardedProgress = onProgress ? this.guardStaleProgress(token, onProgress) : undefined;

		const task = (async (): Promise<GraphData | null> => {
			let enriched: GraphData;
			try {
				enriched = await this.applyEnrichment(graphData, notes, isOutOfDate, guardedProgress);
			} finally {
				this.enrichmentInFlight = null;
			}

			if (isOutOfDate() || enriched === graphData) {
				return null;
			}

			this.commitGraphData(enriched);
			return enriched;
		})();

		this.enrichmentInFlight = task;
		return task;
	}

	/**
	 * Applies changed and removed notes without touching embeddings: Joplin
	 * re-embeds an edit minutes later, so there is nothing new to fetch yet. An
	 * edit that only changes a note's text doesn't change the graph at all.
	 * @returns the new graph, or null if the graph didn't change.
	 */
	public async applyDelta(upserts: Note[], removedIds: string[]): Promise<GraphData | null> {
		if (!this.lastNotes) return null;

		const { merged, changed, structural } = this.mergeNotes(this.lastNotes, upserts, removedIds);
		if (!changed) return null;

		this.lastNotes = merged;
		this.forgetVectors(removedIds);
		if (!structural) {
			// Otherwise the cache keeps the old edit times, and every restart fetches these notes again.
			this.persistCache(TEXT_EDIT_CACHE_WRITE_DELAY_MS);
			return null;
		}

		this.graphVersion++;
		const rebuilt = this.builder.rebuildStructure(merged, this.lastGraphData ?? EMPTY_GRAPH);
		const committedGraph = (await isLlmEnrichmentEnabled())
			? this.replayCachedEnrichment(rebuilt, merged)
			: rebuilt;
		this.commitGraphData(committedGraph);
		return committedGraph;
	}

	/** Records notes whose vectors Joplin has replaced, to be picked up by `refreshStaleVectors`. */
	public markVectorsStale(noteIds: string[]): void {
		for (const id of noteIds) this.staleVectorIds.add(id);
	}

	/**
	 * For a sweep's first pass, which can't tell what changed. Marks in-scope notes with
	 * no vector, which Joplin may have embedded since the full load, and notes whose
	 * stored vector is older than the note, which may have been edited while the plugin
	 * wasn't watching.
	 */
	public async markOutdatedVectorsStale(noteIds: string[]): Promise<void> {
		if (!this.lastNotes) return;

		const embedded = new Set((this.lastEmbeddedNotes ?? []).map((en) => en.note.id));
		const noteById = new Map(this.lastNotes.map((note) => [note.id, note]));
		const inScope = noteIds.filter((id) => noteById.has(id));
		const stored = await this.readStoredVectors(inScope);
		for (const id of inScope) {
			const storedTime = stored.get(id)?.updatedTime;
			const outdated = storedTime !== undefined && storedTime < (noteById.get(id) as Note).updated_time;
			if (!embedded.has(id) || outdated) this.staleVectorIds.add(id);
		}
	}

	/**
	 * Fetches new vectors for the notes marked stale and rebuilds if any of them
	 * really changed. Notes stay marked if this can't finish, for the next attempt.
	 * @returns the new graph, or null if nothing changed.
	 */
	public async refreshStaleVectors(): Promise<GraphData | null> {
		if (!this.lastNotes || this.staleVectorIds.size === 0 || this.semanticRunsInFlight > 0) {
			return null;
		}
		if (this.embeddingCancelled) return null;
		if (!(await isAiAnalysisEnabled())) {
			this.staleVectorIds.clear();
			return null;
		}

		const noteIds = Array.from(this.staleVectorIds);
		const provider = await ProviderResolver.resolveWithValidation();
		const fresh = await provider.fetchVectorsByNoteIds(noteIds);
		// Read before saving the new vectors, or every change would look like no change.
		const restored = this.lastEmbeddedNotes
			? null
			: await this.restoreEmbeddedNotes(provider.modelName);
		await this.saveRefreshedVectors(noteIds, fresh, provider.modelName);

		// A run that started during the fetch may have read the old vectors, so the notes
		// stay marked for the next sweep, and that run isn't cancelled by rebuilding here.
		if (this.semanticRunsInFlight > 0) return null;
		for (const id of noteIds) this.staleVectorIds.delete(id);

		if (!this.lastEmbeddedNotes) this.lastEmbeddedNotes = restored;
		if (!this.lastEmbeddedNotes) {
			const result = await this.embedAndBuildSemantic(this.lastNotes);
			return result ? result.graphData : null;
		}
		return this.applyRefreshedVectors(fresh) ? this.recompute() : null;
	}

	/**
	 * A graph loaded from the cache has no vectors in memory. The stored ones are what
	 * its similar-note connections were built from, so a sweep can compare against them
	 * instead of embedding the whole vault again on every start.
	 * @returns null when nothing usable is stored.
	 */
	private async restoreEmbeddedNotes(modelId: string): Promise<EmbeddedNote[] | null> {
		const notes = this.lastNotes ?? [];
		const stored = await this.readStoredVectors(notes.map((note) => note.id));
		const restored: EmbeddedNote[] = [];
		for (const note of notes) {
			const entry = stored.get(note.id);
			if (entry && entry.modelId === modelId) restored.push({ note, embedding: entry.vector });
		}
		return restored.length > 0 ? restored : null;
	}

	/** Never throws: without stored vectors, callers fall back to fetching them. */
	private async readStoredVectors(noteIds: string[]): Promise<Map<string, CachedVector>> {
		if (noteIds.length === 0) return new Map();
		try {
			return await this.vectorStore.getMany(noteIds);
		} catch (e) {
			this.logger.error('Failed to read stored vectors:', e);
			return new Map();
		}
	}

	/** Removes stored data for notes gone from the vault. Only pass a complete, whole-vault list. */
	public pruneDeletedNotes(noteIdsToKeep: Set<string>): void {
		this.vectorStore.pruneExcept(noteIdsToKeep).catch((e) => {
			this.logger.error('Failed to prune the vector cache:', e);
		});
		this.graphCache.pruneEnrichments(noteIdsToKeep).catch((e) => {
			this.logger.error('Failed to prune the label cache:', e);
		});
	}

	private forgetVectors(noteIds: string[]): void {
		if (noteIds.length === 0) return;

		const removed = new Set(noteIds);
		if (this.lastEmbeddedNotes) {
			this.lastEmbeddedNotes = this.lastEmbeddedNotes.filter((en) => !removed.has(en.note.id));
		}
		for (const id of noteIds) this.staleVectorIds.delete(id);
		this.vectorStore.removeMany(noteIds).catch((e) => {
			this.logger.error('Failed to remove vectors for deleted notes:', e);
		});
	}

	private async saveRefreshedVectors(
		noteIds: string[],
		fresh: Map<string, number[]>,
		modelId: string
	): Promise<void> {
		const updatedTimeById = new Map((this.lastNotes ?? []).map((n) => [n.id, n.updated_time]));
		await this.vectorStore.saveMany(
			Array.from(fresh, ([noteId, vector]) => ({
				noteId,
				vector,
				modelId,
				updatedTime: updatedTimeById.get(noteId) ?? 0,
			}))
		);
		await this.vectorStore.removeMany(noteIds.filter((id) => !fresh.has(id)));
	}

	/** Returns whether any in-scope note ended up with a different vector. */
	private applyRefreshedVectors(fresh: Map<string, number[]>): boolean {
		const embeddedById = new Map((this.lastEmbeddedNotes ?? []).map((en) => [en.note.id, en]));
		let changed = false;

		for (const note of this.lastNotes ?? []) {
			const vector = fresh.get(note.id);
			if (!vector) continue;

			const existing = embeddedById.get(note.id);
			if (existing && this.sameVector(existing.embedding, vector)) continue;

			embeddedById.set(note.id, { note, embedding: vector });
			changed = true;
		}

		if (changed) this.lastEmbeddedNotes = Array.from(embeddedById.values());
		return changed;
	}

	private sameVector(a: number[], b: number[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (Math.fround(a[i]) !== Math.fround(b[i])) return false;
		}
		return true;
	}

	private trimOversizedBodies(notes: Note[]): Note[] {
		if (notes.every((note) => (note.body ?? '').length <= BODY_EXCERPT_LENGTH)) return notes;
		return notes.map((note) => ({ ...note, body: (note.body ?? '').slice(0, BODY_EXCERPT_LENGTH) }));
	}

	private hasSemanticEdges(): boolean {
		return !!this.lastGraphData?.edges.some((e) => e.data.type === 'semantic');
	}

	private commitGraphData(graphData: GraphData): void {
		this.lastGraphData = graphData;
		this.builder.rememberCommunities(graphData);
		this.persistCache();
	}

	private persistNewEnrichments(newEntries: {
		nodes: CacheSeed<NodeEnrichment>[];
		edges: CacheSeed<EdgeEnrichment>[];
	}): void {
		const records: PersistedEnrichment[] = [];
		for (const node of newEntries.nodes) {
			records.push({
				kind: 'node',
				id: node.id,
				updatedTime: node.updatedTime,
				enrichment: node.enrichment as unknown as Record<string, unknown>,
			});
		}
		for (const edge of newEntries.edges) {
			records.push({
				kind: 'edge',
				id: edge.id,
				updatedTime: edge.updatedTime,
				enrichment: edge.enrichment as unknown as Record<string, unknown>,
			});
		}
		if (records.length === 0) return;
		this.graphCache.saveEnrichments(records).catch((e) => {
			this.logger.error('Failed to persist LLM enrichment cache:', e);
		});
	}

	private buildEnrichmentRecords(notes: Note[], graphData: GraphData): PersistedEnrichment[] {
		const noteById = new Map(notes.map((note) => [note.id, note]));

		const records: PersistedEnrichment[] = [];
		for (const node of graphData.nodes) {
			if (node.data.category === undefined) continue;
			const note = noteById.get(node.data.id);
			if (!note) continue;
			records.push({
				kind: 'node',
				id: node.data.id,
				updatedTime: note.updated_time,
				enrichment: { category: node.data.category },
			});
		}
		for (const edge of graphData.edges) {
			if (edge.data.type !== 'semantic' || edge.data.relationshipLabel === undefined)
				continue;
			const source = noteById.get(edge.data.source);
			const target = noteById.get(edge.data.target);
			if (!source || !target) continue;
			records.push({
				kind: 'edge',
				id: edge.data.id,
				updatedTime: Math.max(source.updated_time, target.updated_time),
				enrichment: { relationshipLabel: edge.data.relationshipLabel },
			});
		}
		return records;
	}

	/** Writes the latest graph after `delayMs`, or sooner if a write is already due earlier. */
	private persistCache(delayMs: number = this.cachePersistDelayMs): void {
		if (delayMs === 0) {
			this.cancelPendingWrite();
			this.writeCache();
			return;
		}
		const dueAt = Date.now() + delayMs;
		if (this.persistTimer && this.persistDueAt <= dueAt) return;

		this.cancelPendingWrite();
		this.persistDueAt = dueAt;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.writeCache();
		}, delayMs);
	}

	private cancelPendingWrite(): void {
		if (!this.persistTimer) return;
		clearTimeout(this.persistTimer);
		this.persistTimer = null;
	}

	private writeCache(): void {
		if (!this.cachePersistenceEnabled || !this.lastNotes || !this.lastGraphData) return;
		this.graphCache.saveGraph(this.lastNotes, this.lastGraphData).catch((e) => {
			this.logger.error('Failed to persist graph cache:', e);
		});
	}

	private mergeNotes(
		current: Note[],
		upserts: Note[],
		removedIds: string[]
	): { merged: Note[]; changed: boolean; structural: boolean } {
		const byId = new Map(current.map((n) => [n.id, n]));
		let changed = false;
		let structural = false;

		for (const id of removedIds) {
			if (byId.delete(id)) {
				changed = true;
				structural = true;
			}
		}
		for (const note of upserts) {
			const existing = byId.get(note.id);
			if (!existing) {
				changed = true;
				structural = true;
			} else {
				const affectsGraph = this.affectsGraph(existing, note);
				if (affectsGraph) structural = true;
				if (affectsGraph || !this.notesEqual(existing, note)) changed = true;
			}
			byId.set(note.id, note);
		}

		return { merged: changed ? Array.from(byId.values()) : current, changed, structural };
	}

	/** Whether a change to this note can change a node or an edge, unlike an edit to its text. */
	private affectsGraph(a: Note, b: Note): boolean {
		return (
			a.title !== b.title ||
			a.parent_id !== b.parent_id ||
			!this.sameStringSet(a.tags, b.tags) ||
			!this.sameStringSet(a.links, b.links)
		);
	}

	private notesEqual(a: Note, b: Note): boolean {
		return (
			a.updated_time === b.updated_time &&
			this.sameStringSet(a.tags, b.tags) &&
			this.sameStringSet(a.links, b.links)
		);
	}

	private sameStringSet(a: string[] | undefined, b: string[] | undefined): boolean {
		const aValues = a ?? [];
		const bValues = b ?? [];
		if (aValues.length !== bValues.length) return false;
		const bSet = new Set(bValues);
		return aValues.every((value) => bSet.has(value));
	}

	/** Wraps a progress callback so it stops firing once a newer run supersedes `token` — otherwise a slow, superseded run could re-show the progress bar after a newer run already hid it by posting its finished graph. */
	private guardStaleProgress<T>(
		token: number,
		onProgress: (progress: T) => void
	): (progress: T) => void {
		return (progress) => {
			if (token === this.runToken) {
				onProgress(progress);
			}
		};
	}

	private async applyEnrichment(
		graphData: GraphData,
		notes: Note[],
		isOutOfDate: () => boolean,
		onProgress?: (progress: EnrichmentProgress) => void
	): Promise<GraphData> {
		try {
			if (!(await isLlmEnrichmentEnabled())) return graphData;

			const input = this.buildEnrichmentInput(graphData, notes);
			const enrichment = await this.enrichmentService.enrich(input, isOutOfDate, onProgress);
			this.persistNewEnrichments(this.enrichmentService.takeNewEnrichments());
			if (enrichment.nodeEnrichments.size === 0 && enrichment.edgeEnrichments.size === 0) {
				return graphData;
			}
			return this.applyEnrichmentResult(graphData, enrichment);
		} catch (e) {
			this.logger.error('LLM enrichment failed; rendering the graph without it.', e);
			return graphData;
		}
	}

	private buildEnrichmentInput(
		graphData: GraphData,
		notes: Note[]
	): { nodes: Map<string, EnrichmentNodeInput>; edges: EnrichmentEdgeInput[] } {
		const noteById = new Map(notes.map((note) => [note.id, note]));
		const semanticEdges = graphData.edges.filter((edge) => edge.data.type === 'semantic');
		const onScreen = this.onScreenNoteIds();

		const nodeInputs = new Map<string, EnrichmentNodeInput>();
		const edgeInputs: EnrichmentEdgeInput[] = [];
		for (const edge of semanticEdges) {
			const source = noteById.get(edge.data.source);
			const target = noteById.get(edge.data.target);
			if (!source || !target) {
				const missing = [!source && 'source', !target && 'target'].filter(Boolean).join(' and ');
				this.logger.error(`LLM enrichment: semantic edge is missing its ${missing} note; skipping it.`, edge.data);
				continue;
			}
			for (const note of [source, target]) {
				if (!nodeInputs.has(note.id)) {
					nodeInputs.set(note.id, {
						title: note.title,
						body: typeof note.body === 'string' ? note.body : '',
						updatedTime: note.updated_time,
					});
				}
			}
			edgeInputs.push({
				id: edge.data.id,
				source: edge.data.source,
				target: edge.data.target,
				updatedTime: Math.max(source.updated_time, target.updated_time),
				score: edge.data.score,
				onScreen: onScreen.has(source.id) && onScreen.has(target.id),
			});
		}
		return { nodes: nodeInputs, edges: edgeInputs };
	}

	private applyEnrichmentResult(graphData: GraphData, enrichment: EnrichmentResult): GraphData {
		return {
			nodes: graphData.nodes.map((node) =>
				this.applyNodeEnrichment(node, enrichment.nodeEnrichments.get(node.data.id))
			),
			edges: graphData.edges.map((edge) =>
				this.applyEdgeEnrichment(edge, enrichment.edgeEnrichments.get(edge.data.id))
			),
		};
	}

	private replayCachedEnrichment(graphData: GraphData, notes: Note[]): GraphData {
		try {
			const input = this.buildEnrichmentInput(graphData, notes);
			const enrichment = this.enrichmentService.replayCached(input);
			if (enrichment.nodeEnrichments.size === 0 && enrichment.edgeEnrichments.size === 0) {
				return graphData;
			}
			return this.applyEnrichmentResult(graphData, enrichment);
		} catch (e) {
			this.logger.error('LLM enrichment cache replay failed; keeping the graph without it.', e);
			return graphData;
		}
	}

	private applyNodeEnrichment(
		node: { data: GraphNode },
		enrichment: NodeEnrichment | undefined
	): { data: GraphNode } {
		if (!enrichment) return node;
		return {
			data: {
				...node.data,
				...(enrichment.category !== undefined ? { category: enrichment.category } : {}),
				size: clampSize(node.data.size + (enrichment.centralityAdjustment ?? 0)),
			},
		};
	}

	private applyEdgeEnrichment(
		edge: { data: RenderedEdge },
		enrichment: EdgeEnrichment | undefined
	): { data: RenderedEdge } {
		if (!enrichment) return edge;
		return { data: { ...edge.data, relationshipLabel: enrichment.relationshipLabel } };
	}

	/** Never throws — returns `embeddedNotes: null` on any failure (setting off, provider unavailable, nothing embedded), with `reason` set to a user-facing explanation where one is available, so the caller can always fall back to the structural graph. */
	private async tryEmbed(
		notes: Note[],
		onProgress?: (progress: BatchProgress) => void
	): Promise<{ embeddedNotes: EmbeddedNote[] | null; reason?: string; aiWasEnabled: boolean }> {
		if (!(await isAiAnalysisEnabled())) {
			return { embeddedNotes: null, aiWasEnabled: false };
		}

		let provider: EmbeddingProvider;
		try {
			provider = await ProviderResolver.resolveWithValidation();
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.logger.error('AI analysis unavailable, falling back to structural graph:', e);
			return { embeddedNotes: null, reason, aiWasEnabled: true };
		}

		const orchestrator = new EmbeddingOrchestrator(this.logger);
		orchestrator.setProvider(provider);
		orchestrator.setCache(this.vectorStore);
		if (onProgress) {
			orchestrator.setOnProgress(onProgress);
		}

		this.currentOrchestrator = orchestrator;
		let embeddedNotes: EmbeddedNote[];
		let errors: Array<{ noteId: string; error: string }>;
		try {
			({ embeddedNotes, errors } = await orchestrator.embedNotes(notes));
		} finally {
			this.currentOrchestrator = null;
		}

		if (embeddedNotes.length === 0) {
			this.logger.error(
				'AI analysis produced no embeddings, falling back to structural graph:',
				errors
			);
			return { embeddedNotes: null, reason: errors[0]?.error, aiWasEnabled: true };
		}

		return { embeddedNotes, aiWasEnabled: true };
	}
}
