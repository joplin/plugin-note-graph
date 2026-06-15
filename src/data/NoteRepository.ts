import joplin from 'api';
import { Note } from './Types';

export class NoteRepository {
	public async getAllNotes(): Promise<Note[]> {
		const notes: Note[] = [];
		let page = 1;
		let hasMore = true;
		while (hasMore) {
			const response = await joplin.data.get(['notes'], {
				fields: ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time'],
				limit: 100,
				page,
			});
			notes.push(...(response.items ?? []));
			hasMore = response.has_more === true;
			page++;
		}
		console.info(`Fetched ${notes.length} notes.`);
		return notes;
	}
}
