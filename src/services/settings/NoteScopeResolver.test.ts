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

	it('returns no notebook in particular for "all", with every notebook\'s title', async () => {
		const result = await resolver.resolve({ mode: 'all', selectedNotebookIds: [] });

		expect(result.folderIds).toBeNull();
		expect(result.scopeKey).toBe('all');
		expect(result.label).toBe('All notebooks');
		expect(result.followsSelection).toBe(false);
		expect(result.wholeVaultUnavailable).toBeUndefined();
		expect(result.notebookTitles.get('child-a1')).toBe('Projects');
	});

	it('logs when the notebook list is incomplete, and uses what it has', async () => {
		const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		mockFolderRepo.getAllFolders.mockResolvedValue({ folders: folders(), truncated: true });

		const result = await resolver.resolve({
			mode: 'selected',
			selectedNotebookIds: ['root-b'],
		});

		expect(result.folderIds).toEqual(new Set(['root-b']));
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	describe('reusing the notebook list', () => {
		let now: number;
		const withClock = () => new NoteScopeResolver(mockFolderRepo, undefined, () => now);
		const all = { mode: 'all' as const, selectedNotebookIds: [] };

		beforeEach(() => {
			now = 1_000_000;
		});

		it('reads the list once for views drawn close together', async () => {
			const cached = withClock();

			await cached.resolve(all);
			now += 5_000;
			await cached.resolve(all);

			expect(mockFolderRepo.getAllFolders).toHaveBeenCalledTimes(1);
		});

		it('reads the list again once it is a few seconds old', async () => {
			const cached = withClock();

			await cached.resolve(all);
			now += 10_001;
			await cached.resolve(all);

			expect(mockFolderRepo.getAllFolders).toHaveBeenCalledTimes(2);
		});

		it('reads the list again for a chosen notebook it has not seen, such as a new one', async () => {
			const cached = withClock();
			await cached.resolve(all);
			mockFolderRepo.getAllFolders.mockResolvedValue({
				folders: [...folders(), { id: 'new-nb', parent_id: '', title: 'New' }],
				truncated: false,
			});

			const result = await cached.resolve({ mode: 'selected', selectedNotebookIds: ['new-nb'] });

			expect(result.folderIds).toEqual(new Set(['new-nb']));
			expect(result.notebookTitles.get('new-nb')).toBe('New');
		});

		it('reads the list again when the open notebook is not in it', async () => {
			const cached = withClock();
			await cached.resolve(all);
			mockFolderRepo.getAllFolders.mockResolvedValue({
				folders: [
					...folders(),
					{ id: 'new-nb', parent_id: '', title: 'New' },
					{ id: 'new-child', parent_id: 'new-nb', title: 'Inside' },
				],
				truncated: false,
			});
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({
				id: 'new-nb',
				title: 'New',
			});

			const result = await cached.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toEqual(new Set(['new-nb', 'new-child']));
		});

		it('does not keep a list that was incomplete', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => undefined);
			mockFolderRepo.getAllFolders.mockResolvedValue({ folders: folders(), truncated: true });
			const cached = withClock();

			await cached.resolve(all);
			await cached.resolve(all);

			expect(mockFolderRepo.getAllFolders).toHaveBeenCalledTimes(2);
		});
	});

	describe('on a vault too large to draw at once', () => {
		const large = { wholeVaultAllowed: false };

		it('turns "all" into the current notebook, and says why', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({
				id: 'root-b',
				title: 'Personal',
			});

			const result = await resolver.resolve({ mode: 'all', selectedNotebookIds: [] }, large);

			expect(result.folderIds).toEqual(new Set(['root-b']));
			expect(result.label).toBe('Personal');
			expect(result.followsSelection).toBe(true);
			expect(result.wholeVaultUnavailable).toBe(true);
		});

		it('uses the open note when "all" is saved and no notebook is open', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue(null);
			(joplin.workspace.selectedNote as jest.Mock).mockResolvedValue({ id: 'note-1' });

			const result = await resolver.resolve({ mode: 'all', selectedNotebookIds: [] }, large);

			expect(result.folderIds).toBeNull();
			expect(result.openNoteId).toBe('note-1');
			expect(result.wholeVaultUnavailable).toBe(true);
		});

		it('turns a selection that no longer exists into the current notebook', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({
				id: 'root-b',
				title: 'Personal',
			});

			const result = await resolver.resolve(
				{ mode: 'selected', selectedNotebookIds: ['deleted'] },
				large
			);

			expect(result.scopeKey).toBe('current:root-b');
			expect(result.wholeVaultUnavailable).toBe(true);
		});

		it('leaves a real selection alone', async () => {
			const result = await resolver.resolve(
				{ mode: 'selected', selectedNotebookIds: ['root-b'] },
				large
			);

			expect(result.folderIds).toEqual(new Set(['root-b']));
			expect(result.wholeVaultUnavailable).toBeUndefined();
		});
	});

	describe('mode: current', () => {
		it('includes the selected notebook and its full sub-notebook tree', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({ id: 'root-a' });

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toEqual(new Set(['root-a', 'child-a1', 'grandchild-a1a']));
			expect(result.scopeKey).toBe('current:root-a');
		});

		it('names itself after the notebook and follows the selection', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue({
				id: 'root-a',
				title: 'Work',
			});

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.label).toBe('Work');
			expect(result.followsSelection).toBe(true);
			expect(result.notebookTitles.get('root-b')).toBe('Personal');
		});

		it('records the open note when no notebook is selected', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockResolvedValue(null);
			(joplin.workspace.selectedNote as jest.Mock).mockResolvedValue({ id: 'note-1' });

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toBeNull();
			expect(result.scopeKey).toBe('all');
			expect(result.openNoteId).toBe('note-1');
			expect(result.followsSelection).toBe(true);
		});

		it('copes with neither a notebook nor a note being available', async () => {
			(joplin.workspace.selectedFolder as jest.Mock).mockRejectedValue(
				new Error('no folder')
			);
			(joplin.workspace.selectedNote as jest.Mock).mockRejectedValue(new Error('no note'));

			const result = await resolver.resolve({ mode: 'current', selectedNotebookIds: [] });

			expect(result.folderIds).toBeNull();
			expect(result.openNoteId).toBeNull();
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

		it('names itself after one notebook, or counts several, and stays put', async () => {
			const one = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['root-a'],
			});
			const two = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['root-a', 'root-b'],
			});

			expect(one.label).toBe('Work');
			expect(two.label).toBe('2 notebooks');
			expect(one.followsSelection).toBe(false);
		});

		it('shows all notebooks when no configured ID matches, on a vault small enough', async () => {
			const logged = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			const result = await resolver.resolve({
				mode: 'selected',
				selectedNotebookIds: ['nonexistent-id'],
			});

			expect(result.folderIds).toBeNull();
			expect(result.label).toBe('All notebooks');
			logged.mockRestore();
		});

		it('shows all notebooks when no IDs are configured, on a vault small enough', async () => {
			const logged = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			const result = await resolver.resolve({ mode: 'selected', selectedNotebookIds: [] });

			expect(result.folderIds).toBeNull();
			logged.mockRestore();
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
