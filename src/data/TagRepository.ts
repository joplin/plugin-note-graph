import joplin from 'api';
import { DATA_API_RETRY, RetryOptions, retryWithBackoff } from '../utils/retryWithBackoff';
import { Logger, consoleLogger } from '../utils/Logger';

/** Each lookup is a small round trip to Joplin's window, so a few at a time is enough, and leaves it room to breathe. */
const TAG_LOOKUP_CONCURRENCY = 4;
const PROGRESS_INTERVAL = 500;

export class TagRepository {
	private static readonly MAX_PAGES = 100;

	public constructor(
		private readonly pageRetry: RetryOptions = DATA_API_RETRY,
		private readonly logger: Logger = consoleLogger
	) {}

	/**
	 * Looks up the tags of each given note. Asking per note stays fast however large
	 * a tag is, unlike Joplin's tags/:id/notes route, which reloads every note in the
	 * tag for each page it returns: on a 10,500-note vault this took 8 s rather than 96 s.
	 * @returns a record mapping each note ID to its tag titles, and a `truncated` flag if a lookup still failed after retrying.
	 */
	public async getTagsForNotes(
		noteIds: string[],
		onProgress?: (done: number, total: number) => void
	): Promise<{ map: Record<string, string[]>; truncated: boolean }> {
		const map: Record<string, string[]> = {};
		if (noteIds.length === 0) return { map, truncated: false };

		try {
			if (!(await this.vaultHasTags())) return { map, truncated: false };
		} catch (error) {
			this.logger.error('Failed to check for tags:', error);
			return { map, truncated: true };
		}

		let next = 0;
		let done = 0;
		let truncated = false;
		const worker = async (): Promise<void> => {
			while (next < noteIds.length && !truncated) {
				const noteId = noteIds[next++];
				const result = await this.getTagsForNote(noteId);
				map[noteId] = result.titles;
				if (result.truncated) truncated = true;
				done++;
				if (done % PROGRESS_INTERVAL === 0) onProgress?.(done, noteIds.length);
			}
		};
		await Promise.all(Array.from({ length: TAG_LOOKUP_CONCURRENCY }, worker));

		return { map, truncated };
	}

	public async getTagsForNote(noteId: string): Promise<{ titles: string[]; truncated: boolean }> {
		const titles: string[] = [];
		let page = 1;
		let hasMore = true;

		while (hasMore && page <= TagRepository.MAX_PAGES) {
			try {
				const response = await retryWithBackoff(
					`Tags of note ${noteId} fetch`,
					() =>
						joplin.data.get(['notes', noteId, 'tags'], {
							fields: ['title'],
							page,
							limit: 100,
						}),
					{ ...this.pageRetry, logger: this.logger }
				);
				for (const tag of response.items ?? []) {
					titles.push(tag.title);
				}
				hasMore = response.has_more === true;
				page++;
			} catch (error) {
				this.logger.error(`Failed to fetch tags for note ${noteId}:`, error);
				return { titles, truncated: true };
			}
		}

		if (page > TagRepository.MAX_PAGES) {
			this.logger.info(
				`Tag fetch for note ${noteId} hit the ${TagRepository.MAX_PAGES}-page safety cap; returning ${titles.length} tags.`
			);
			return { titles, truncated: true };
		}

		return { titles, truncated: false };
	}

	private async vaultHasTags(): Promise<boolean> {
		const response = await retryWithBackoff(
			'Tags check',
			() => joplin.data.get(['tags'], { fields: ['id'], page: 1, limit: 1 }),
			{ ...this.pageRetry, logger: this.logger }
		);
		return (response.items ?? []).length > 0;
	}
}
