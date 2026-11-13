import joplin from 'api';
import { Note } from './Types';
import { DATA_API_RETRY, RetryOptions, retryWithBackoff } from '../utils/retryWithBackoff';
import { Logger, consoleLogger } from '../utils/Logger';

const NOTE_FIELDS = [
	'id',
	'parent_id',
	'title',
	'body',
	'created_time',
	'updated_time',
	'deleted_time',
	'is_conflict',
];

const VERSION_FIELDS = ['id', 'updated_time', 'deleted_time', 'is_conflict'];

/** Pages are numbered in units of this size, so it must stay the same for the whole walk. */
const PAGE_SIZE = 100;

interface NoteResponse extends Note {
	deleted_time: number;
	is_conflict?: number;
}

interface NotesPage {
	items?: NoteResponse[];
	has_more?: boolean;
}

type NotesCollection = { notes: Note[]; truncated: boolean };

export class NoteRepository {
	public constructor(
		private readonly pageRetry: RetryOptions = DATA_API_RETRY,
		private readonly logger: Logger = consoleLogger
	) {}

	/**
	 * Fetches all notes from the Joplin API with pagination, ordered by ID so a
	 * note saved mid-load can't shift the pages. Notes are also deduplicated by
	 * ID, since a note created mid-load can still move another across a page.
	 * @param maxNotes - optional safety cap on the number of notes fetched before truncating (default: no cap).
	 * @returns the collected notes and a `truncated` flag if the limit was hit or a page still failed after retrying.
	 */
	public async getAllNotes(maxNotes = Infinity): Promise<NotesCollection> {
		const notesById = new Map<string, Note>();
		const complete = await this.collectPages(['notes'], notesById, maxNotes, NOTE_FIELDS);
		this.logger.info(`Fetched ${notesById.size} notes.`);
		return { notes: Array.from(notesById.values()), truncated: !complete };
	}

	/**
	 * Lists which notes exist and when each last changed, without their bodies, so
	 * comparing against the vault is cheap.
	 */
	public async getNoteVersions(): Promise<{ versions: Map<string, number>; complete: boolean }> {
		const notesById = new Map<string, Note>();
		const complete = await this.collectPages(['notes'], notesById, Infinity, VERSION_FIELDS);

		const versions = new Map<string, number>();
		for (const [id, note] of notesById) versions.set(id, note.updated_time);
		return { versions, complete };
	}

	public async getNote(id: string): Promise<Note | null> {
		try {
			const note: NoteResponse = await joplin.data.get(['notes', id], {
				fields: NOTE_FIELDS,
			});
			if (note.deleted_time) {
				this.logger.info(`Note ${id} is in the trash.`);
				return null;
			}
			if (note.is_conflict) {
				this.logger.info(`Note ${id} is a conflict copy.`);
				return null;
			}
			return note;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes('Not Found')) {
				throw error;
			}
			this.logger.info(`Note ${id} no longer exists.`);
			return null;
		}
	}

	/** Adds every page at `path` to `notesById`. Returns false if it stopped early because of `maxNotes` or a failed page. */
	private async collectPages(
		path: string[],
		notesById: Map<string, Note>,
		maxNotes: number,
		fields: string[]
	): Promise<boolean> {
		let page = 1;
		let hasMore = true;
		while (hasMore) {
			const remaining = maxNotes - notesById.size;
			if (remaining <= 0) return false;

			try {
				const response = await this.fetchPage(path, page, PAGE_SIZE, fields);
				const active = (response.items ?? []).filter(
					(n) => !n.deleted_time && !n.is_conflict
				);
				for (const note of active.slice(0, remaining)) {
					notesById.set(note.id, note);
				}
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				this.logger.error('Failed to fetch notes page:', error);
				return false;
			}
		}
		return true;
	}

	private fetchPage(
		path: string[],
		page: number,
		limit: number,
		fields: string[]
	): Promise<NotesPage> {
		return retryWithBackoff(
			`${path.join('/')} page ${page} fetch`,
			() =>
				joplin.data.get(path, {
					fields,
					order_by: 'id',
					order_dir: 'ASC',
					limit,
					page,
				}),
			{ ...this.pageRetry, logger: this.logger }
		);
	}
}
