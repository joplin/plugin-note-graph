import joplin from 'api';
import { ChatMessage, ChatOptions } from 'api/types';
import { NoteBatchItem, RelationshipBatchItem, buildBatchPrompt } from './PromptBuilder';
import { NodeEnrichment, EdgeEnrichment, ParsedEnrichment, parseEnrichmentResponse, pairKey } from './ResponseParser';

const EDGES_PER_BATCH = 4;
const MAX_ATTEMPTS_PER_BATCH = 4;
const RETRY_DELAY_MS = 1000;
const MAX_EXISTING_CATEGORIES = 40;
const LOG_EXCERPT_LENGTH = 600;

interface ChatApi {
	chat: (messages: ChatMessage[], options?: ChatOptions) => Promise<unknown>;
}

export interface EnrichmentNodeInput {
	title: string;
	body: string;
	updatedTime: number;
}

export interface EnrichmentEdgeInput {
	id: string;
	source: string;
	target: string;
	updatedTime: number;
}

export interface EnrichmentInput {
	nodes: Map<string, EnrichmentNodeInput>;
	edges: EnrichmentEdgeInput[];
}

export interface EnrichmentResult {
	nodeEnrichments: Map<string, NodeEnrichment>;
	edgeEnrichments: Map<string, EdgeEnrichment>;
}

export interface EnrichmentProgress {
	current: number;
	total: number;
}

interface CachedEnrichment<T> {
	enrichment: T;
	updatedTime: number;
}

interface BatchPrompt {
	notes: NoteBatchItem[];
	relationships: RelationshipBatchItem[];
}

interface BatchIndex {
	edgeIdByPair: Map<string, string>;
	nodeUpdatedTimeById: Map<string, number>;
	edgeUpdatedTimeById: Map<string, number>;
}

interface Batch {
	prompt: BatchPrompt;
	index: BatchIndex;
}

export interface LLMEnricherConfig {
	edgesPerBatch?: number;
	maxAttemptsPerBatch?: number;
}

export interface CacheSeed<T> {
	id: string;
	updatedTime: number;
	enrichment: T;
}

export class LLMEnricher {
	private readonly nodeCache = new Map<string, CachedEnrichment<NodeEnrichment>>();
	private readonly edgeCache = new Map<string, CachedEnrichment<EdgeEnrichment>>();
	private readonly edgesPerBatch: number;
	private readonly maxAttemptsPerBatch: number;

	public constructor(config: LLMEnricherConfig = {}) {
		this.edgesPerBatch = config.edgesPerBatch ?? EDGES_PER_BATCH;
		this.maxAttemptsPerBatch = config.maxAttemptsPerBatch ?? MAX_ATTEMPTS_PER_BATCH;
	}

	public clearCache(): void {
		this.nodeCache.clear();
		this.edgeCache.clear();
	}

	public seedCache(nodeSeeds: CacheSeed<NodeEnrichment>[], edgeSeeds: CacheSeed<EdgeEnrichment>[]): void {
		for (const seed of nodeSeeds) {
			if (!this.nodeCache.has(seed.id)) {
				this.nodeCache.set(seed.id, { enrichment: seed.enrichment, updatedTime: seed.updatedTime });
			}
		}
		for (const seed of edgeSeeds) {
			if (!this.edgeCache.has(seed.id)) {
				this.edgeCache.set(seed.id, { enrichment: seed.enrichment, updatedTime: seed.updatedTime });
			}
		}
	}

	public async enrich(
		input: EnrichmentInput,
		isStale: () => boolean,
		onProgress?: (progress: EnrichmentProgress) => void
	): Promise<EnrichmentResult> {
		let nodeEnrichments = new Map<string, NodeEnrichment>();
		let edgeEnrichments = new Map<string, EdgeEnrichment>();
		const nodesWrittenThisRun = new Set<string>();

		try {
			nodeEnrichments = this.seedCachedNodes(input.nodes);
			const { hits, misses: edgeMisses } = this.partitionEdges(input.edges);
			edgeEnrichments = hits;

			if (edgeMisses.length === 0) {
				console.info(`LLM enrichment: nothing to do, all ${input.edges.length} semantic edge(s) already cached.`);
				return { nodeEnrichments, edgeEnrichments };
			}

			let api: ChatApi;
			try {
				api = this.validateAiApi();
			} catch (e) {
				console.info('LLM enrichment skipped: joplin.ai is not available.', e);
				return { nodeEnrichments, edgeEnrichments };
			}

			const chunks = this.chunk(edgeMisses, this.edgesPerBatch).map((edgeChunk) => this.buildBatch(edgeChunk, input.nodes));
			console.info(`LLM enrichment: starting, ${edgeMisses.length} edge(s) across ${chunks.length} batch(es).`);
			onProgress?.({ current: 0, total: chunks.length });

			const usedCategories = this.collectCategories();
			let superseded = false;

			for (let i = 0; i < chunks.length; i++) {
				if (isStale()) {
					superseded = true;
					break;
				}

				const outcome = await this.runBatch(api, chunks[i], i, chunks.length, this.capCategories(usedCategories), isStale);
				this.mergeNodeResults(outcome.nodes, chunks[i].index.nodeUpdatedTimeById, nodeEnrichments, nodesWrittenThisRun);
				this.mergeEdgeResults(outcome.edges, chunks[i].index.edgeUpdatedTimeById, edgeEnrichments);
				for (const enrichment of outcome.nodes.values()) {
					if (enrichment.category !== undefined) usedCategories.add(enrichment.category);
				}
				onProgress?.({ current: i + 1, total: chunks.length });
			}

			console.info(
				superseded
					? `LLM enrichment: run superseded; stopping with ${nodeEnrichments.size} note(s) categorized, ${edgeEnrichments.size} edge(s) labeled so far.`
					: `LLM enrichment: done, ${nodeEnrichments.size} note(s) categorized, ${edgeEnrichments.size} edge(s) labeled.`
			);
		} catch (e) {
			console.error('LLM enrichment: unexpected failure; falling back to Pass A data for the rest of this run.', e);
		}

		return { nodeEnrichments, edgeEnrichments };
	}

	private collectCategories(): Set<string> {
		const categories = new Set<string>();
		for (const cached of this.nodeCache.values()) {
			if (cached.enrichment.category !== undefined) categories.add(cached.enrichment.category);
		}
		return categories;
	}

	private capCategories(categories: Set<string>): string[] {
		return Array.from(categories).slice(-MAX_EXISTING_CATEGORIES);
	}

	private validateAiApi(): ChatApi {
		const api = joplin.ai as unknown as ChatApi | undefined;
		if (!api) {
			throw new Error('joplin.ai is not available. Enable AI in Settings → AI.');
		}
		return api;
	}

	private seedCachedNodes(nodes: Map<string, EnrichmentNodeInput>): Map<string, NodeEnrichment> {
		const result = new Map<string, NodeEnrichment>();
		for (const [id, node] of nodes) {
			const cached = this.nodeCache.get(id);
			if (cached && cached.updatedTime === node.updatedTime) {
				result.set(id, cached.enrichment);
			}
		}
		return result;
	}

	private partitionEdges(
		edges: EnrichmentEdgeInput[]
	): { hits: Map<string, EdgeEnrichment>; misses: EnrichmentEdgeInput[] } {
		const hits = new Map<string, EdgeEnrichment>();
		const misses: EnrichmentEdgeInput[] = [];
		for (const edge of edges) {
			const cached = this.edgeCache.get(edge.id);
			if (cached && cached.updatedTime === edge.updatedTime) {
				hits.set(edge.id, cached.enrichment);
			} else {
				misses.push(edge);
			}
		}
		return { hits, misses };
	}

	private buildBatch(edgeChunk: EnrichmentEdgeInput[], nodes: Map<string, EnrichmentNodeInput>): Batch {
		const noteIds = new Set<string>();
		for (const edge of edgeChunk) {
			noteIds.add(edge.source);
			noteIds.add(edge.target);
		}

		const notes: NoteBatchItem[] = [];
		const nodeUpdatedTimeById = new Map<string, number>();
		for (const id of noteIds) {
			const node = nodes.get(id);
			if (!node) continue;
			notes.push({ id, title: node.title, body: node.body });
			nodeUpdatedTimeById.set(id, node.updatedTime);
		}
		const knownNoteIds = new Set(notes.map((n) => n.id));

		const relationships: RelationshipBatchItem[] = [];
		const edgeIdByPair = new Map<string, string>();
		const edgeUpdatedTimeById = new Map<string, number>();
		for (const edge of edgeChunk) {
			if (!knownNoteIds.has(edge.source) || !knownNoteIds.has(edge.target)) {
				console.error('LLM enrichment: edge references a note missing from this batch; skipping it.', edge.id);
				continue;
			}

			const key = pairKey(edge.source, edge.target);
			const existingEdgeId = edgeIdByPair.get(key);
			if (existingEdgeId) {
				console.error(
					`LLM enrichment: edges ${existingEdgeId} and ${edge.id} share the note pair ${key}; only ${existingEdgeId} can be matched to a relationship label.`
				);
			} else {
				edgeIdByPair.set(key, edge.id);
				relationships.push({ from: edge.source, to: edge.target });
			}
			edgeUpdatedTimeById.set(edge.id, edge.updatedTime);
		}

		return {
			prompt: { notes, relationships },
			index: { edgeIdByPair, nodeUpdatedTimeById, edgeUpdatedTimeById },
		};
	}

	private async runBatch(
		api: ChatApi,
		batch: Batch,
		batchIndex: number,
		totalBatches: number,
		existingCategories: string[],
		isStale: () => boolean
	): Promise<ParsedEnrichment> {
		const knownNodeIds = new Set(batch.prompt.notes.map((n) => n.id));
		const batchDescription = `batch ${batchIndex + 1}/${totalBatches} (${batch.prompt.notes.length} notes, ${batch.prompt.relationships.length} relationships)`;
		const empty: ParsedEnrichment = { nodes: new Map(), edges: new Map() };
		const messages = buildBatchPrompt(batch.prompt.notes, batch.prompt.relationships, existingCategories);

		for (let attempt = 1; attempt <= this.maxAttemptsPerBatch; attempt++) {
			const willRetry = attempt < this.maxAttemptsPerBatch;

			if (attempt > 1) {
				if (isStale()) {
					return empty;
				}
				await this.delay(RETRY_DELAY_MS);
				if (isStale()) {
					return empty;
				}
			}

			let response: unknown;
			try {
				response = await api.chat(messages);
			} catch (e) {
				console.error(
					`LLM enrichment: chat() call failed on attempt ${attempt}/${this.maxAttemptsPerBatch} for ${batchDescription}${willRetry ? '; retrying.' : '; giving up for this run.'}`,
					e
				);
				continue;
			}

			const raw = this.extractResponseText(response);
			if (raw === null || raw.trim().length === 0) {
				console.error(
					`LLM enrichment: ${batchDescription} got no usable text back on attempt ${attempt}/${this.maxAttemptsPerBatch} (${
						raw === null ? `unrecognized response shape: ${this.describeUnexpectedResponse(response)}` : 'empty response'
					})${willRetry ? '; retrying.' : '; giving up for this run.'}`
				);
				continue;
			}

			const parsed = parseEnrichmentResponse(raw, knownNodeIds, batch.index.edgeIdByPair);
			if (!parsed) {
				console.error(
					`LLM enrichment: ${batchDescription} failed schema validation on attempt ${attempt}/${this.maxAttemptsPerBatch}${willRetry ? '; retrying.' : '; giving up for this run.'} ${this.diagnoseMalformedResponse(raw)}`
				);
				continue;
			}

			const missing = batch.prompt.relationships.length - parsed.edges.size;
			if (missing > 0) {
				console.info(
					`LLM enrichment: ${batchDescription} only labeled ${parsed.edges.size}/${batch.prompt.relationships.length} relationships; accepting the partial result.`
				);
			}
			return parsed;
		}

		return empty;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private mergeNodeResults(
		parsed: Map<string, NodeEnrichment>,
		updatedTimeById: Map<string, number>,
		into: Map<string, NodeEnrichment>,
		writtenThisRun: Set<string>
	): void {
		for (const [id, enrichment] of parsed) {
			if (writtenThisRun.has(id)) continue;

			const updatedTime = updatedTimeById.get(id);
			if (updatedTime === undefined) {
				console.error('LLM enrichment: parsed note id has no matching batch entry; skipping cache write.', id);
				continue;
			}
			if (enrichment.category !== undefined) {
				this.nodeCache.set(id, { enrichment: { category: enrichment.category }, updatedTime });
			}
			into.set(id, enrichment);
			writtenThisRun.add(id);
		}
	}

	private mergeEdgeResults(
		parsed: Map<string, EdgeEnrichment>,
		updatedTimeById: Map<string, number>,
		into: Map<string, EdgeEnrichment>
	): void {
		for (const [id, enrichment] of parsed) {
			const updatedTime = updatedTimeById.get(id);
			if (updatedTime === undefined) {
				console.error('LLM enrichment: parsed edge id has no matching batch entry; skipping cache write.', id);
				continue;
			}
			this.edgeCache.set(id, { enrichment, updatedTime });
			into.set(id, enrichment);
		}
	}

	private chunk<T>(items: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < items.length; i += size) {
			chunks.push(items.slice(i, i + size));
		}
		return chunks;
	}

	private extractResponseText(response: unknown): string | null {
		if (typeof response === 'string') return response;
		if (
			response !== null &&
			typeof response === 'object' &&
			typeof (response as { text?: unknown }).text === 'string'
		) {
			return (response as { text: string }).text;
		}
		return null;
	}

	private describeUnexpectedResponse(value: unknown): string {
		if (value === null) return 'null';
		if (Array.isArray(value)) return `array(${value.length})`;
		if (typeof value !== 'object') return String(value);
		try {
			return JSON.stringify(value).slice(0, LOG_EXCERPT_LENGTH);
		} catch {
			return `object with keys: ${Object.keys(value).join(', ')}`;
		}
	}

	private diagnoseMalformedResponse(raw: string): string {
		try {
			JSON.parse(raw);
			return `Response is valid JSON (${raw.length} chars) but failed schema validation. Started with: ${raw.slice(0, LOG_EXCERPT_LENGTH)}`;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return `Response is not valid JSON (${raw.length} chars): ${message}. Ended with: ${raw.slice(-LOG_EXCERPT_LENGTH)}`;
		}
	}
}
