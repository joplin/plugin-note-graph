import joplin from 'api';
import { Folder, FolderRepository } from '../../data/FolderRepository';
import { Logger, consoleLogger } from '../../utils/Logger';

export type ScopeMode = 'all' | 'current' | 'selected';

export interface ScopeSettings {
	mode: ScopeMode;
	selectedNotebookIds: string[];
}

/** Which notes a view is about. The graph itself always covers the whole vault. */
export interface ResolvedScope {
	/** The notebooks in scope, including nested ones, or null for no notebook in particular. */
	folderIds: Set<string> | null;
	scopeKey: string;
	label: string;
	/** Every notebook's title by ID, not just those in scope, for describing notes from elsewhere. */
	notebookTitles: Map<string, string>;
	/** True when this scope has to be worked out again as the user moves between notebooks. */
	followsSelection: boolean;
	/** The open note, for when no notebook is open. */
	openNoteId?: string | null;
	/** True when the user asked for the whole vault, or for something that no longer exists, and a large vault can't draw that. */
	wholeVaultUnavailable?: boolean;
}

export interface ScopeOptions {
	/** False when the vault is too large to draw at once. */
	wholeVaultAllowed: boolean;
}

export const WHOLE_VAULT_SCOPE_KEY = 'all';
const WHOLE_VAULT_LABEL = 'All notebooks';

export const WHOLE_VAULT_SCOPE: ResolvedScope = {
	folderIds: null,
	scopeKey: WHOLE_VAULT_SCOPE_KEY,
	label: WHOLE_VAULT_LABEL,
	notebookTitles: new Map(),
	followsSelection: false,
};

export function currentScopeKey(folderId: string | null): string {
	return folderId ? `current:${folderId}` : WHOLE_VAULT_SCOPE_KEY;
}

export class NoteScopeResolver {
	public constructor(
		private readonly folderRepository = new FolderRepository(),
		private readonly logger: Logger = consoleLogger
	) {}

	public async resolve(
		settings: ScopeSettings,
		{ wholeVaultAllowed }: ScopeOptions = { wholeVaultAllowed: true }
	): Promise<ResolvedScope> {
		const { folders, truncated } = await this.folderRepository.getAllFolders();
		if (truncated) {
			this.logger.error(
				'Note Graph scope: notebook list is incomplete; some notebooks may be missing from the scope.'
			);
		}
		const notebookTitles = new Map(folders.map((folder) => [folder.id, folder.title]));

		const specific = await this.resolveSpecificScope(settings, folders);
		if (specific) return { ...specific, notebookTitles };
		if (wholeVaultAllowed) return { ...WHOLE_VAULT_SCOPE, notebookTitles };

		const current = await this.resolveCurrent(folders);
		return { ...current, notebookTitles, wholeVaultUnavailable: true };
	}

	/** Returns null when the settings don't lead to any particular notebooks. */
	private async resolveSpecificScope(
		settings: ScopeSettings,
		folders: Folder[]
	): Promise<ResolvedScope | null> {
		if (settings.mode === 'current') return this.resolveCurrent(folders);
		if (settings.mode === 'selected') {
			return this.resolveSelected(folders, settings.selectedNotebookIds);
		}
		return null;
	}

	private async resolveCurrent(folders: Folder[]): Promise<ResolvedScope> {
		const current = await joplin.workspace.selectedFolder().catch(() => null);
		if (!current) {
			const openNote = await joplin.workspace.selectedNote().catch(() => null);
			return {
				...WHOLE_VAULT_SCOPE,
				followsSelection: true,
				openNoteId: openNote?.id ?? null,
			};
		}

		return {
			folderIds: this.expandSubtree(folders, [current.id]),
			scopeKey: currentScopeKey(current.id),
			label: current.title,
			notebookTitles: new Map(),
			followsSelection: true,
		};
	}

	private resolveSelected(folders: Folder[], ids: string[]): ResolvedScope | null {
		const wantedIds = new Set(ids);
		const roots = folders.filter((f) => wantedIds.has(f.id));

		if (roots.length === 0) {
			this.logger.info(
				'Note Graph scope: none of the selected notebook IDs matched an existing notebook.'
			);
			return null;
		}

		const folderIds = this.expandSubtree(
			folders,
			roots.map((f) => f.id)
		);
		return {
			folderIds,
			scopeKey: `selected:${Array.from(folderIds).sort().join(',')}`,
			label: roots.length === 1 ? roots[0].title : `${roots.length} notebooks`,
			notebookTitles: new Map(),
			followsSelection: false,
		};
	}

	private expandSubtree(folders: Folder[], rootIds: string[]): Set<string> {
		const childrenByParent = new Map<string, string[]>();
		for (const folder of folders) {
			const list = childrenByParent.get(folder.parent_id);
			if (list) {
				list.push(folder.id);
			} else {
				childrenByParent.set(folder.parent_id, [folder.id]);
			}
		}

		const included = new Set<string>();
		const queue = [...rootIds];
		while (queue.length > 0) {
			const id = queue.shift() as string;
			if (included.has(id)) continue;
			included.add(id);
			for (const childId of childrenByParent.get(id) ?? []) {
				queue.push(childId);
			}
		}
		return included;
	}
}
