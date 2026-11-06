import { Note } from '../../data/Types';

export type ProviderId = 'joplin-native';

export interface EmbeddingProvider {
	readonly id: ProviderId;
	readonly modelName: string;
	fetchVectorsByNoteIds(
		noteIds: string[],
		isCancelled?: () => boolean,
		onProgress?: (done: number, total: number) => void
	): Promise<Map<string, number[]>>;
}

export interface EmbeddedNote {
	note: Note;
	embedding: number[];
}

export interface BatchProgress {
	current: number;
	total: number;
}

export interface EmbeddingResult {
	embeddedNotes: EmbeddedNote[];
	errors: Array<{ noteId: string; error: string }>;
}
