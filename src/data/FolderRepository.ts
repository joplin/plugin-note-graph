import joplin from 'api';
import { DATA_API_RETRY, RetryOptions, retryWithBackoff } from '../utils/retryWithBackoff';
import { Logger, consoleLogger } from '../utils/Logger';

const FOLDER_FIELDS = ['id', 'parent_id', 'title'];

/** Pages are numbered in units of this size, so it must stay the same for the whole walk. */
const PAGE_SIZE = 100;

export interface Folder {
	id: string;
	parent_id: string;
	title: string;
}

export class FolderRepository {
	public constructor(
		private readonly pageRetry: RetryOptions = DATA_API_RETRY,
		private readonly logger: Logger = consoleLogger
	) {}

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
				const response = await retryWithBackoff(
					`Notebooks page ${page} fetch`,
					() =>
						joplin.data.get(['folders'], {
							fields: FOLDER_FIELDS,
							order_by: 'id',
							order_dir: 'ASC',
							limit: PAGE_SIZE,
							page,
						}),
					{ ...this.pageRetry, logger: this.logger }
				);
				const items: Folder[] = response.items ?? [];
				folders.push(...items.slice(0, remaining));
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				this.logger.error('Failed to fetch folders page:', error);
				return { folders, truncated: true };
			}
		}
		return { folders, truncated: false };
	}
}
