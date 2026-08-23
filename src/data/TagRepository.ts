import joplin from 'api';

export class TagRepository {
	private static readonly MAX_PAGES = 100;

	/**
	 * Builds a map of note IDs to their tag titles by fetching all tags and their associated notes.
	 * @param maxTags - maximum tags to fetch before truncating (default 1000).
	 * @returns a record mapping each note ID to an array of tag titles and a `truncated` flag.
	 */
	public async getNoteTagsMap(maxTags = 1000): Promise<{ map: Record<string, string[]>; truncated: boolean }> {
		const noteTagsMap: Record<string, string[]> = {};
		const tags: { id: string; title: string }[] = [];
		let page = 1;
		let hasMore = true;

		while (hasMore) {
			try {
				const response = await joplin.data.get(['tags'], {
					fields: ['id', 'title'],
					page,
					limit: Math.min(Math.max(maxTags - tags.length, 0), 100),
				});
				const items = (response.items ?? []).slice(0, maxTags - tags.length);
				tags.push(...items);
				hasMore = response.has_more === true;
				page++;

				if (tags.length >= maxTags) {
					hasMore = false;
				}
			} catch (error) {
				console.error('Failed to fetch tags:', error);
				return { map: noteTagsMap, truncated: true };
			}
		}

		for (const tag of tags) {
			let notePage = 1;
			let hasMoreNotes = true;
			while (hasMoreNotes) {
				try {
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
				} catch (error) {
					console.error(`Failed to fetch notes for tag ${tag.id}:`, error);
					return { map: noteTagsMap, truncated: true };
				}
			}
		}

		return { map: noteTagsMap, truncated: tags.length >= maxTags ? true : false };
	}

	public async getTagsForNote(noteId: string): Promise<{ titles: string[]; truncated: boolean }> {
		const titles: string[] = [];
		let page = 1;
		let hasMore = true;

		while (hasMore && page <= TagRepository.MAX_PAGES) {
			try {
				const response = await joplin.data.get(['notes', noteId, 'tags'], {
					fields: ['title'],
					page,
					limit: 100,
				});
				for (const tag of response.items ?? []) {
					titles.push(tag.title);
				}
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				console.error(`Failed to fetch tags for note ${noteId}:`, error);
				return { titles, truncated: true };
			}
		}

		if (page > TagRepository.MAX_PAGES) {
			console.info(
				`Tag fetch for note ${noteId} hit the ${TagRepository.MAX_PAGES}-page safety cap; returning ${titles.length} tags.`
			);
			return { titles, truncated: true };
		}

		return { titles, truncated: false };
	}
}
