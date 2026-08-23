import joplin from 'api';
import { NoteScopeResolver, currentScopeKey } from './NoteScopeResolver';
import { FolderRepository } from '../../data/FolderRepository';

jest.mock('../../data/FolderRepository');

const MockFolderRepository = FolderRepository as jest.MockedClass<typeof FolderRepository>;

function folders() {
	return [
		{ id: 'root-a', parent_id: '', title: 'Work' },
		{ id: 'child-a1', parent_id: 'root-a', title: 'Projects' },
		{ id: 'grandchild-a1a', parent_id: 'child-a1', title: 'Alpha' },
		{ id: 'root-b', parent_id: '', title: 'Personal' },
	];
}

describe('NoteScopeResolver', () => {
	let mockFolderRepo: jest.Mocked<FolderRepository>;
	let resolver: NoteScopeResolver;

	beforeEach(() => {
		jest.clearAllMocks();
		mockFolderRepo = new MockFolderRepository() as jest.Mocked<FolderRepository>;
		mockFolderRepo.getAllFolders.mockResolvedValue({ folders: folders(), truncated: false });
		resolver = new NoteScopeResolver(mockFolderRepo);
	});

	it('returns no filter for "all" without touching the folder tree', async () => {
		const result = await resolver.resolve({ mode: 'all', selectedNotebookIds: [] });

		expect(result).toEqual({ folderIds: null, scopeKey: 'all' });
		expect(mockFolderRepo.getAllFolders).not.toHaveBeenCalled();
	});

	describe('mode: current', () => {
		it('includes the selected notebook and its full sub-notebook tree', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({ id: 'root-a' });

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toEqual(new Set(['root-a', 'child-a1', 'grandchild-a1a']));
			expect(result.scopeKey).toBe('current:root-a');
		});

		it('falls back to all notebooks when no notebook is currently selected', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue(null);

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result).toEqual({ folderIds: null, scopeKey: 'all' });
		});

		it('falls back to all notebooks when selectedFolder() throws', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockRejectedValue(
				new Error('no folder')
			);

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result).toEqual({ folderIds: null, scopeKey: 'all' });
		});

		it('scopes to a leaf notebook with no children as just itself', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({ id: 'root-b' });

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toEqual(new Set(['root-b']));
		});
	});

	describe('mode: selected', () => {
		it('matches configured IDs and includes their sub-notebooks', async () => {
			const result = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['root-a'],
			});

			expect(result.folderIds).toEqual(new Set(['root-a', 'child-a1', 'grandchild-a1a']));
			expect(result.scopeKey).toBe('selected:child-a1,grandchild-a1a,root-a');
		});

		it('unions multiple selected notebooks', async () => {
			const result = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['root-a', 'root-b'],
			});

			expect(result.folderIds).toEqual(
				new Set(['root-a', 'child-a1', 'grandchild-a1a', 'root-b'])
			);
		});

		it('scopes by ID, so two notebooks sharing a title are not conflated', async () => {
			mockFolderRepo.getAllFolders.mockResolvedValue({
				folders: [
					{ id: 'work-1', parent_id: '', title: 'Work' },
					{ id: 'work-2', parent_id: '', title: 'Work' },
				],
				truncated: false,
			});

			const result = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['work-1'],
			});

			expect(result.folderIds).toEqual(new Set(['work-1']));
			expect(result.scopeKey).toBe('selected:work-1');
		});

		it('falls back to all notebooks when no configured ID matches', async () => {
			const result = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['nonexistent-id'],
			});

			expect(result).toEqual({ folderIds: null, scopeKey: 'all' });
		});

		it('falls back to all notebooks when no IDs are configured', async () => {
			const result = await resolver.resolve({ mode: 'selected', selectedNotebookIds: [] });

			expect(result).toEqual({ folderIds: null, scopeKey: 'all' });
		});
	});

	describe('currentScopeKey', () => {
		it('derives the scope key from a folder id', () => {
			expect(currentScopeKey('root-a')).toBe('current:root-a');
		});

		it('returns the all-scope key when no folder is selected', () => {
			expect(currentScopeKey(null)).toBe('all');
		});
	});
});
