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

/** Every view works out its scope, so the notebook list is read once for views drawn close together. */
const FOLDER_LIST_REUSE_MS = 10_000;

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
	private recentFolders: { folders: Folder[]; readAt: number } | null = null;

	public constructor(
		private readonly folderRepository = new FolderRepository(),
		private readonly logger: Logger = consoleLogger,
		private readonly now: () => number = Date.now
	) {}

	public async resolve(
		settings: ScopeSettings,
		{ wholeVaultAllowed }: ScopeOptions = { wholeVaultAllowed: true }
	): Promise<ResolvedScope> {
		const needed = settings.mode === 'selected' ? settings.selectedNotebookIds : [];
		const folders = await this.loadFolders(needed);

		const specific = await this.resolveSpecificScope(settings, folders);
		if (specific) return specific;
		if (wholeVaultAllowed) return { ...WHOLE_VAULT_SCOPE, notebookTitles: this.titlesOf(folders) };

		const current = await this.resolveCurrent(folders);
		return { ...current, wholeVaultUnavailable: true };
	}

	/** Reads the list again when it is old, or when it lacks a notebook that must be in it, such as a new one. */
	private async loadFolders(mustInclude: string[]): Promise<Folder[]> {
		const recent = this.recentFolders;
		if (recent && this.now() - recent.readAt < FOLDER_LIST_REUSE_MS) {
			const known = new Set(recent.folders.map((folder) => folder.id));
			if (mustInclude.every((id) => known.has(id))) return recent.folders;
		}

		const { folders, truncated } = await this.folderRepository.getAllFolders();
		if (truncated) {
			this.logger.error(
				'Note Graph scope: notebook list is incomplete; some notebooks may be missing from the scope.'
			);
		}
		this.recentFolders = truncated ? null : { folders, readAt: this.now() };
		return folders;
	}

	private titlesOf(folders: Folder[]): Map<string, string> {
		return new Map(folders.map((folder) => [folder.id, folder.title]));
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

	private async resolveCurrent(known: Folder[]): Promise<ResolvedScope> {
		const current = await joplin.workspace.selectedFolder().catch(() => null);
		if (!current) {
			const openNote = await joplin.workspace.selectedNote().catch(() => null);
			return {
				...WHOLE_VAULT_SCOPE,
				notebookTitles: this.titlesOf(known),
				followsSelection: true,
				openNoteId: openNote?.id ?? null,
			};
		}

		const folders = known.some((folder) => folder.id === current.id)
			? known
			: await this.loadFolders([current.id]);
		return {
			folderIds: this.expandSubtree(folders, [current.id]),
			scopeKey: currentScopeKey(current.id),
			label: current.title,
			notebookTitles: this.titlesOf(folders),
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
			notebookTitles: this.titlesOf(folders),
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
