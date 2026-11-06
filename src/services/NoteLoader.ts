import { Note } from '../data/Types';
import { NoteRepository } from '../data/NoteRepository';
import { NotePreprocessor } from '../data/NotePreprocessor';
import { Logger, consoleLogger } from '../utils/Logger';

/** Where a load has got to, for showing while a large vault is read. */
export type LoadProgress = { stage: 'notes' } | { stage: 'tags'; done: number; total: number };

export interface LoadedNotes {
	notes: Note[];
	/** False when a note or tag page still failed after retrying, so the notes or their tags are partial. */
	complete: boolean;
}

/**
 * Loads every note in the vault with its links and tags. The whole vault is always
 * needed, because a note in another notebook can link to, share a tag with, or be
 * similar to the notes on screen. What gets drawn is decided later, by the view.
 */
export class NoteLoader {
	public constructor(
		private readonly noteRepository = new NoteRepository(),
		private readonly preprocessor = new NotePreprocessor(),
		private readonly logger: Logger = consoleLogger
	) {}

	/** @throws if no notes could be read at all, so a failed load can't replace the graph already showing with an empty one. */
	public async load(onProgress?: (progress: LoadProgress) => void): Promise<LoadedNotes> {
		onProgress?.({ stage: 'notes' });

		const { notes, truncated } = await this.noteRepository.getAllNotes();
		if (truncated && notes.length === 0) {
			throw new Error('No notes could be loaded from Joplin.');
		}

		const { notes: enrichedNotes, tagsComplete } = await this.preprocessor.process(
			notes,
			(done, total) => onProgress?.({ stage: 'tags', done, total })
		);

		this.logger.info(`Enriched ${enrichedNotes.length} notes.`);

		return { notes: enrichedNotes, complete: !truncated && tagsComplete };
	}
}
