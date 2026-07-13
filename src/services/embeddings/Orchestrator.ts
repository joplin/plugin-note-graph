import { Note } from '../../data/Types';
import {
	EmbeddingProvider,
	EmbeddedNote,
	EmbeddingResult,
	BatchProgress,
} from './Types';

export class EmbeddingOrchestrator {
	private provider: EmbeddingProvider | null = null;
	private cancelled: boolean = false;
	private onProgress: ((progress: BatchProgress) => void) | null = null;

	public setProvider(provider: EmbeddingProvider): void {
		this.provider = provider;
		this.cancelled = false;
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

			const noteIds = notes.map(n => n.id);
			const vectorsByNoteId = await this.provider.fetchVectorsByNoteIds(noteIds);

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

	private reportProgress(current: number, total: number): void {
		if (this.onProgress) {
			this.onProgress({ current, total });
		}
	}
}
