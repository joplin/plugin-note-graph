import { GraphPresenter, PresentedView } from '../graph/GraphPresenter';
import { currentScopeKey, ResolvedScope } from './NoteScopeResolver';

export interface WorkspaceSelection {
	folderId: string | null;
	noteId: string | null;
}

/**
 * Keeps the view on the notebook the user is in. Moving to another notebook only
 * changes what's drawn: the graph already holds the whole vault, so nothing reloads.
 */
export class ScopeFollower {
	public constructor(
		private readonly presenter: Pick<GraphPresenter, 'currentScope' | 'refresh'>,
		private readonly readSelection: () => Promise<WorkspaceSelection>,
		private readonly deliver: (view: PresentedView) => Promise<void>
	) {}

	public async onSelectionChanged(): Promise<void> {
		const scope = this.presenter.currentScope();
		if (!scope.followsSelection) return;

		if (!this.isOutOfDate(scope, await this.readSelection())) return;

		const presented = await this.presenter.refresh();
		if (presented) await this.deliver(presented);
	}

	private isOutOfDate(scope: ResolvedScope, { folderId, noteId }: WorkspaceSelection): boolean {
		if (scope.scopeKey !== currentScopeKey(folderId)) return true;
		return !scope.folderIds && (scope.openNoteId ?? null) !== noteId;
	}
}
