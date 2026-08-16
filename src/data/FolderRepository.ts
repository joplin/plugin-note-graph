import joplin from 'api';

const FOLDER_FIELDS = ['id', 'parent_id', 'title'];

export interface Folder {
	id: string;
	parent_id: string;
	title: string;
}

export class FolderRepository {
	public async getAllFolders(
		maxFolders = 5000
	): Promise<{ folders: Folder[]; truncated: boolean }> {
		const folders: Folder[] = [];
		let page = 1;
		let hasMore = true;
		while (hasMore) {
			const remaining = maxFolders - folders.length;
			if (remaining <= 0) {
				return { folders, truncated: true };
			}

			try {
				const response = await joplin.data.get(['folders'], {
					fields: FOLDER_FIELDS,
					limit: Math.min(remaining, 100),
					page,
				});
				const items: Folder[] = response.items ?? [];
				folders.push(...items.slice(0, remaining));
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				console.error('Failed to fetch folders page:', error);
				return { folders, truncated: true };
			}
		}
		return { folders, truncated: false };
	}
}
