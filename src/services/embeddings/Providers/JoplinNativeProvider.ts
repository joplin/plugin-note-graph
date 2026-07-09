import joplin from 'api';
import { EmbeddingProvider, ProviderId } from '../Types';

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
		const joplinAi = joplin.ai as any;
		if (!joplinAi || typeof joplinAi.getEmbeddings !== 'function') {
			throw new Error('joplin.ai.getEmbeddings is not available. Enable AI in Settings → AI.');
		}
		if (typeof joplinAi.getIndexStatus !== 'function') {
			throw new Error('joplin.ai.getIndexStatus is not available. Enable AI in Settings → AI.');
		}

		const status = await joplinAi.getIndexStatus();
		if (!status || !status.ready) {
			throw new Error('Joplin AI index is not ready. Wait for indexing to complete or enable AI in Settings → AI.');
		}

		const statusModelId = status.modelId ?? null;
		this.fetchedModelId = statusModelId;
		this._modelName = statusModelId ?? 'joplin-native';

		const allChunks: { noteId: string; chunkIndex: number; chunkText: string; vector: number[] }[] = [];
		let cursor: string | undefined;
		let modelChangeRetries = 0;
		const MAX_MODEL_CHANGE_RETRIES = 3;

		do {
			const page = await joplinAi.getEmbeddings({
				noteIds: noteIds.length > 0 ? noteIds : undefined,
				cursor: cursor,
				limit: 1000,
			});

			if (this.fetchedModelId && page.modelId !== this.fetchedModelId) {
				modelChangeRetries++;
				if (modelChangeRetries > MAX_MODEL_CHANGE_RETRIES) {
					throw new Error('Model changed too many times during pagination.');
				}
				allChunks.length = 0;
				cursor = undefined;
				this.fetchedModelId = page.modelId ?? null;
				this._modelName = page.modelId ?? this._modelName;
				continue;
			}

			if (this._dimension === 0 && page.dimension > 0) {
				this._dimension = page.dimension;
			}

			allChunks.push(...page.chunks);
			cursor = page.nextCursor;
		} while (cursor);

		const grouped = new Map<string, number[][]>();
		for (const chunk of allChunks) {
			if (!grouped.has(chunk.noteId)) {
				grouped.set(chunk.noteId, []);
			}
			grouped.get(chunk.noteId)!.push(chunk.vector);
		}

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

		this.cachedVectors = result;
		return result;
	}

	public getCachedVectors(): Map<string, number[]> | null {
		return this.cachedVectors;
	}

	public getFetchedModelId(): string | null {
		return this.fetchedModelId;
	}
}
