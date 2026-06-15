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

		const map = await repo.getNoteTagsMap();

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

		const map = await repo.getNoteTagsMap();

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

		const map = await repo.getNoteTagsMap();

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

		const map = await repo.getNoteTagsMap();

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

		const map = await repo.getNoteTagsMap();

		expect(map).toEqual({
			note1: ['x'],
			note2: ['y'],
		});

		expect(mockGet).toHaveBeenCalledTimes(4);
	});
});
