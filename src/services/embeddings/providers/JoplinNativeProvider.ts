import joplin from 'api';
import { EmbeddingProvider, ProviderId } from '../Types';

/**
 * Mirrors Joplin's official AiIndexState type (joplinapp.org/api/references/plugin_api).
 * 'unavailable' | 'disabled' | 'preparing' block any fetch (no data yet).
 * 'indexing' still allows fetching — results are partial, handled downstream
 * as per-note "not yet indexed" errors. 'ready' is the fully-indexed state.
 */
export type AiIndexState = 'unavailable' | 'disabled' | 'preparing' | 'indexing' | 'ready';

export interface AiIndexStatus {
	modelId: string | null;
	notesIndexed: number;
	ready: boolean;
	state: AiIndexState;
	totalNotes: number;
}

export interface EmbeddingChunk {
	chunkIndex: number;
	chunkText: string;
	noteId: string;
	vector: number[];
}

export interface EmbeddingsPage {
	chunks: EmbeddingChunk[];
	dimension: number;
	modelId: string;
	nextCursor?: string;
}

export interface GetEmbeddingsOptions {
	cursor?: string;
	limit?: number;
	noteIds?: string[];
}

export interface JoplinAiApi {
	getIndexStatus: () => Promise<AiIndexStatus>;
	getEmbeddings: (options: GetEmbeddingsOptions) => Promise<EmbeddingsPage>;
}

const BLOCKING_STATES: ReadonlySet<AiIndexState> = new Set([
	'unavailable',
	'disabled',
	'preparing',
]);

/** True once the index has enough data to fetch from, even if still indexing. */
export function isIndexUsable(state: AiIndexState | undefined): boolean {
	return !!state && !BLOCKING_STATES.has(state);
}

export class JoplinNativeProvider implements EmbeddingProvider {
	public readonly id: ProviderId = 'joplin-native';
	public static readonly DEFAULT_MODEL_ID = 'joplin-native';
	private static readonly PAGE_SIZE = 1000;
	private static readonly MAX_PAGES = 500;
	private static readonly MAX_MODEL_CHANGE_RETRIES = 3;

	private _modelName: string;
	private cachedVectors: Map<string, number[]> | null = null;
	private fetchedModelId: string | null = null;

	public constructor(modelName: string = JoplinNativeProvider.DEFAULT_MODEL_ID) {
		this._modelName = modelName;
	}

	public get modelName(): string {
		return this._modelName;
	}

	public async fetchVectorsByNoteIds(noteIds: string[]): Promise<Map<string, number[]>> {
		if (noteIds.length === 0) {
			return new Map();
		}

		this.cachedVectors = null;
		this.fetchedModelId = null;

		const api = this.validateAiApi();
		const grouped = await this.fetchAllPages(api, noteIds);

		this.fetchedModelId = this._modelName;

		const result = this.poolAndNormalize(grouped);
		this.cachedVectors = result;
		return result;
	}

	public getCachedVectors(): Map<string, number[]> | null {
		return this.cachedVectors;
	}

	public getFetchedModelId(): string | null {
		return this.fetchedModelId;
	}

	/**
	 * Checks that joplin.ai exists. Deliberately does not probe individual
	 * method properties (e.g. `typeof api.getEmbeddings`) — Joplin's plugin
	 * RPC bridge exposes joplin.ai as a proxy that accumulates property-path
	 * state across accesses, so a property read that's never invoked can
	 * corrupt the path used by a later real call. Always access a method and
	 * invoke it in the same expression; let a genuinely missing method throw
	 * on invocation instead of pre-checking with typeof.
	 */
	private validateAiApi(): JoplinAiApi {
		const api = joplin.ai as unknown as JoplinAiApi | undefined;

		if (!api) {
			throw new Error('joplin.ai is not available. Enable AI in Settings → AI.');
		}

		return api;
	}

	/**
	 * Pages through getEmbeddings collecting vectors per note.
	 * Restarts pagination if the embedding model changes mid-fetch.
	 */
	private async fetchAllPages(
		api: JoplinAiApi,
		noteIds: string[]
	): Promise<Map<string, number[][]>> {
		let trackedModelId = await this.requireUsableIndex(api);

		const grouped = new Map<string, number[][]>();
		let cursor: string | undefined;
		let modelChangeRetries = 0;
		let pageCount = 0;

		while (true) {
			if (pageCount >= JoplinNativeProvider.MAX_PAGES) {
				throw new Error(
					'Too many pages. The embedding index may be in an unexpected state.'
				);
			}
			pageCount++;

			const page = await api.getEmbeddings({
				noteIds: noteIds,
				cursor: cursor,
				limit: JoplinNativeProvider.PAGE_SIZE,
			});

			const pageModelId = page.modelId ?? null;

			if (pageModelId) {
				if (!trackedModelId) {
					trackedModelId = pageModelId;
				} else if (pageModelId !== trackedModelId) {
					modelChangeRetries++;
					if (modelChangeRetries > JoplinNativeProvider.MAX_MODEL_CHANGE_RETRIES) {
						throw new Error('Model changed too many times during pagination.');
					}
					trackedModelId = pageModelId;
					grouped.clear();
					cursor = undefined;
					continue;
				}
			}

			this.addChunksToGroup(grouped, page.chunks);

			cursor = page.nextCursor;
			if (!cursor) {
				break;
			}
		}

		this._modelName = trackedModelId ?? JoplinNativeProvider.DEFAULT_MODEL_ID;
		return grouped;
	}

	/** Throws if the index isn't usable yet; otherwise returns the model ID it's currently indexed with. */
	private async requireUsableIndex(api: JoplinAiApi): Promise<string | null> {
		const status = await api.getIndexStatus();
		if (!status || !isIndexUsable(status.state)) {
			throw new Error(
				`Joplin AI index is not usable yet (state: ${status?.state ?? 'unknown'}). ` +
					'Enable AI and wait for the embedding model to finish loading in Settings → AI.'
			);
		}
		return status.modelId ?? null;
	}

	/** Appends each chunk's vector onto its note's running vector list. */
	private addChunksToGroup(grouped: Map<string, number[][]>, chunks: EmbeddingChunk[]): void {
		for (const chunk of chunks) {
			const list = grouped.get(chunk.noteId);
			if (list) {
				list.push(chunk.vector);
			} else {
				grouped.set(chunk.noteId, [chunk.vector]);
			}
		}
	}

	/** Averages multiple chunk vectors per note into one vector and L2-normalizes. */
	private poolAndNormalize(grouped: Map<string, number[][]>): Map<string, number[]> {
		const result = new Map<string, number[]>();

		for (const [noteId, vectors] of grouped) {
			if (vectors.length === 0) continue;

			const dim = vectors[0].length;
			const pooled = new Array(dim).fill(0);
			for (const vec of vectors) {
				for (let i = 0; i < dim; i++) {
					pooled[i] += vec[i];
				}
			}
			for (let i = 0; i < dim; i++) {
				pooled[i] /= vectors.length;
			}

			let norm = 0;
			for (let i = 0; i < dim; i++) {
				norm += pooled[i] * pooled[i];
			}
			norm = Math.sqrt(norm);
			if (norm > 0) {
				for (let i = 0; i < dim; i++) {
					pooled[i] /= norm;
				}
			}

			result.set(noteId, pooled);
		}

		return result;
	}
}
