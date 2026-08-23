import joplin from 'api';
import { Folder, FolderRepository } from '../../data/FolderRepository';

export type ScopeMode = 'all' | 'current' | 'selected';

export interface ScopeSettings {
	mode: ScopeMode;
	selectedNotebookIds: string[];
}

export interface ResolvedScope {
	folderIds: Set<string> | null;
	scopeKey: string;
}

const ALL_SCOPE: ResolvedScope = { folderIds: null, scopeKey: 'all' };

export function currentScopeKey(folderId: string | null): string {
	return folderId ? `current:${folderId}` : ALL_SCOPE.scopeKey;
}

export class NoteScopeResolver {
	public constructor(private readonly folderRepository = new FolderRepository()) {}

	public async resolve(settings: ScopeSettings): Promise<ResolvedScope> {
		if (settings.mode === 'all') {
			return ALL_SCOPE;
		}

		const { folders, truncated } = await this.folderRepository.getAllFolders();
		if (truncated) {
			console.error(
				'Note Graph scope: notebook list is incomplete; some notebooks may be missing from the scope.'
			);
		}

		if (settings.mode === 'current') {
			return this.resolveCurrent(folders);
		}
		return this.resolveSelected(folders, settings.selectedNotebookIds);
	}

	private async resolveCurrent(folders: Folder[]): Promise<ResolvedScope> {
		const current = await joplin.workspace.selectedFolder().catch(() => null);
		if (!current) {
			console.info(
				'Note Graph scope: "current notebook" is selected but no notebook is open; showing all notebooks instead.'
			);
			return ALL_SCOPE;
		}

		const folderIds = this.expandSubtree(folders, [current.id]);
		return { folderIds, scopeKey: currentScopeKey(current.id) };
	}

	private resolveSelected(folders: Folder[], ids: string[]): ResolvedScope {
		const wantedIds = new Set(ids);
		const roots = folders.filter((f) => wantedIds.has(f.id));

		if (roots.length === 0) {
			console.info(
				'Note Graph scope: none of the selected notebook IDs matched an existing notebook; showing all notebooks instead.'
			);
			return ALL_SCOPE;
		}

		const folderIds = this.expandSubtree(
			folders,
			roots.map((f) => f.id)
		);
		const scopeKey = `selected:${Array.from(folderIds).sort().join(',')}`;
		return { folderIds, scopeKey };
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
