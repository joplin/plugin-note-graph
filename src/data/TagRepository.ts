import joplin from 'api';

export class TagRepository {
	public async getNoteTagsMap(): Promise<Record<string, string[]>> {
		const noteTagsMap: Record<string, string[]> = {};
		let page = 1;
		let hasMore = true;
		const tags: { id: string; title: string }[] = [];
		while (hasMore) {
			const response = await joplin.data.get(['tags'], {
				fields: ['id', 'title'],
				page,
				limit: 100,
			});
			tags.push(...(response.items ?? []));
			hasMore = response.has_more === true;
			page++;
		}

		for (const tag of tags) {
			let notePage = 1;
			let hasMoreNotes = true;
			while (hasMoreNotes) {
				const notesResponse = await joplin.data.get(['tags', tag.id, 'notes'], {
					fields: ['id'],
					page: notePage,
					limit: 100,
				});
				for (const note of notesResponse.items ?? []) {
					if (!noteTagsMap[note.id]) noteTagsMap[note.id] = [];
					noteTagsMap[note.id].push(tag.title);
				}
				hasMoreNotes = notesResponse.has_more === true;
				notePage++;
			}
		}

		return noteTagsMap;
	}
}
