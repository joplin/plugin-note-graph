import { ResolvedScope, WHOLE_VAULT_SCOPE } from './NoteScopeResolver';
import { ScopeFollower, WorkspaceSelection } from './ScopeFollower';
import { PresentedView } from '../graph/GraphPresenter';

const folderScope = (folderId: string, followsSelection = true): ResolvedScope => ({
	folderIds: new Set([folderId]),
	scopeKey: `current:${folderId}`,
	label: folderId,
	notebookTitles: new Map(),
	followsSelection,
});

describe('ScopeFollower', () => {
	const presented = { payload: {}, patch: null } as unknown as PresentedView;
	let scope: ResolvedScope;
	let selection: WorkspaceSelection;
	let refresh: jest.Mock;
	let deliver: jest.Mock;
	let follower: ScopeFollower;

	beforeEach(() => {
		scope = folderScope('f1');
		selection = { folderId: 'f1', noteId: 'n1' };
		refresh = jest.fn().mockResolvedValue(presented);
		deliver = jest.fn().mockResolvedValue(undefined);
		follower = new ScopeFollower(
			{ currentScope: () => scope, refresh },
			async () => selection,
			deliver
		);
	});

	it('shows the new notebook when the user moves to another, without any reload', async () => {
		selection = { folderId: 'f2', noteId: 'n2' };

		await follower.onSelectionChanged();

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith(presented);
	});

	it('does nothing when the user only opens another note in the same notebook', async () => {
		selection = { folderId: 'f1', noteId: 'n2' };

		await follower.onSelectionChanged();

		expect(refresh).not.toHaveBeenCalled();
	});

	it('ignores moves when the scope was picked by hand', async () => {
		scope = folderScope('f1', false);
		selection = { folderId: 'f2', noteId: 'n2' };

		await follower.onSelectionChanged();

		expect(refresh).not.toHaveBeenCalled();
	});

	it('ignores moves when the whole vault is showing', async () => {
		scope = WHOLE_VAULT_SCOPE;
		selection = { folderId: 'f2', noteId: 'n2' };

		await follower.onSelectionChanged();

		expect(refresh).not.toHaveBeenCalled();
	});

	describe('with no notebook open', () => {
		beforeEach(() => {
			scope = { ...WHOLE_VAULT_SCOPE, followsSelection: true, openNoteId: 'n1' };
			selection = { folderId: null, noteId: 'n1' };
		});

		it('follows the open note', async () => {
			selection = { folderId: null, noteId: 'n2' };

			await follower.onSelectionChanged();

			expect(refresh).toHaveBeenCalledTimes(1);
		});

		it('does nothing when the open note is the same', async () => {
			await follower.onSelectionChanged();

			expect(refresh).not.toHaveBeenCalled();
		});

		it('moves to a notebook once one is opened', async () => {
			selection = { folderId: 'f1', noteId: 'n1' };

			await follower.onSelectionChanged();

			expect(refresh).toHaveBeenCalledTimes(1);
		});

		it('treats "no note" and "never knew the note" as the same', async () => {
			scope = { ...WHOLE_VAULT_SCOPE, followsSelection: true };
			selection = { folderId: null, noteId: null };

			await follower.onSelectionChanged();

			expect(refresh).not.toHaveBeenCalled();
		});
	});

	it('delivers nothing when there is no graph yet', async () => {
		refresh.mockResolvedValue(null);
		selection = { folderId: 'f2', noteId: null };

		await follower.onSelectionChanged();

		expect(deliver).not.toHaveBeenCalled();
	});
});
