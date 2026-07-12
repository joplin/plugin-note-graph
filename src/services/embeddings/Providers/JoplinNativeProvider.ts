import joplin from 'api';
import { EmbeddingProvider, ProviderId } from '../Types';

export interface JoplinAiApi {
	getIndexStatus: () => Promise<{ ready: boolean; modelId?: string | null }>;
	getEmbeddings: (params: {
		noteIds?: string[];
		cursor?: string;
		limit: number;
	}) => Promise<{
		modelId?: string | null;
		dimension: number;
		chunks: Array<{ noteId: string; vector: number[] }>;
		nextCursor?: string;
	}>;
}

export class JoplinNativeProvider implements EmbeddingProvider {
	public readonly id: ProviderId = 'joplin-native';

	private _modelName: string;
	private _dimension: number;
	private cachedVectors: Map<string, number[]> | null = null;
	private fetchedModelId: string | null = null;

	public constructor(modelName: string = 'joplin-native', dimension: number = 0) {
		this._modelName = modelName;
		this._dimension = dimension;
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

	/** Checks that joplin.ai exists and has the required methods. */
	private validateAiApi(): JoplinAiApi {
		const api = joplin.ai as unknown as JoplinAiApi | undefined;

		if (!api || typeof api.getEmbeddings !== 'function') {
			throw new Error('joplin.ai.getEmbeddings is not available. Enable AI in Settings → AI.');
		}
		if (typeof api.getIndexStatus !== 'function') {
			throw new Error('joplin.ai.getIndexStatus is not available. Enable AI in Settings → AI.');
		}

		return api;
	}

	/**
	 * Pages through getEmbeddings collecting vectors per note.
	 * Restarts pagination if the embedding model changes mid-fetch.
	 */
	private async fetchAllPages(
		api: JoplinAiApi,
		noteIds: string[],
	): Promise<Map<string, number[][]>> {
		const status = await api.getIndexStatus();
		if (!status || !status.ready) {
			throw new Error('Joplin AI index is not ready. Wait for indexing to complete or enable AI in Settings → AI.');
		}

		let trackedModelId: string | null = status.modelId ?? null;

		const grouped = new Map<string, number[][]>();
		let cursor: string | undefined;
		let modelChangeRetries = 0;
		const MAX_MODEL_CHANGE_RETRIES = 3;

		while (true) {
			const page = await api.getEmbeddings({
				noteIds: noteIds,
				cursor: cursor,
				limit: 1000,
			});

			const pageModelId = page.modelId ?? null;

			if (pageModelId) {
				if (!trackedModelId) {
					trackedModelId = pageModelId;
				} else if (pageModelId !== trackedModelId) {
					modelChangeRetries++;
					if (modelChangeRetries > MAX_MODEL_CHANGE_RETRIES) {
						throw new Error('Model changed too many times during pagination.');
					}
					trackedModelId = pageModelId;
					grouped.clear();
					cursor = undefined;
					continue;
				}
			}

			if (this._dimension === 0 && page.dimension > 0) {
				this._dimension = page.dimension;
			}

			for (const chunk of page.chunks) {
				const list = grouped.get(chunk.noteId);
				if (list) {
					list.push(chunk.vector);
				} else {
					grouped.set(chunk.noteId, [chunk.vector]);
				}
			}

			cursor = page.nextCursor;
			if (!cursor) {
				break;
			}
		}

		this._modelName = trackedModelId ?? 'joplin-native';
		return grouped;
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
