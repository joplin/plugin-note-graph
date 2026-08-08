import joplin from 'api';
import { Note } from './Types';

const NOTE_FIELDS = ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'deleted_time'];

interface NoteResponse extends Note {
	deleted_time: number;
}

export class NoteRepository {
	/**
	 * Fetches all notes from the Joplin API with pagination.
	 * @param maxNotes - maximum notes to fetch before truncating (default 5000).
	 * @returns the collected notes and a `truncated` flag if the limit was hit or an error occurred.
	 */
	public async getAllNotes(maxNotes = 5000): Promise<{ notes: Note[]; truncated: boolean }> {
		const notes: Note[] = [];
		let page = 1;
		let hasMore = true;
		while (hasMore) {
			const remaining = maxNotes - notes.length;
			if (remaining <= 0) {
				return { notes, truncated: true };
			}

			try {
				const response = await joplin.data.get(['notes'], {
					fields: NOTE_FIELDS,
					limit: Math.min(remaining, 100),
					page,
				});
				const items: NoteResponse[] = response.items ?? [];
				const active = items.filter((n) => !n.deleted_time).slice(0, remaining);
				notes.push(...active);
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				console.error('Failed to fetch notes page:', error);
				return { notes, truncated: true };
			}
		}
		console.info(`Fetched ${notes.length} notes.`);
		return { notes, truncated: false };
	}

	public async getNote(id: string): Promise<Note | null> {
		try {
			const note: NoteResponse = await joplin.data.get(['notes', id], {
				fields: NOTE_FIELDS,
			});
			if (note.deleted_time) {
				console.info(`Note ${id} is in the trash.`);
				return null;
			}
			return note;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes('Not Found')) {
				throw error;
			}
			console.info(`Note ${id} no longer exists.`);
			return null;
		}
	}
}
