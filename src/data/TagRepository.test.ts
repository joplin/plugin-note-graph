import { TagRepository } from './TagRepository';
import joplin from 'api';

const mockGet = joplin.data.get as jest.Mock;

describe('TagRepository', () => {
	let repo: TagRepository;

	beforeEach(() => {
		repo = new TagRepository({ maxAttempts: 3, baseDelayMs: 0 });
		mockGet.mockReset();
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('getTagsForNotes', () => {
		const routeWith = (tagsByNote: Record<string, string[]>) => async (path: string[]) => {
			if (path[0] === 'tags') return { items: [{ id: 't' }], has_more: false };
			return {
				items: (tagsByNote[path[1]] ?? []).map((title) => ({ title })),
				has_more: false,
			};
		};

		it('maps each note to its tags', async () => {
			mockGet.mockImplementation(routeWith({ a: ['one', 'two'], b: ['two'] }));

			const { map, truncated } = await repo.getTagsForNotes(['a', 'b', 'c']);

			expect(truncated).toBe(false);
			expect(map).toEqual({ a: ['one', 'two'], b: ['two'], c: [] });
		});

		it('never uses the tags/:id/notes route, which gets very slow on large tags', async () => {
			mockGet.mockImplementation(routeWith({ a: ['one'] }));

			await repo.getTagsForNotes(['a']);

			for (const [path] of mockGet.mock.calls) {
				if (path[0] === 'tags') expect(path).toHaveLength(1);
			}
		});

		it('makes a single call when the vault has no tags at all', async () => {
			mockGet.mockResolvedValue({ items: [], has_more: false });

			const { map, truncated } = await repo.getTagsForNotes(['a', 'b', 'c']);

			expect(truncated).toBe(false);
			expect(map).toEqual({});
			expect(mockGet).toHaveBeenCalledTimes(1);
		});

		it('makes no calls for no notes', async () => {
			await repo.getTagsForNotes([]);

			expect(mockGet).not.toHaveBeenCalled();
		});

		it('handles a large vault, a few requests at a time', async () => {
			let inFlight = 0;
			let peak = 0;
			mockGet.mockImplementation(async (path: string[]) => {
				if (path[0] === 'tags') return { items: [{ id: 't' }], has_more: false };
				inFlight++;
				peak = Math.max(peak, inFlight);
				await Promise.resolve();
				inFlight--;
				return { items: [{ title: 'x' }], has_more: false };
			});
			const ids = Array.from({ length: 12000 }, (_, i) => `n${i}`);

			const { map } = await repo.getTagsForNotes(ids);

			expect(Object.keys(map)).toHaveLength(12000);
			expect(peak).toBeLessThanOrEqual(4);
			expect(peak).toBeGreaterThan(1);
		});

		it('reports progress every so often, not for every note', async () => {
			mockGet.mockImplementation(routeWith({}));
			const onProgress = jest.fn();
			const ids = Array.from({ length: 1200 }, (_, i) => `n${i}`);

			await repo.getTagsForNotes(ids, onProgress);

			expect(onProgress.mock.calls).toEqual([
				[500, 1200],
				[1000, 1200],
			]);
		});

		it('retries a failed lookup and carries on', async () => {
			let failed = false;
			mockGet.mockImplementation(async (path: string[]) => {
				if (path[0] === 'tags') return { items: [{ id: 't' }], has_more: false };
				if (path[1] === 'b' && !failed) {
					failed = true;
					throw new Error('network error');
				}
				return { items: [{ title: 'x' }], has_more: false };
			});

			const { map, truncated } = await repo.getTagsForNotes(['a', 'b']);

			expect(truncated).toBe(false);
			expect(map.b).toEqual(['x']);
		});

		it('stops and reports incomplete when lookups keep failing, instead of retrying every note', async () => {
			mockGet.mockImplementation(async (path: string[]) => {
				if (path[0] === 'tags') return { items: [{ id: 't' }], has_more: false };
				throw new Error('network error');
			});
			const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`);

			const { truncated } = await repo.getTagsForNotes(ids);

			expect(truncated).toBe(true);
			expect(mockGet.mock.calls.length).toBeLessThan(50);
		});

		it('reports incomplete when the tag check itself fails', async () => {
			mockGet.mockRejectedValue(new Error('network error'));

			const { truncated } = await repo.getTagsForNotes(['a']);

			expect(truncated).toBe(true);
		});
	});

	describe('getTagsForNote', () => {
		it('returns tag titles for a single note without walking all tags', async () => {
			mockGet.mockResolvedValueOnce({
				items: [{ title: 'a' }, { title: 'b' }],
				has_more: false,
			});

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toEqual(['a', 'b']);
			expect(truncated).toBe(false);
			expect(mockGet).toHaveBeenCalledTimes(1);
			expect(mockGet).toHaveBeenCalledWith(['notes', 'note1', 'tags'], {
				fields: ['title'],
				page: 1,
				limit: 100,
			});
		});

		it('paginates through a note with many tags', async () => {
			mockGet
				.mockResolvedValueOnce({ items: [{ title: 'a' }], has_more: true })
				.mockResolvedValueOnce({ items: [{ title: 'b' }], has_more: false });

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toEqual(['a', 'b']);
			expect(truncated).toBe(false);
			expect(mockGet).toHaveBeenCalledTimes(2);
		});

		it('returns an empty array for a note with no tags', async () => {
			mockGet.mockResolvedValueOnce({ items: [], has_more: false });

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toEqual([]);
			expect(truncated).toBe(false);
		});

		it('reports truncated when the fetch fails partway through', async () => {
			mockGet
				.mockResolvedValueOnce({ items: [{ title: 'a' }], has_more: true })
				.mockRejectedValueOnce(new Error('network error'));

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toEqual(['a']);
			expect(truncated).toBe(true);
		});

		it('reports truncated when it hits the page safety cap for a note whose tag list never reports has_more: false', async () => {
			mockGet.mockResolvedValue({ items: [{ title: 'a' }], has_more: true });

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toHaveLength(100);
			expect(truncated).toBe(true);
			expect(mockGet).toHaveBeenCalledTimes(100);
		});

		it('does not report truncated when the last allowed page is also the last page', async () => {
			for (let page = 1; page < 100; page++) {
				mockGet.mockResolvedValueOnce({ items: [{ title: `t${page}` }], has_more: true });
			}
			mockGet.mockResolvedValueOnce({ items: [{ title: 't100' }], has_more: false });

			const { titles, truncated } = await repo.getTagsForNote('note1');

			expect(titles).toHaveLength(100);
			expect(truncated).toBe(false);
		});
	});
});
