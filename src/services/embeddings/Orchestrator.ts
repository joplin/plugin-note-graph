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

	/**
	 * Embeds the provided notes, preserving note order and reporting missing
	 * embeddings as per-note errors.
	 */
	public async embedNotes(notes: Note[]): Promise<EmbeddingResult> {
		const embeddedNotes: EmbeddedNote[] = [];
		const errors: Array<{ noteId: string; error: string }> = [];

		if (!notes || notes.length === 0) {
			return { embeddedNotes, errors };
		}

		if (!this.provider) {
			return { embeddedNotes, errors: notes.map(function (n) { return { noteId: n.id, error: 'No provider configured' }; }) };
		}

		try {
			this.reportProgress(0, notes.length, 'embedding');

			const noteIds = notes.map(function (n) { return n.id; });
			const vectorsByNoteId = await this.provider.fetchVectorsByNoteIds(noteIds);

			for (let i = 0; i < notes.length; i++) {
				if (this.cancelled) break;
				const note = notes[i];
				const vector = vectorsByNoteId.get(note.id);
				if (vector) {
					embeddedNotes.push({ note: note, embedding: vector });
				} else {
					errors.push({ noteId: note.id, error: 'Note not yet indexed by Joplin AI. Wait for indexing to complete.' });
				}
				this.reportProgress(i + 1, notes.length, 'embedding');
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			for (let n = 0; n < notes.length; n++) {
				if (!embeddedNotes.some(function (en) { return en.note.id === notes[n].id; })) {
					errors.push({ noteId: notes[n].id, error: msg });
				}
			}
		}

		return { embeddedNotes, errors };
	}

	private reportProgress(current: number, total: number, phase: BatchProgress['phase']): void {
		if (this.onProgress) {
			this.onProgress({ current, total, phase });
		}
	}
}
