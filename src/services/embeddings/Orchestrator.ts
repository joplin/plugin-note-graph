import { Note } from '../../data/Types';
import { CachedVector, VectorCache, VectorCacheEntry } from '../../data/Database/VectorRepository';
import {
	EmbeddingProvider,
	EmbeddedNote,
	EmbeddingResult,
	BatchProgress,
} from './Types';

export class EmbeddingOrchestrator {
	private provider: EmbeddingProvider | null = null;
	private cache: VectorCache | null = null;
	private cancelled: boolean = false;
	private onProgress: ((progress: BatchProgress) => void) | null = null;

	public setProvider(provider: EmbeddingProvider): void {
		this.provider = provider;
		this.cancelled = false;
	}

	/** Injects a persistent vector cache so unchanged notes skip re-fetching. Optional. */
	public setCache(cache: VectorCache): void {
		this.cache = cache;
	}

	public setOnProgress(callback: (progress: BatchProgress) => void): void {
		this.onProgress = callback;
	}

	public cancel(): void {
		this.cancelled = true;
	}

	public async embedNotes(notes: Note[]): Promise<EmbeddingResult> {
		if (!notes || notes.length === 0) {
			return { embeddedNotes: [], errors: [] };
		}

		if (!this.provider) {
			const errors = notes.map(n => ({ noteId: n.id, error: 'No provider configured' }));
			return { embeddedNotes: [], errors };
		}

		try {
			this.reportProgress(0, notes.length);

			const vectorsByNoteId = await this.resolveVectors(notes, this.provider);

			const embeddedNotes: EmbeddedNote[] = [];
			const errors: Array<{ noteId: string; error: string }> = [];

			for (let i = 0; i < notes.length; i++) {
				if (this.cancelled) break;
				const note = notes[i];
				const vector = vectorsByNoteId.get(note.id);
				if (vector) {
					embeddedNotes.push({ note: note, embedding: vector });
				} else {
					errors.push({ noteId: note.id, error: 'Note not yet indexed by Joplin AI.' });
				}
				this.reportProgress(i + 1, notes.length);
			}

			return { embeddedNotes, errors };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const errors = notes.map(n => ({ noteId: n.id, error: msg }));
			return { embeddedNotes: [], errors };
		}
	}

	/**
	 * Resolves a vector per note, reusing cached vectors for notes whose
	 * `updated_time` and model haven't changed and only asking the provider
	 * to (re-)fetch the rest.
	 */
	private async resolveVectors(notes: Note[], provider: EmbeddingProvider): Promise<Map<string, number[]>> {
		const modelId = provider.modelName;
		const cached = await this.getCachedVectors(notes);

		const notesToFetch = notes.filter(n => !this.isFreshCacheHit(cached.get(n.id), n, modelId));

		const fresh = notesToFetch.length > 0
			? await provider.fetchVectorsByNoteIds(notesToFetch.map(n => n.id))
			: new Map<string, number[]>();

		await this.saveFreshVectors(notesToFetch, fresh, modelId);

		return this.mergeVectors(notes, cached, fresh, modelId);
	}

	/** Combines still-fresh cached vectors with newly fetched ones, keyed by note ID. */
	private mergeVectors(
		notes: Note[],
		cached: Map<string, CachedVector>,
		fresh: Map<string, number[]>,
		modelId: string,
	): Map<string, number[]> {
		const merged = new Map<string, number[]>();
		for (const note of notes) {
			const entry = cached.get(note.id);
			if (entry && this.isFreshCacheHit(entry, note, modelId)) {
				merged.set(note.id, entry.vector);
			}
		}
		for (const [noteId, vector] of fresh) merged.set(noteId, vector);
		return merged;
	}

	/** A cache entry is only reusable if the note is unchanged and the embedding model hasn't changed. */
	private isFreshCacheHit(entry: CachedVector | undefined, note: Note, modelId: string): boolean {
		return !!entry && entry.updatedTime === note.updated_time && entry.modelId === modelId;
	}

	private async getCachedVectors(notes: Note[]): Promise<Map<string, CachedVector>> {
		if (!this.cache) return new Map();
		try {
			return await this.cache.getMany(notes.map(n => n.id));
		} catch (e) {
			console.error('Vector cache read failed, falling back to a full fetch:', e);
			return new Map();
		}
	}

	private async saveFreshVectors(
		notes: Note[],
		vectors: Map<string, number[]>,
		modelId: string,
	): Promise<void> {
		if (!this.cache || vectors.size === 0) return;

		const entries: VectorCacheEntry[] = notes
			.filter(n => vectors.has(n.id))
			.map(n => ({
				noteId: n.id,
				vector: vectors.get(n.id)!,
				modelId,
				updatedTime: n.updated_time,
			}));

		try {
			await this.cache.saveMany(entries);
		} catch (e) {
			console.error('Vector cache write failed:', e);
		}
	}

	private reportProgress(current: number, total: number): void {
		if (this.onProgress) {
			this.onProgress({ current, total });
		}
	}
}
