import joplin from 'api';
import { ViewHandle } from 'api/types';
import { renderPanelHtml } from './App';
import { GraphData } from '../services/graph/types';
import { GraphDiff } from '../services/graph/GraphDiffer';
import { GraphViewRequest, NoteSearchResult } from '../services/graph/GraphViewBuilder';
import { LayoutName } from '../services/graph/GraphLayoutEngine';
import { StatusAction, StatusReport } from '../services/status/StatusReport';

export interface ScopeState {
	mode: 'all' | 'current' | 'selected';
	selectedNotebookIds: string[];
}

export interface NotebookOption {
	id: string;
	title: string;
	parentId: string;
}

export interface PanelHandlers {
	onNoData: () => void;
	onCancel: () => void;
	onRequestFolders: () => Promise<NotebookOption[]>;
	onGetScopeState: () => Promise<ScopeState>;
	onSetScope: (mode: ScopeState['mode'], selectedNotebookIds: string[]) => Promise<void>;
	onOpenView: (request: GraphViewRequest) => Promise<void>;
	onSetLayout: (layout: LayoutName, grouped: boolean) => Promise<void>;
	onSetTagFilter: (tag: string | null) => Promise<void>;
	onSearchNotes: (query: string) => NoteSearchResult[];
	onGetStatus: () => Promise<StatusReport>;
	onStatusAction: (action: PanelStatusAction) => Promise<void>;
}

export type PanelStatusAction = StatusAction | 'clear-problems';

const PANEL_STATUS_ACTIONS: readonly PanelStatusAction[] = [
	'reload-notes',
	'retry-ai',
	'retry-labels',
	'clear-problems',
];

const PANEL_ID = 'aiNoteGraphPanel';
/** `openItem` also opens links, so the panel may only ever ask for a Joplin item ID. */
const JOPLIN_ID_PATTERN = /^[0-9a-f]{32}$/i;
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
let currentNotice: string | undefined;

const createPanel = async (handlers: PanelHandlers): Promise<ViewHandle> => {
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
			request?: GraphViewRequest;
			layout?: LayoutName;
			grouped?: boolean;
			query?: string;
			tag?: string | null;
			action?: string;
		}) => {
			if (message?.type === 'close-note-graph') {
				await joplin.views.panels.hide(handle);
				return { done: true };
			}
			if (message?.type === 'cancel-analysis') {
				handlers.onCancel();
				return { done: true };
			}
			if (message?.type === 'request-data') {
				if (!currentGraphData) {
					if (await joplin.views.panels.visible(handle)) {
						handlers.onNoData();
					}
					return { type: 'no-data', progress: currentProgress, notice: currentNotice };
				}
				if (message.version === currentVersion) {
					return { type: 'no-change', progress: currentProgress, notice: currentNotice };
				}
				const focusNoteId = queuedFocusNoteId;
				queuedFocusNoteId = null;
				return {
					type: 'graph-data',
					...currentGraphData,
					version: currentVersion,
					progress: currentProgress,
					notice: currentNotice,
					focusNoteId,
				};
			}
			if (message?.type === 'node-clicked' && message?.nodeId) {
				if (!JOPLIN_ID_PATTERN.test(message.nodeId)) return { done: false };
				try {
					await joplin.commands.execute('openNote', message.nodeId);
				} catch {
					await joplin.commands.execute('openItem', message.nodeId);
				}
				return { done: true };
			}
			if (message?.type === 'request-folders') {
				return { type: 'folders', folders: await handlers.onRequestFolders() };
			}
			if (message?.type === 'get-scope-state') {
				return await handlers.onGetScopeState();
			}
			if (message?.type === 'set-scope' && message.mode) {
				await handlers.onSetScope(message.mode, message.selectedIds ?? []);
				return { done: true };
			}
			if (message?.type === 'open-view' && message.request) {
				await handlers.onOpenView(message.request);
				return { done: true };
			}
			if (message?.type === 'set-layout' && message.layout) {
				await handlers.onSetLayout(message.layout, !!message.grouped);
				return { done: true };
			}
			if (message?.type === 'set-tag-filter') {
				await handlers.onSetTagFilter(message.tag || null);
				return { done: true };
			}
			if (message?.type === 'search-notes') {
				return {
					type: 'search-results',
					results: handlers.onSearchNotes(message.query ?? ''),
				};
			}
			if (message?.type === 'get-status') {
				return { type: 'status-report', report: await handlers.onGetStatus() };
			}
			if (
				message?.type === 'status-action' &&
				PANEL_STATUS_ACTIONS.includes(message.action as PanelStatusAction)
			) {
				await handlers.onStatusAction(message.action as PanelStatusAction);
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
export const initializeAiNoteGraphPanel = async (handlers: PanelHandlers): Promise<void> => {
	if (panelHandle) {
		return;
	}
	panelHandle = await createPanel(handlers);
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
	const { nodes: _nodes, edges: _edges, ...viewDetails } = fullGraphData;
	currentGraphData = fullGraphData;
	currentVersion++;
	currentProgress = null;

	if (hadData) {
		const handle = getPanel();
		await joplin.views.panels.postMessage(handle, {
			type: 'graph-patch',
			...viewDetails,
			...diff,
			version: currentVersion,
		});
	}
};

/** Sets a message that stays visible until cleared, unlike `postStatus`, which the next render replaces. The panel picks it up on its next poll. */
export const setGraphNotice = (text: string | null): void => {
	currentNotice = text ?? undefined;
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
