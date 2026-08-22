import joplin from 'api';
import { ViewHandle } from 'api/types';
import { renderPanelHtml } from './App';
import { GraphData } from '../services/graph/types';
import { GraphDiff } from '../services/graph/GraphDiffer';

export interface ScopeState {
	mode: 'all' | 'current' | 'selected';
	selectedNotebookIds: string[];
}

export interface NotebookOption {
	id: string;
	title: string;
}

const PANEL_ID = 'aiNoteGraphPanel';
const PANEL_HTML = renderPanelHtml();
const PANEL_SCRIPTS = ['./ui/styles/panel.css', './ui/setup.js', './ui/graph-view.js'];

interface ProgressState {
	stage: 'progress' | 'enrichment-progress';
	current: number;
	total: number;
}

let panelHandle: ViewHandle;
let currentGraphData: GraphData | null = null;
let currentVersion = 0;
let currentProgress: ProgressState | null = null;
let queuedFocusNoteId: string | null = null;

const createPanel = async (
	onNoData: () => void,
	onCancel: () => void,
	onRequestFolders: () => Promise<NotebookOption[]>,
	onGetScopeState: () => Promise<ScopeState>,
	onSetScope: (mode: ScopeState['mode'], selectedNotebookIds: string[]) => Promise<void>
): Promise<ViewHandle> => {
	const handle = await joplin.views.panels.create(PANEL_ID);
	await joplin.views.panels.setHtml(handle, PANEL_HTML);
	await joplin.views.panels.onMessage(
		handle,
		async (message: {
			type?: string;
			nodeId?: string;
			nodeLabel?: string;
			version?: number;
			mode?: ScopeState['mode'];
			selectedIds?: string[];
		}) => {
			if (message?.type === 'close-note-graph') {
				await joplin.views.panels.hide(handle);
				return { done: true };
			}
			if (message?.type === 'cancel-analysis') {
				onCancel();
				return { done: true };
			}
			if (message?.type === 'request-data') {
				if (!currentGraphData) {
					if (await joplin.views.panels.visible(handle)) {
						onNoData();
					}
					return { type: 'no-data', progress: currentProgress };
				}
				if (message.version === currentVersion) {
					return { type: 'no-change', progress: currentProgress };
				}
				const focusNoteId = queuedFocusNoteId;
				queuedFocusNoteId = null;
				return {
					type: 'graph-data',
					...currentGraphData,
					version: currentVersion,
					progress: currentProgress,
					focusNoteId,
				};
			}
			if (message?.type === 'node-clicked' && message?.nodeId) {
				try {
					await joplin.commands.execute('openNote', message.nodeId);
				} catch {
					await joplin.commands.execute('openItem', message.nodeId);
				}
				return { done: true };
			}
			if (message?.type === 'request-folders') {
				return { type: 'folders', folders: await onRequestFolders() };
			}
			if (message?.type === 'get-scope-state') {
				return await onGetScopeState();
			}
			if (message?.type === 'set-scope' && message.mode) {
				await onSetScope(message.mode, message.selectedIds ?? []);
				return { done: true };
			}
		}
	);

	for (const scriptPath of PANEL_SCRIPTS) {
		await joplin.views.panels.addScript(handle, scriptPath);
	}

	return handle;
};

const getPanel = (): ViewHandle => {
	if (!panelHandle) {
		throw new Error('Note Graph panel not initialized');
	}

	return panelHandle;
};

/**
 * Initializes the note graph panel. Safe to call multiple times (no-op after first).
 */
export const initializeAiNoteGraphPanel = async (
	onNoData: () => void,
	onCancel: () => void,
	onRequestFolders: () => Promise<NotebookOption[]>,
	onGetScopeState: () => Promise<ScopeState>,
	onSetScope: (mode: ScopeState['mode'], selectedNotebookIds: string[]) => Promise<void>
): Promise<void> => {
	if (panelHandle) {
		return;
	}
	panelHandle = await createPanel(
		onNoData,
		onCancel,
		onRequestFolders,
		onGetScopeState,
		onSetScope
	);
};

/**
 * Shows the note graph panel in the Joplin UI.
 */
export const showAiNoteGraphPanel = async (): Promise<void> => {
	const handle = getPanel();
	await joplin.views.panels.show(handle);
};

export const postFocusNote = async (noteId: string | null): Promise<void> => {
	queuedFocusNoteId = noteId;
	if (!panelHandle) return;
	await joplin.views.panels.postMessage(panelHandle, { type: 'focus-note', noteId });
};

export const isNoteGraphPanelVisible = async (): Promise<boolean> => {
	if (!panelHandle) return false;
	return joplin.views.panels.visible(panelHandle);
};

/**
 * Stores graph data and pushes it to the panel if already shown.
 * On first call the panel requests the data on load; subsequent calls push proactively.
 * @param graphData - the graph nodes and edges to display.
 */
export const postGraphData = async (graphData: GraphData): Promise<void> => {
	const hadData = currentGraphData !== null;
	currentGraphData = graphData;
	currentVersion++;
	currentProgress = null;

	if (hadData) {
		const handle = getPanel();
		await joplin.views.panels.postMessage(handle, {
			type: 'graph-data',
			...graphData,
			version: currentVersion,
		});
	}
};

export const postGraphPatch = async (diff: GraphDiff, fullGraphData: GraphData): Promise<void> => {
	const hadData = currentGraphData !== null;
	currentGraphData = fullGraphData;
	currentVersion++;
	currentProgress = null;

	if (hadData) {
		const handle = getPanel();
		await joplin.views.panels.postMessage(handle, {
			type: 'graph-patch',
			...diff,
			version: currentVersion,
		});
	}
};

/** Pushes a one-line status message to the panel (e.g. a fallback notice). */
export const postStatus = async (text: string): Promise<void> => {
	currentProgress = null;
	const handle = getPanel();
	await joplin.views.panels.postMessage(handle, { type: 'status', text });
};

/** Sets the embedding progress and pushes it to the panel immediately. */
export const postProgress = async (current: number, total: number): Promise<void> => {
	currentProgress = { stage: 'progress', current, total };
	const handle = getPanel();
	await joplin.views.panels.postMessage(handle, { type: 'progress', stage: 'progress', current, total });
};

/** Sets the LLM enrichment progress and pushes it to the panel immediately. */
export const postEnrichmentProgress = async (current: number, total: number): Promise<void> => {
	currentProgress = current >= total ? null : { stage: 'enrichment-progress', current, total };
	const handle = getPanel();
	await joplin.views.panels.postMessage(handle, {
		type: 'progress',
		stage: 'enrichment-progress',
		current,
		total,
	});
};
