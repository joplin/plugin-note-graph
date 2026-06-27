import joplin from 'api';
import { Note } from './Types';

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
					fields: ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time'],
					limit: Math.min(remaining, 100),
					page,
				});
				const items = (response.items ?? []).slice(0, remaining);
				notes.push(...items);
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
}
