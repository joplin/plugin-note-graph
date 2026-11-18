import joplin from 'api';
import { ButtonSpec, DialogResult, ViewHandle } from 'api/types';
import { renderPanelHtml } from './App';
import { GraphData } from '../services/graph/types';
import { GraphDiff } from '../services/graph/GraphDiffer';
import { GraphViewRequest, NoteSearchResult } from '../services/graph/GraphViewBuilder';
import { LayoutName } from '../services/graph/GraphLayoutEngine';
import { StatusAction, StatusReport } from '../services/status/StatusReport';
import { Logger } from '../utils/Logger';

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

/** How a viewer chose to see the graph. The plugin keeps them, so the panel and popup always agree. */
export interface ViewChoices {
	colorBy: string;
	hiddenEdgeTypes: string[];
	minSimilarity: number;
}

export type PanelStatusAction = StatusAction | 'clear-problems';

const PANEL_STATUS_ACTIONS: readonly PanelStatusAction[] = [
	'reload-notes',
	'retry-ai',
	'retry-labels',
	'clear-problems',
];

const PANEL_ID = 'aiNoteGraphPanel';
const POPUP_ID = 'aiNoteGraphPopup';
/** The graph's own ✕ and Escape close the popup, so it needs none of Joplin's dialog buttons. */
const POPUP_BUTTONS: ButtonSpec[] = [];
/** `openItem` also opens links, so the panel may only ever ask for a Joplin item ID. */
const JOPLIN_ID_PATTERN = /^[0-9a-f]{32}$/i;
const PANEL_HTML = renderPanelHtml();
const PANEL_SCRIPTS = ['./ui/styles/panel.css', './ui/setup.js', './ui/graph-view.js'];
/** The popup's empty button bar sits in Joplin's own window, outside the graph page, so the style hiding it loads there. */
const POPUP_CHROME_CSS = 'ui/styles/popup-chrome.css';

interface ProgressState {
	stage: 'progress' | 'enrichment-progress';
	current: number;
	total: number;
}

let logger: Logger;
let panelHandle: ViewHandle;
/** Undefined if the popup couldn't be created; the panel works without it. */
let popupHandle: ViewHandle | undefined;
/** The pending `dialogs.open` call, which resolves when the popup closes; null while it is closed. */
let popupSession: Promise<DialogResult> | null = null;
let currentGraphData: GraphData | null = null;
let currentVersion = 0;
let currentProgress: ProgressState | null = null;
/** Each view gets the open note once, with its next graph, so one view can't take it from the other. */
const queuedFocusNoteIds = new Map<ViewHandle, string | null>();
let currentNotice: string | undefined;
let viewChoices: ViewChoices | undefined;

/** Dialogs have no message API of their own; Joplin routes `panels` messaging by handle, so it serves both views. */
const listenToGraphView = async (handle: ViewHandle, handlers: PanelHandlers): Promise<void> => {
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
			choices?: ViewChoices;
		}) => {
			const escapesPopup = message?.type === 'escape-pressed' && handle === popupHandle;
			if (message?.type === 'close-note-graph' || escapesPopup) {
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
					return {
						type: 'no-data',
						progress: currentProgress,
						notice: currentNotice,
						choices: viewChoices,
					};
				}
				if (message.version === currentVersion) {
					return {
						type: 'no-change',
						progress: currentProgress,
						notice: currentNotice,
						choices: viewChoices,
					};
				}
				const focusNoteId = queuedFocusNoteIds.get(handle) ?? null;
				queuedFocusNoteIds.delete(handle);
				return {
					type: 'graph-data',
					...currentGraphData,
					version: currentVersion,
					progress: currentProgress,
					notice: currentNotice,
					choices: viewChoices,
					focusNoteId,
				};
			}
			if (message?.type === 'set-view-choices' && message.choices) {
				viewChoices = message.choices;
				await postToGraphViews({ type: 'view-choices', choices: viewChoices });
				return { done: true };
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
};

const createPanel = async (handlers: PanelHandlers): Promise<ViewHandle> => {
	const handle = await joplin.views.panels.create(PANEL_ID);
	await joplin.views.panels.setHtml(handle, PANEL_HTML);
	await listenToGraphView(handle, handlers);
	for (const scriptPath of PANEL_SCRIPTS) {
		await joplin.views.panels.addScript(handle, scriptPath);
	}
	return handle;
};

const createPopup = async (handlers: PanelHandlers): Promise<ViewHandle> => {
	const handle = await joplin.views.dialogs.create(POPUP_ID);
	await joplin.views.dialogs.setHtml(handle, PANEL_HTML);
	await joplin.views.dialogs.setButtons(handle, POPUP_BUTTONS);
	await joplin.views.dialogs.setFitToContent(handle, false);
	await joplin.window.loadChromeCssFile(`${await joplin.plugins.installationDir()}/${POPUP_CHROME_CSS}`);
	await listenToGraphView(handle, handlers);
	for (const scriptPath of PANEL_SCRIPTS) {
		await joplin.views.dialogs.addScript(handle, scriptPath);
	}
	return handle;
};

const getPanel = (): ViewHandle => {
	if (!panelHandle) {
		throw new Error('Note Graph panel not initialized');
	}

	return panelHandle;
};

/** Every update goes to the panel, and to the popup while it is open. */
const postToGraphViews = async (message: object): Promise<void> => {
	await joplin.views.panels.postMessage(getPanel(), message);
	if (popupHandle && isNoteGraphPopupOpen()) {
		await joplin.views.panels.postMessage(popupHandle, message);
	}
};

/**
 * Creates the note graph panel and popup. Safe to call multiple times (no-op after first).
 * A popup that fails to set up is logged and left out, so the panel still works.
 */
export const initializeNoteGraphViews = async (
	viewLogger: Logger,
	handlers: PanelHandlers
): Promise<void> => {
	if (panelHandle) {
		return;
	}
	logger = viewLogger;
	panelHandle = await createPanel(handlers);
	try {
		popupHandle = await createPopup(handlers);
	} catch (error) {
		logger.error('Failed to set up the note graph popup; the side panel still works:', error);
	}
};

/**
 * Shows the note graph panel in the Joplin UI.
 */
export const showAiNoteGraphPanel = async (): Promise<void> => {
	const handle = getPanel();
	await joplin.views.panels.show(handle);
};

/**
 * Opens the graph popup over Joplin, side panel included. Returns once it is open, not when it
 * closes; its ✕ and Escape close it.
 */
export const openNoteGraphPopup = async (): Promise<void> => {
	if (!popupHandle) throw new Error('The note graph popup is not available');
	const session = joplin.views.dialogs.open(popupHandle);
	popupSession = session;
	const endSession = () => {
		if (popupSession === session) popupSession = null;
	};
	session.then(endSession, (error) => {
		endSession();
		logger.error('The note graph popup failed:', error);
	});
};

const isNoteGraphPopupOpen = (): boolean => popupSession !== null;

export const postFocusNote = async (noteId: string | null): Promise<void> => {
	if (!panelHandle) return;
	for (const handle of [panelHandle, popupHandle]) {
		if (handle) queuedFocusNoteIds.set(handle, noteId);
	}
	await postToGraphViews({ type: 'focus-note', noteId });
};

export const isNoteGraphVisible = async (): Promise<boolean> => {
	if (!panelHandle) return false;
	return isNoteGraphPopupOpen() || joplin.views.panels.visible(panelHandle);
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
		await postToGraphViews({
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
		await postToGraphViews({
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

export type StatusIcon = 'notice' | 'cancelled';

/** Pushes a one-line status message to the panel (e.g. a fallback notice). */
export const postStatus = async (text: string, icon: StatusIcon = 'notice'): Promise<void> => {
	currentProgress = null;
	await postToGraphViews({ type: 'status', text, icon });
};

/** Sets the embedding progress and pushes it to the panel immediately. */
export const postProgress = async (current: number, total: number): Promise<void> => {
	currentProgress = { stage: 'progress', current, total };
	await postToGraphViews({ type: 'progress', stage: 'progress', current, total });
};

/** Sets the LLM enrichment progress and pushes it to the panel immediately. */
export const postEnrichmentProgress = async (current: number, total: number): Promise<void> => {
	currentProgress = current >= total ? null : { stage: 'enrichment-progress', current, total };
	await postToGraphViews({
		type: 'progress',
		stage: 'enrichment-progress',
		current,
		total,
	});
};
