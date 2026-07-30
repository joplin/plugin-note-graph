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
	let onMessageHandler: (message: { type?: string; version?: number }) => Promise<unknown>;

	beforeEach(async () => {
		jest.resetModules();

		let freshJoplin: {
			views: { panels: { create: jest.Mock; onMessage: jest.Mock; postMessage: jest.Mock } };
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

		mockPanelsCreate.mockResolvedValue('panel-handle');
		mockOnMessage.mockImplementation((_handle: unknown, handler: typeof onMessageHandler) => {
			onMessageHandler = handler;
			return Promise.resolve();
		});

		await webview.initializeAiNoteGraphPanel();
	});

	it('replies no-data to request-data before any graph has been loaded', async () => {
		const response = await onMessageHandler({ type: 'request-data', version: 0 });
		expect(response).toEqual({ type: 'no-data' });
	});

	it('replies with the full graph, including the version field, when the requester is behind', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 0 });

		expect(response).toEqual({ type: 'graph-data', nodes: [], edges: [], version: 1 });
	});

	it('replies no-change instead of re-sending the graph when the requester is already current', async () => {
		await webview.postGraphData({ nodes: [], edges: [] });

		const response = await onMessageHandler({ type: 'request-data', version: 1 });

		expect(response).toEqual({ type: 'no-change' });
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
});
