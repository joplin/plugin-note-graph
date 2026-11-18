import { GraphDiff } from '../services/graph/GraphDiffer';

const emptyDiff: GraphDiff = {
	upsertedNodes: [],
	upsertedEdges: [],
	removedNodeIds: [],
	removedEdgeIds: [],
};

describe('webview', () => {
	let webview: typeof import('./webview');
	let mockPanelsCreate: jest.Mock;
	let mockOnMessage: jest.Mock;
	let mockPostMessage: jest.Mock;
	let mockPanelsShow: jest.Mock;
	let mockPanelsVisible: jest.Mock;
	let mockPanelsHide: jest.Mock;
	let mockDialogs: Record<
		'create' | 'setHtml' | 'setButtons' | 'setFitToContent' | 'addScript' | 'open',
		jest.Mock
	>;
	let mockLoadChromeCssFile: jest.Mock;
	let closePopup: () => void;
	let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
	let handlers: Parameters<typeof import('./webview').initializeNoteGraphViews>[1];
	let onNoData: jest.Mock;
	let onCancel: jest.Mock;
	let onRequestFolders: jest.Mock;
	let onGetScopeState: jest.Mock;
	let onSetScope: jest.Mock;
	let onOpenView: jest.Mock;
	let onSetLayout: jest.Mock;
	let onSetTagFilter: jest.Mock;
	let onSearchNotes: jest.Mock;
	let onGetStatus: jest.Mock;
	let onStatusAction: jest.Mock;
	let mockExecute: jest.Mock;
	let onMessageHandler: (message: {
		type?: string;
		version?: number;
		mode?: string;
		selectedIds?: string[];
		request?: { kind: string; noteId?: string };
		tag?: string | null;
		layout?: string;
		grouped?: boolean;
		query?: string;
		action?: string;
		nodeId?: string;
		choices?: { colorBy: string; hiddenEdgeTypes: string[]; minSimilarity: number };
	}) => Promise<unknown>;
	let messageHandlers: Record<string, typeof onMessageHandler>;

	beforeEach(async () => {
		jest.resetModules();

		let freshJoplin: {
			views: {
				panels: {
					create: jest.Mock;
					onMessage: jest.Mock;
					postMessage: jest.Mock;
					show: jest.Mock;
					hide: jest.Mock;
					visible: jest.Mock;
				};
				dialogs: typeof mockDialogs;
			};
			plugins: { installationDir: jest.Mock };
			window: { loadChromeCssFile: jest.Mock };
		};
		jest.isolateModules(() => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			freshJoplin = require('api').default;
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			webview = require('./webview');
		});

		mockPanelsCreate = freshJoplin!.views.panels.create;
		mockOnMessage = freshJoplin!.views.panels.onMessage;
		mockPostMessage = freshJoplin!.views.panels.postMessage;
		mockPanelsShow = freshJoplin!.views.panels.show;
		mockPanelsVisible = freshJoplin!.views.panels.visible;
		mockPanelsHide = freshJoplin!.views.panels.hide;
		mockDialogs = freshJoplin!.views.dialogs;
		mockLoadChromeCssFile = freshJoplin!.window.loadChromeCssFile;
		freshJoplin!.plugins.installationDir.mockResolvedValue('/plugin-dir');
		mockExecute = (freshJoplin! as unknown as { commands: { execute: jest.Mock } }).commands
			.execute;
		mockExecute.mockReset();

		mockPanelsCreate.mockResolvedValue('panel-handle');
		mockPanelsVisible.mockResolvedValue(false);
		messageHandlers = {};
		mockOnMessage.mockImplementation((handle: string, handler: typeof onMessageHandler) => {
			messageHandlers[handle] = handler;
			return Promise.resolve();
		});
		mockDialogs.create.mockResolvedValue('popup-handle');
		mockDialogs.open.mockImplementation(
			() => new Promise((resolve) => (closePopup = () => resolve({ id: 'cancel' })))
		);

		onNoData = jest.fn();
		onCancel = jest.fn();
		onRequestFolders = jest.fn().mockResolvedValue([]);
		onGetScopeState = jest.fn().mockResolvedValue({ mode: 'all', selectedNotebookIds: [] });
		onSetScope = jest.fn().mockResolvedValue(undefined);
		onOpenView = jest.fn().mockResolvedValue(undefined);
		onSetLayout = jest.fn().mockResolvedValue(undefined);
		onSetTagFilter = jest.fn().mockResolvedValue(undefined);
		onSearchNotes = jest.fn().mockReturnValue([]);
		onGetStatus = jest.fn().mockResolvedValue({ level: 'ok', items: [], problems: [] });
		onStatusAction = jest.fn().mockResolvedValue(undefined);
		handlers = {
			onNoData,
			onCancel,
			onRequestFolders,
			onGetScopeState,
			onSetScope,
			onOpenView,
			onSetLayout,
			onSetTagFilter,
			onSearchNotes,
			onGetStatus,
			onStatusAction,
		};
		mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
		await webview.initializeNoteGraphViews(mockLogger, handlers);
		onMessageHandler = messageHandlers['panel-handle'];
	});

	describe('node-clicked', () => {
		const NOTE_ID = '0123456789abcdef0123456789abcdef';

		it('opens the clicked note', async () => {
			await onMessageHandler({ type: 'node-clicked', nodeId: NOTE_ID });

			expect(mockExecute).toHaveBeenCalledWith('openNote', NOTE_ID);
		});

		it('falls back to openItem when openNote fails', async () => {
			mockExecute.mockRejectedValueOnce(new Error('no such command'));

			await onMessageHandler({ type: 'node-clicked', nodeId: NOTE_ID });

			expect(mockExecute).toHaveBeenLastCalledWith('openItem', NOTE_ID);
		});

		it('ignores anything that is not a note ID, so the panel cannot open a link', async () => {
			mockExecute.mockRejectedValue(new Error('no such note'));

			const response = await onMessageHandler({
				type: 'node-clicked',
				nodeId: 'https://example.com',
			});

			expect(mockExecute).not.toHaveBeenCalled();
			expect(response).toEqual({ done: false });
		});
	});

	it('calls onCancel and acknowledges a cancel-analysis message', async () => {
		const response = await onMessageHandler({ type: 'cancel-analysis' });

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(response).toEqual({ done: true });
	});

	it('replies no-data to request-data before any graph has been loaded', async () => {
		const response = await onMessageHandler({ type: 'request-data', version: 0 });
		expect(response).toEqual({ type: 'no-data', progress: null });
	});

	it('calls onNoData when a poll finds no data and the panel is already visible', async () => {
		mockPanelsVisible.mockResolvedValue(true);

		await onMessageHandler({ type: 'request-data', version: 0 });

		expect(onNoData).toHaveBeenCalledTimes(1);
	});

	it('does not call onNoData when a poll finds no data but the panel is not visible', async () => {
		mockPanelsVisible.mockResolvedValue(false);

		await onMessageHandler({ type: 'request-data', version: 0 });

		expect(onNoData).not.toHaveBeenCalled();
	});

	it('does not call onNoData once a graph has already been loaded', async () => {
		mockPanelsVisible.mockResolvedValue(true);
		await webview.postGraphData({ nodes: [], edges: [] });

		await onMessageHandler({ type: 'request-data', version: 1 });

		expect(onNoData).not.toHaveBeenCalled();
	});

	it('replies with the full graph, including the version field, when the requester is behind', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 0 });

		expect(response).toEqual({
			type: 'graph-data',
			nodes: [],
			edges: [],
			version: 1,
			progress: null,
			focusNoteId: null,
		});
	});

	it('replies no-change instead of re-sending the graph when the requester is already current', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toEqual({ type: 'no-change', progress: null });
	});

	describe('view requests from the panel', () => {
		it('opens the requested view', async () => {
			const request = { kind: 'neighborhood', noteId: 'note-1' };

			await expect(onMessageHandler({ type: 'open-view', request })).resolves.toEqual({ done: true });

			expect(onOpenView).toHaveBeenCalledWith(request);
		});

		it('changes the layout', async () => {
			await onMessageHandler({ type: 'set-layout', layout: 'hierarchical', grouped: true });

			expect(onSetLayout).toHaveBeenCalledWith('hierarchical', true);
		});

		it('sets a tag filter, and treats the empty choice as none', async () => {
			await onMessageHandler({ type: 'set-tag-filter', tag: 'work' });
			expect(onSetTagFilter).toHaveBeenLastCalledWith('work');

			await onMessageHandler({ type: 'set-tag-filter', tag: '' });
			expect(onSetTagFilter).toHaveBeenLastCalledWith(null);
		});

		it('answers a search across all notes', async () => {
			onSearchNotes.mockReturnValue([{ noteId: 'n1', label: 'Found' }]);

			const response = await onMessageHandler({ type: 'search-notes', query: 'fou' });

			expect(onSearchNotes).toHaveBeenCalledWith('fou');
			expect(response).toEqual({
				type: 'search-results',
				results: [{ noteId: 'n1', label: 'Found' }],
			});
		});
	});

	describe('status messages', () => {
		it('answers get-status with the status report', async () => {
			const response = await onMessageHandler({ type: 'get-status' });

			expect(response).toEqual({
				type: 'status-report',
				report: { level: 'ok', items: [], problems: [] },
			});
		});

		it('runs a known status action', async () => {
			const response = await onMessageHandler({ type: 'status-action', action: 'retry-ai' });

			expect(onStatusAction).toHaveBeenCalledWith('retry-ai');
			expect(response).toEqual({ done: true });
		});

		it('ignores an unknown status action', async () => {
			await onMessageHandler({ type: 'status-action', action: 'delete-everything' });

			expect(onStatusAction).not.toHaveBeenCalled();
		});
	});

	it('sends view details with a patch, so the panel can update its totals', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		const graph = { nodes: [], edges: [], view: { key: 'full' } } as never;

		await webview.postGraphPatch(emptyDiff, graph);

		expect(mockPostMessage).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ type: 'graph-patch', view: { key: 'full' } })
		);
	});

	describe('setGraphNotice', () => {
		it('includes the notice in a no-data reply', async () => {
			webview.setGraphNotice('Incomplete');

			const response = await onMessageHandler({ type: 'request-data', version: 0 });

			expect(response).toEqual({ type: 'no-data', progress: null, notice: 'Incomplete' });
		});

		it('includes the notice in a no-change reply', async () => {
			await webview.postGraphData({ nodes: [], edges: [] });
			webview.setGraphNotice('Incomplete');

			const response = await onMessageHandler({ type: 'request-data', version: 1 });

			expect(response).toEqual({ type: 'no-change', progress: null, notice: 'Incomplete' });
		});

		it('includes the notice alongside graph data', async () => {
			await webview.postGraphData({ nodes: [], edges: [] });
			webview.setGraphNotice('Incomplete');

			const response = await onMessageHandler({ type: 'request-data', version: 0 });

			expect(response).toMatchObject({ type: 'graph-data', notice: 'Incomplete' });
		});

		it('omits the notice once it is cleared', async () => {
			webview.setGraphNotice('Incomplete');
			webview.setGraphNotice(null);

			const response = await onMessageHandler({ type: 'request-data', version: 0 });

			expect(response).toEqual({ type: 'no-data', progress: null });
		});
	});

	it('delivers a queued focus note with the next graph response, then clears it', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postFocusNote('note-1');

		const first = await onMessageHandler({ type: 'request-data', version: 0 });
		const second = await onMessageHandler({ type: 'request-data', version: 0 });

		expect(first).toEqual({
			type: 'graph-data',
			nodes: [],
			edges: [],
			version: 1,
			progress: null,
			focusNoteId: 'note-1',
		});
		expect(second).toEqual({
			type: 'graph-data',
			nodes: [],
			edges: [],
			version: 1,
			progress: null,
			focusNoteId: null,
		});
	});

	it('surfaces embedding progress on the next poll response, regardless of graph version', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postProgress(3, 10);

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toEqual({
			type: 'no-change',
			progress: { stage: 'progress', current: 3, total: 10 },
		});
	});

	it('surfaces enrichment progress on the next poll response', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postEnrichmentProgress(1, 4);

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toEqual({
			type: 'no-change',
			progress: { stage: 'enrichment-progress', current: 1, total: 4 },
		});
	});

	it('clears progress once enrichment progress reaches its total', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postEnrichmentProgress(4, 4);

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toMatchObject({ progress: null });
	});

	it('clears progress once a fresh graph is posted', async () => {
		await webview.postProgress(3, 10);
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 0 });

		expect(response).toMatchObject({ progress: null });
	});

	it('clears progress once a status message is posted', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postProgress(3, 10);
		await webview.postStatus('AI analysis unavailable - showing structural graph.');

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toMatchObject({ progress: null });
	});

	it('tells the panel which icon goes with a status message', async () => {
		await webview.postStatus('Analysis cancelled.', 'cancelled');

		expect(mockPostMessage).toHaveBeenLastCalledWith(expect.anything(), {
			type: 'status',
			text: 'Analysis cancelled.',
			icon: 'cancelled',
		});
	});

	it('keeps postGraphData and postGraphPatch on one shared, contiguous version counter', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		await webview.postGraphPatch(emptyDiff, { nodes: [], edges: [] });
		await webview.postGraphData({ nodes: [], edges: [] });

		const pushedVersions = mockPostMessage.mock.calls.map(
			([, message]: [unknown, { version: number }]) => message.version
		);

		expect(pushedVersions).toEqual([2, 3]);
	});

	it('propagates a postMessage rejection from postGraphData so callers can catch it', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		mockPostMessage.mockRejectedValueOnce(new Error('panel gone'));

		await expect(webview.postGraphData({ nodes: [], edges: [] })).rejects.toThrow('panel gone');
	});

	it('propagates a postMessage rejection from postGraphPatch so callers can catch it', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });
		mockPostMessage.mockRejectedValueOnce(new Error('panel gone'));

		await expect(webview.postGraphPatch(emptyDiff, { nodes: [], edges: [] })).rejects.toThrow(
			'panel gone'
		);
	});

	describe('showAiNoteGraphPanel', () => {
		it('shows the panel', async () => {
			await webview.showAiNoteGraphPanel();

			expect(mockPanelsShow).toHaveBeenCalledWith('panel-handle');
		});
	});

	describe('postFocusNote', () => {
		it('posts a focus-note message with the given note id', async () => {
			await webview.postFocusNote('note-1');

			expect(mockPostMessage).toHaveBeenCalledWith('panel-handle', {
				type: 'focus-note',
				noteId: 'note-1',
			});
		});

		it('posts a focus-note message with a null id to clear focus', async () => {
			await webview.postFocusNote(null);

			expect(mockPostMessage).toHaveBeenCalledWith('panel-handle', {
				type: 'focus-note',
				noteId: null,
			});
		});
	});

	describe('isNoteGraphVisible', () => {
		it('reflects the panel visibility check', async () => {
			mockPanelsVisible.mockResolvedValue(true);
			expect(await webview.isNoteGraphVisible()).toBe(true);

			mockPanelsVisible.mockResolvedValue(false);
			expect(await webview.isNoteGraphVisible()).toBe(false);
		});

		it('is true while the popup is open, even with the panel hidden', async () => {
			mockPanelsVisible.mockResolvedValue(false);
			await webview.openNoteGraphPopup();

			expect(await webview.isNoteGraphVisible()).toBe(true);
		});
	});

	describe('view choices', () => {
		const choices = { colorBy: 'community', hiddenEdgeTypes: ['tag'], minSimilarity: 40 };

		it('keeps the choices one view made and passes them to every open view', async () => {
			await webview.openNoteGraphPopup();

			await messageHandlers['popup-handle']({ type: 'set-view-choices', choices });

			const shared = { type: 'view-choices', choices };
			expect(mockPostMessage).toHaveBeenCalledWith('panel-handle', shared);
			expect(mockPostMessage).toHaveBeenCalledWith('popup-handle', shared);
		});

		it('hands them to a view that asks for data, whatever the reply', async () => {
			await onMessageHandler({ type: 'set-view-choices', choices });
			expect(await onMessageHandler({ type: 'request-data', version: 0 })).toEqual(
				expect.objectContaining({ type: 'no-data', choices })
			);

			await webview.postGraphData({ nodes: [], edges: [] });
			expect(await onMessageHandler({ type: 'request-data', version: 0 })).toEqual(
				expect.objectContaining({ type: 'graph-data', choices })
			);
			expect(await onMessageHandler({ type: 'request-data', version: 1 })).toEqual(
				expect.objectContaining({ type: 'no-change', choices })
			);
		});
	});

	describe('focus on the open note', () => {
		it('reaches each view with its next graph, so the panel cannot take the one meant for the popup', async () => {
			await webview.postGraphData({ nodes: [], edges: [] });
			await webview.postFocusNote('note-1');

			const panelReply = await onMessageHandler({ type: 'request-data', version: 0 });
			const popupReply = await messageHandlers['popup-handle']({
				type: 'request-data',
				version: 0,
			});

			expect(panelReply).toEqual(expect.objectContaining({ focusNoteId: 'note-1' }));
			expect(popupReply).toEqual(expect.objectContaining({ focusNoteId: 'note-1' }));
		});
	});

	describe('popup', () => {
		const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

		it('is a large dialog without Joplin buttons, since the graph has its own ✕', () => {
			expect(mockDialogs.setButtons).toHaveBeenCalledWith('popup-handle', []);
			expect(mockDialogs.setFitToContent).toHaveBeenCalledWith('popup-handle', false);
		});

		it("loads the style that hides the empty button bar from the plugin's install folder", () => {
			expect(mockLoadChromeCssFile).toHaveBeenCalledWith(
				'/plugin-dir/ui/styles/popup-chrome.css'
			);
		});

		it('closes on Escape', async () => {
			await messageHandlers['popup-handle']({ type: 'escape-pressed' });

			expect(mockPanelsHide).toHaveBeenCalledWith('popup-handle');
		});

		it('leaves the side panel open on Escape', async () => {
			await messageHandlers['panel-handle']({ type: 'escape-pressed' });

			expect(mockPanelsHide).not.toHaveBeenCalled();
		});

		it('loads the same graph page as the panel', () => {
			expect(mockDialogs.setHtml).toHaveBeenCalledWith('popup-handle', expect.any(String));
			expect(mockDialogs.addScript.mock.calls).toEqual([
				['popup-handle', './ui/styles/panel.css'],
				['popup-handle', './ui/setup.js'],
				['popup-handle', './ui/graph-view.js'],
			]);
			expect(messageHandlers['popup-handle']).toBeDefined();
		});

		it('opens over Joplin and leaves the side panel as it was', async () => {
			await webview.openNoteGraphPopup();

			expect(mockDialogs.open).toHaveBeenCalledWith('popup-handle');
			expect(mockPanelsHide).not.toHaveBeenCalled();
			expect(await webview.isNoteGraphVisible()).toBe(true);
		});

		it('counts as closed once Joplin closes the dialog', async () => {
			await webview.openNoteGraphPopup();

			closePopup();
			await flushPromises();

			expect(await webview.isNoteGraphVisible()).toBe(false);
		});

		it('stays open when an earlier session finishes closing after a reopen', async () => {
			await webview.openNoteGraphPopup();
			const closeFirst = closePopup;
			await webview.openNoteGraphPopup();

			closeFirst();
			await flushPromises();

			expect(await webview.isNoteGraphVisible()).toBe(true);
		});

		it('logs a popup that fails to open, and counts it as closed', async () => {
			mockDialogs.open.mockRejectedValueOnce(new Error('ipc gone'));

			await webview.openNoteGraphPopup();
			await flushPromises();

			expect(mockLogger.error).toHaveBeenCalledWith(
				'The note graph popup failed:',
				expect.any(Error)
			);
			expect(await webview.isNoteGraphVisible()).toBe(false);
		});

		it('logs a popup that cannot be set up, and the panel still works', async () => {
			let fresh!: typeof import('./webview');
			let freshViews!: {
				panels: { create: jest.Mock; show: jest.Mock };
				dialogs: { create: jest.Mock };
			};
			jest.isolateModules(() => {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				freshViews = require('api').default.views;
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				fresh = require('./webview');
			});
			freshViews.panels.create.mockResolvedValue('panel-handle');
			freshViews.dialogs.create.mockRejectedValue(new Error('no dialogs here'));

			await fresh.initializeNoteGraphViews(mockLogger, handlers);

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('popup'),
				expect.any(Error)
			);
			await fresh.showAiNoteGraphPanel();
			expect(freshViews.panels.show).toHaveBeenCalledWith('panel-handle');
			await expect(fresh.openNoteGraphPopup()).rejects.toThrow('not available');
		});

		it('closes with its ✕, like the panel', async () => {
			await messageHandlers['popup-handle']({ type: 'close-note-graph' });

			expect(mockPanelsHide).toHaveBeenCalledWith('popup-handle');
		});

		it('receives updates only while open', async () => {
			await webview.postStatus('Before');
			await webview.openNoteGraphPopup();
			await webview.postStatus('During');

			const popupMessages = mockPostMessage.mock.calls
				.filter(([handle]) => handle === 'popup-handle')
				.map(([, message]) => message.text);
			expect(popupMessages).toEqual(['During']);
		});
	});

	describe('scope messages', () => {
		it('returns the folder list from request-folders', async () => {
			onRequestFolders.mockResolvedValue([{ id: 'id-1', title: 'Work' }]);

			const response = await onMessageHandler({ type: 'request-folders' });

			expect(response).toEqual({
				type: 'folders',
				folders: [{ id: 'id-1', title: 'Work' }],
			});
		});

		it('returns the current scope state from get-scope-state', async () => {
			onGetScopeState.mockResolvedValue({
				mode: 'selected',
				selectedNotebookIds: ['id-1'],
			});

			const response = await onMessageHandler({ type: 'get-scope-state' });

			expect(response).toEqual({ mode: 'selected', selectedNotebookIds: ['id-1'] });
		});

		it('applies a set-scope message via the callback', async () => {
			const response = await onMessageHandler({
				type: 'set-scope',
				mode: 'selected',
				selectedIds: ['id-1', 'id-2'],
			});

			expect(onSetScope).toHaveBeenCalledWith('selected', ['id-1', 'id-2']);
			expect(response).toEqual({ done: true });
		});

		it('defaults selectedIds to an empty array when omitted', async () => {
			await onMessageHandler({ type: 'set-scope', mode: 'all' });

			expect(onSetScope).toHaveBeenCalledWith('all', []);
		});
	});
});
