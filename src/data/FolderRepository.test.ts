import { FolderRepository } from './FolderRepository';
import joplin from 'api';

const mockGet = joplin.data.get as jest.Mock;

describe('FolderRepository', () => {
	let repo: FolderRepository;

	beforeEach(() => {
		repo = new FolderRepository();
		jest.clearAllMocks();
	});

	it('fetches all folders when single page', async () => {
		mockGet.mockResolvedValueOnce({
			items: [{ id: '1', parent_id: '', title: 'Notebook 1' }],
			has_more: false,
		});

		const { folders, truncated } = await repo.getAllFolders();

		expect(truncated).toBe(false);
		expect(folders).toHaveLength(1);
		expect(folders[0].title).toBe('Notebook 1');
		expect(mockGet).toHaveBeenCalledWith(['folders'], {
			fields: ['id', 'parent_id', 'title'],
			limit: 100,
			page: 1,
		});
	});

	it('fetches all folders across multiple pages', async () => {
		mockGet
			.mockResolvedValueOnce({ items: [{ id: '1' }, { id: '2' }], has_more: true })
			.mockResolvedValueOnce({ items: [{ id: '3' }], has_more: false });

		const { folders, truncated } = await repo.getAllFolders();

		expect(truncated).toBe(false);
		expect(folders).toHaveLength(3);
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it('returns collected folders with truncated true when a page fails', async () => {
		mockGet
			.mockResolvedValueOnce({ items: [{ id: '1' }], has_more: true })
			.mockRejectedValueOnce(new Error('network error'));

		const { folders, truncated } = await repo.getAllFolders();

		expect(truncated).toBe(true);
		expect(folders).toHaveLength(1);
	});

	it('stops at maxFolders and returns truncated true', async () => {
		mockGet.mockResolvedValueOnce({
			items: Array.from({ length: 50 }, (_, i) => ({ id: `${i + 1}` })),
			has_more: true,
		});

		const { folders, truncated } = await repo.getAllFolders(30);

		expect(truncated).toBe(true);
		expect(folders).toHaveLength(30);
	});

	it('handles missing items in response gracefully', async () => {
		mockGet.mockResolvedValueOnce({ has_more: false });

		const { folders, truncated } = await repo.getAllFolders();

		expect(truncated).toBe(false);
		expect(folders).toEqual([]);
	});
});
