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
	let mockPanelsVisible: jest.Mock;
	let onNoData: jest.Mock;
	let onMessageHandler: (message: { type?: string; version?: number }) => Promise<unknown>;

	beforeEach(async () => {
		jest.resetModules();

		let freshJoplin: {
			views: {
				panels: { create: jest.Mock; onMessage: jest.Mock; postMessage: jest.Mock; visible: jest.Mock };
			};
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
		mockPanelsVisible = freshJoplin!.views.panels.visible;

		mockPanelsCreate.mockResolvedValue('panel-handle');
		mockPanelsVisible.mockResolvedValue(false);
		mockOnMessage.mockImplementation((_handle: unknown, handler: typeof onMessageHandler) => {
			onMessageHandler = handler;
			return Promise.resolve();
		});

		onNoData = jest.fn();
		await webview.initializeAiNoteGraphPanel(onNoData);
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

		expect(response).toEqual({ type: 'graph-data', nodes: [], edges: [], version: 1, progress: null });
	});

	it('replies no-change instead of re-sending the graph when the requester is already current', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toEqual({ type: 'no-change', progress: null });
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

		await expect(webview.postGraphPatch(emptyDiff, { nodes: [], edges: [] })).rejects.toThrow('panel gone');
	});
});
