import { Note } from '../../data/Types';

export type ProviderId = 'joplin-native';

export interface EmbeddingProvider {
	readonly id: ProviderId;
	readonly modelName: string;
	fetchVectorsByNoteIds(noteIds: string[], isCancelled?: () => boolean): Promise<Map<string, number[]>>;
	getCachedVectors?(): Map<string, number[]> | null;
	getFetchedModelId?(): string | null;
}

export interface ProviderConfig {
	id: ProviderId;
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
