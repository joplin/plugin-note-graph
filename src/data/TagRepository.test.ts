import { TagRepository } from './TagRepository';
import joplin from 'api';

const mockGet = joplin.data.get as jest.Mock;

describe('TagRepository', () => {
	let repo: TagRepository;

	beforeEach(() => {
		repo = new TagRepository();
		jest.clearAllMocks();
	});

	it('returns empty map when no tags', async () => {
		mockGet.mockResolvedValueOnce({
			items: [],
			has_more: false,
		});

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(false);
		expect(map).toEqual({});
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it('maps tags to notes for a single tag and single note', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ id: 'tag1', title: 'important' }],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note1' }],
				has_more: false,
			});

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(false);
		expect(map).toEqual({
			note1: ['important'],
		});
	});

	it('handles paginated tag notes', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ id: 'tag1', title: 'tag1' }],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note1' }],
				has_more: true,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note2' }],
				has_more: false,
			});

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(false);
		expect(map).toEqual({
			note1: ['tag1'],
			note2: ['tag1'],
		});
	});

	it('maps multiple tags to same note', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [
					{ id: 't1', title: 'a' },
					{ id: 't2', title: 'b' },
				],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note1' }],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note1' }],
				has_more: false,
			});

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(false);
		expect(map).toEqual({
			note1: ['a', 'b'],
		});
	});

	it('handles paginated tags list', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ id: 't1', title: 'x' }],
				has_more: true,
			})
			.mockResolvedValueOnce({
				items: [{ id: 't2', title: 'y' }],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note1' }],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'note2' }],
				has_more: false,
			});

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(false);
		expect(map).toEqual({
			note1: ['x'],
			note2: ['y'],
		});

		expect(mockGet).toHaveBeenCalledTimes(4);
	});

	it('stops at maxTags and returns truncated true', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: `tag${i}` })),
				has_more: true,
			})
			.mockResolvedValue({ items: [], has_more: false });

		const { map, truncated } = await repo.getNoteTagsMap(30);

		expect(truncated).toBe(true);
		expect(mockGet).toHaveBeenCalledWith(['tags'], expect.objectContaining({ limit: 30 }));
	});

	it('returns partial map with truncated true when tag fetch fails', async () => {
		mockGet.mockRejectedValueOnce(new Error('network error'));

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(true);
		expect(map).toEqual({});
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it('returns partial map when tag-notes fetch fails mid-loop', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [
					{ id: 't1', title: 'tag1' },
					{ id: 't2', title: 'tag2' },
				],
				has_more: false,
			})
			.mockResolvedValueOnce({
				items: [{ id: 'n1' }],
				has_more: false,
			})
			.mockRejectedValueOnce(new Error('network error'));

		const { map, truncated } = await repo.getNoteTagsMap();

		expect(truncated).toBe(true);
		expect(map).toEqual({
			n1: ['tag1'],
		});
		expect(mockGet).toHaveBeenCalledTimes(3);
	});
});
