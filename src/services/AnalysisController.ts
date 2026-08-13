import { Note } from '../data/Types';
import { GraphBuilder } from './graph/GraphBuilder';
import { GraphData, GraphNode, RenderedEdge } from './graph/types';
import { GraphDiffer, GraphDiff } from './graph/GraphDiffer';
import { clampSize } from './graph/CentralityScorer';
import { VectorRepository } from '../data/Database/VectorRepository';
import { GraphCacheRepository } from '../data/Database/GraphCacheRepository';
import { ProviderResolver } from './embeddings/ProviderResolver';
import { EmbeddingOrchestrator } from './embeddings/Orchestrator';
import { EmbeddedNote, EmbeddingProvider, BatchProgress } from './embeddings/Types';
import { LLMEnricher, EnrichmentNodeInput, EnrichmentEdgeInput, EnrichmentProgress, CacheSeed } from './llm/LLMEnricher';
import { NodeEnrichment, EdgeEnrichment } from './llm/ResponseParser';
import { isAiAnalysisEnabled, isLlmEnrichmentEnabled, getSimilaritySettings } from './settings/GraphSettings';

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
	private lastDiff: GraphDiff | null = null;
	private runToken = 0;
	private cancelledAtToken: number | null = null;
	private lastDeltaSkippedForRetry = false;
	private currentOrchestrator: EmbeddingOrchestrator | null = null;
	private enrichmentInFlight = false;

	public constructor(
		private readonly builder = new GraphBuilder(),
		private readonly graphCache: GraphCacheRepository = new GraphCacheRepository(),
		private readonly graphDiffer: GraphDiffer = new GraphDiffer(),
		private readonly enrichmentService: LLMEnricher = new LLMEnricher()
	) {}

	public getLastDiff(): GraphDiff | null {
		return this.lastDiff;
	}

	public getLastGraphData(): GraphData | null {
		return this.lastGraphData;
	}

	public wasLastDeltaSkippedForRetry(): boolean {
		return this.lastDeltaSkippedForRetry;
	}

	public hasNotes(): boolean {
		return this.lastNotes !== null;
	}

	public hasEmbeddedNotes(): boolean {
		return this.lastEmbeddedNotes !== null;
	}

	public cancelCurrentRun(): void {
		if (this.enrichmentInFlight) {
			console.info('LLM enrichment: cancelled by user.');
		} else if (this.currentOrchestrator) {
			console.info('AI analysis: cancelled by user.');
		}
		this.currentOrchestrator?.cancel();
		++this.runToken;
		this.cancelledAtToken = this.runToken;
	}

	public getCurrentNotes(): Note[] {
		return this.lastNotes ?? [];
	}

	public async loadFromCache(): Promise<GraphData | null> {
		try {
			const cached = await this.graphCache.loadGraph();
			if (!cached) return null;
			this.lastNotes = cached.notes;
			this.lastGraphData = cached.graphData;
			this.seedEnrichmentCache(cached.notes, cached.graphData);
			return cached.graphData;
		} catch (e) {
			console.error('Failed to load cached graph, starting fresh:', e);
			return null;
		}
	}

	private seedEnrichmentCache(notes: Note[], graphData: GraphData): void {
		const noteById = new Map(notes.map((note) => [note.id, note]));

		const nodeSeeds: CacheSeed<NodeEnrichment>[] = [];
		for (const node of graphData.nodes) {
			if (node.data.category === undefined) continue;
			const note = noteById.get(node.data.id);
			if (!note) continue;
			nodeSeeds.push({ id: node.data.id, updatedTime: note.updated_time, enrichment: { category: node.data.category } });
		}

		const edgeSeeds: CacheSeed<EdgeEnrichment>[] = [];
		for (const edge of graphData.edges) {
			if (edge.data.type !== 'semantic' || edge.data.relationshipLabel === undefined) continue;
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
		const guardedProgress = onProgress ? this.guardStaleProgress(token, onProgress) : undefined;
		return this.buildFrom(notes, token, {
			onProgress: guardedProgress,
			commitNotes: true,
		});
	}

	private async buildFrom(
		notes: Note[],
		token: number,
		options: {
			onProgress?: (progress: BatchProgress) => void;
			avoidSemanticDowngrade?: boolean;
			commitNotes?: boolean;
		}
	): Promise<SemanticBuildResult | null> {
		const hadSemanticGraph = this.hasSemanticEdges();
		const { embeddedNotes, reason, aiWasEnabled } = await this.tryEmbed(notes, options.onProgress);
		if (this.isStale(token, options.avoidSemanticDowngrade)) return null;

		if (!embeddedNotes) {
			if (options.avoidSemanticDowngrade && hadSemanticGraph && aiWasEnabled) {
				console.info(
					'Incremental update: AI re-embed failed; keeping the existing semantic graph instead of downgrading it.',
					reason
				);
				this.lastDeltaSkippedForRetry = true;
				return null;
			}
			const graphData = this.builder.build(notes);
			if (options.commitNotes) this.lastNotes = notes;
			this.lastEmbeddedNotes = null;
			this.commitGraphData(graphData);
			return { graphData, usedAi: false, fallbackReason: reason };
		}

		console.info(
			`AI analysis: ${embeddedNotes.length}/${notes.length} notes embedded, building semantic graph.`
		);
		const { threshold, topK } = await getSimilaritySettings();
		const graphData = await this.builder.buildWithSimilarity(
			notes,
			embeddedNotes,
			threshold,
			topK
		);

		if (this.isStale(token, options.avoidSemanticDowngrade)) return null;

		if (options.commitNotes) this.lastNotes = notes;
		this.lastEmbeddedNotes = embeddedNotes;
		this.commitGraphData(graphData);
		return { graphData, usedAi: true };
	}

	/**
	 * Rebuilds the graph from the last successful embedding using the current
	 * threshold/top-K settings. Like `embedAndBuildSemantic`, does not run
	 * LLM enrichment itself — call `enrichCurrentGraph()` afterward.
	 */
	public async recompute(): Promise<GraphData | null> {
		if (!this.lastNotes || !this.lastEmbeddedNotes) {
			return null;
		}
		const token = ++this.runToken;
		const { threshold, topK } = await getSimilaritySettings();
		console.info(
			`Recomputing graph: threshold=${threshold}, topK=${topK}, ${this.lastEmbeddedNotes.length} cached vectors.`
		);
		const graphData = await this.builder.buildWithSimilarity(
			this.lastNotes,
			this.lastEmbeddedNotes,
			threshold,
			topK
		);

		if (token !== this.runToken) return null;

		this.commitGraphData(graphData);
		return graphData;
	}

	public async enrichCurrentGraph(
		onProgress?: (progress: EnrichmentProgress) => void
	): Promise<GraphData | null> {
		if (!this.lastGraphData || !this.lastNotes) return null;
		if (this.enrichmentInFlight) return null;

		const token = this.runToken;
		if (token === this.cancelledAtToken) return null;
		const graphData = this.lastGraphData;
		const notes = this.lastNotes;
		const guardedProgress = onProgress ? this.guardStaleProgress(token, onProgress) : undefined;

		this.enrichmentInFlight = true;
		let enriched: GraphData;
		try {
			enriched = await this.applyEnrichment(graphData, notes, token, guardedProgress);
		} finally {
			this.enrichmentInFlight = false;
		}

		if (this.isStale(token) || enriched === graphData) {
			return null;
		}

		this.commitGraphData(enriched);
		return enriched;
	}

	public async applyDelta(upserts: Note[], removedIds: string[]): Promise<GraphData | null> {
		this.lastDeltaSkippedForRetry = false;
		if (!this.lastNotes) return null;

		const { merged, changed } = this.mergeNotes(this.lastNotes, upserts, removedIds);
		if (!changed) return null;

		const token = ++this.runToken;
		const result = await this.buildFrom(merged, token, {
			avoidSemanticDowngrade: true,
			commitNotes: true,
		});
		return result ? result.graphData : null;
	}

	private hasSemanticEdges(): boolean {
		return !!this.lastGraphData?.edges.some((e) => e.data.type === 'semantic');
	}

	private isStale(token: number, avoidSemanticDowngrade?: boolean): boolean {
		if (token === this.runToken) return false;
		if (avoidSemanticDowngrade) this.lastDeltaSkippedForRetry = true;
		return true;
	}

	private commitGraphData(graphData: GraphData): void {
		this.lastDiff = this.graphDiffer.computeDiff(this.lastGraphData, graphData);
		this.lastGraphData = graphData;
		this.persistCache();
	}

	private persistCache(): void {
		if (!this.lastNotes || !this.lastGraphData) return;
		this.graphCache.saveGraph(this.lastNotes, this.lastGraphData).catch((e) => {
			console.error('Failed to persist graph cache:', e);
		});
	}

	private mergeNotes(
		current: Note[],
		upserts: Note[],
		removedIds: string[]
	): { merged: Note[]; changed: boolean } {
		const byId = new Map(current.map((n) => [n.id, n]));
		let changed = false;

		for (const id of removedIds) {
			if (byId.delete(id)) changed = true;
		}
		for (const note of upserts) {
			const existing = byId.get(note.id);
			if (!existing || !this.notesEqual(existing, note)) {
				changed = true;
			}
			byId.set(note.id, note);
		}

		return { merged: changed ? Array.from(byId.values()) : current, changed };
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
	private guardStaleProgress<T>(token: number, onProgress: (progress: T) => void): (progress: T) => void {
		return (progress) => {
			if (token === this.runToken) {
				onProgress(progress);
			}
		};
	}

	private async applyEnrichment(
		graphData: GraphData,
		notes: Note[],
		token: number,
		onProgress?: (progress: EnrichmentProgress) => void
	): Promise<GraphData> {
		try {
			if (!(await isLlmEnrichmentEnabled())) return graphData;

			const noteById = new Map(notes.map((note) => [note.id, note]));
			const semanticEdges = graphData.edges.filter((edge) => edge.data.type === 'semantic');

			const nodeInputs = new Map<string, EnrichmentNodeInput>();
			const edgeInputs: EnrichmentEdgeInput[] = [];
			for (const edge of semanticEdges) {
				const source = noteById.get(edge.data.source);
				const target = noteById.get(edge.data.target);
				if (!source || !target) {
					const missing = [!source && 'source', !target && 'target'].filter(Boolean).join(' and ');
					console.error(`LLM enrichment: semantic edge is missing its ${missing} note; skipping it.`, edge.data);
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
				});
			}

			const enrichment = await this.enrichmentService.enrich(
				{ nodes: nodeInputs, edges: edgeInputs },
				() => token !== this.runToken,
				onProgress
			);
			if (enrichment.nodeEnrichments.size === 0 && enrichment.edgeEnrichments.size === 0) {
				return graphData;
			}

			return {
				nodes: graphData.nodes.map((node) =>
					this.applyNodeEnrichment(node, enrichment.nodeEnrichments.get(node.data.id))
				),
				edges: graphData.edges.map((edge) =>
					this.applyEdgeEnrichment(edge, enrichment.edgeEnrichments.get(edge.data.id))
				),
			};
		} catch (e) {
			console.error('LLM enrichment failed; rendering the graph without it.', e);
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
			console.error('AI analysis unavailable, falling back to structural graph:', e);
			return { embeddedNotes: null, reason, aiWasEnabled: true };
		}

		const orchestrator = new EmbeddingOrchestrator();
		orchestrator.setProvider(provider);
		orchestrator.setCache(new VectorRepository());
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
			console.error(
				'AI analysis produced no embeddings, falling back to structural graph:',
				errors
			);
			return { embeddedNotes: null, reason: errors[0]?.error, aiWasEnabled: true };
		}

		return { embeddedNotes, aiWasEnabled: true };
	}
}
