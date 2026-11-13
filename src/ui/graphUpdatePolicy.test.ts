import {
	ClientPatch,
	DrawnGraph,
	PanelState,
	computeClientPatch,
	dataEqual,
	decideUpdate,
	isOutdated,
	isWholesaleChange,
	needsFullRedraw,
} from './graphUpdatePolicy';

const drawnState = (overrides: Partial<PanelState> = {}): PanelState => ({
	hasRenderedOnce: true,
	lastSeenVersion: 4,
	renderInProgress: false,
	viewKey: 'notebook::a',
	layoutRevision: 2,
	...overrides,
});

const sameView = { view: { key: 'notebook::a' }, layoutRevision: 2 };

function drawnGraph(nodes: Record<string, Record<string, unknown>>, edgeIds: string[] = []): DrawnGraph {
	return {
		nodeIds: Object.keys(nodes),
		edgeIds,
		dataOf: (id) => nodes[id] ?? null,
	};
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({ data: { id, label: id, ...extra } });

describe('graphUpdatePolicy', () => {
	describe('isOutdated', () => {
		it('drops a version the panel has already seen', () => {
			expect(isOutdated(4, drawnState())).toBe(true);
			expect(isOutdated(3, drawnState())).toBe(true);
		});

		it('takes a newer version', () => {
			expect(isOutdated(5, drawnState())).toBe(false);
		});

		it('takes anything before the first graph is drawn', () => {
			expect(isOutdated(0, drawnState({ hasRenderedOnce: false }))).toBe(false);
		});
	});

	describe('decideUpdate', () => {
		it('applies a patch that follows straight on from what is drawn', () => {
			expect(decideUpdate('graph-patch', { version: 5 }, drawnState())).toBe('apply-patch');
		});

		it('skips a patch that jumps over a version, leaving the next poll to fetch the whole graph', () => {
			expect(decideUpdate('graph-patch', { version: 6 }, drawnState())).toBe('skip');
		});

		it('skips a patch before anything is drawn', () => {
			expect(decideUpdate('graph-patch', { version: 1 }, drawnState({ hasRenderedOnce: false }))).toBe(
				'skip'
			);
		});

		it('redraws the first graph', () => {
			expect(
				decideUpdate('graph-data', { version: 1, ...sameView }, drawnState({ hasRenderedOnce: false }))
			).toBe('redraw');
		});

		it('compares a full graph of the same view and layout with what is drawn', () => {
			expect(decideUpdate('graph-data', { version: 5, ...sameView }, drawnState())).toBe('compare');
		});

		it('redraws a full graph of another view', () => {
			expect(
				decideUpdate('graph-data', { version: 5, view: { key: 'notebook::b' }, layoutRevision: 2 }, drawnState())
			).toBe('redraw');
		});
	});

	describe('needsFullRedraw', () => {
		it.each([
			['a draw is still in progress', sameView, { renderInProgress: true }],
			['nothing is drawn yet', sameView, { viewKey: null }],
			['the update has no view', { layoutRevision: 2 }, {}],
			['the view changed', { view: { key: 'other' }, layoutRevision: 2 }, {}],
			['positions were computed from scratch', { view: { key: 'notebook::a' }, layoutRevision: 3 }, {}],
		])('is true when %s', (_name, message, state) => {
			expect(needsFullRedraw(message, drawnState(state))).toBe(true);
		});

		it('is false for the same view and layout', () => {
			expect(needsFullRedraw(sameView, drawnState())).toBe(false);
		});
	});

	describe('dataEqual', () => {
		it('treats an element that is not drawn as changed', () => {
			expect(dataEqual(null, { id: 'a' })).toBe(false);
		});

		it('ignores the community box the panel put a note in', () => {
			expect(dataEqual({ id: 'a', label: 'A', parent: 'community-1' }, { id: 'a', label: 'A' })).toBe(true);
		});

		it('ignores fields that are undefined on either side', () => {
			expect(dataEqual({ id: 'a', category: undefined }, { id: 'a' })).toBe(true);
		});

		it('notices a field that was added, removed or changed', () => {
			expect(dataEqual({ id: 'a' }, { id: 'a', label: 'A' })).toBe(false);
			expect(dataEqual({ id: 'a', label: 'A' }, { id: 'a' })).toBe(false);
			expect(dataEqual({ id: 'a', label: 'A' }, { id: 'a', label: 'B' })).toBe(false);
		});
	});

	describe('computeClientPatch', () => {
		it('lists only what changed, was added or is gone', () => {
			const drawn = drawnGraph(
				{ a: { id: 'a', label: 'a' }, b: { id: 'b', label: 'b' }, gone: { id: 'gone', label: 'gone' } },
				['a::b::link', 'old-edge']
			);
			drawn.dataOf = (id) =>
				({
					a: { id: 'a', label: 'a' },
					b: { id: 'b', label: 'b' },
					gone: { id: 'gone', label: 'gone' },
					'a::b::link': { id: 'a::b::link', source: 'a', target: 'b' },
				} as Record<string, Record<string, unknown>>)[id] ?? null;

			const patch = computeClientPatch(
				{
					...sameView,
					nodes: [node('a'), node('b', { label: 'renamed' }), node('new')],
					edges: [{ data: { id: 'a::b::link', source: 'a', target: 'b' } }],
				},
				drawn
			);

			expect(patch.upsertedNodes.map((n) => n.data.id)).toEqual(['b', 'new']);
			expect(patch.upsertedEdges).toEqual([]);
			expect(patch.removedNodeIds).toEqual(['gone']);
			expect(patch.removedEdgeIds).toEqual(['old-edge']);
			expect(patch.view).toEqual(sameView.view);
		});
	});

	describe('isWholesaleChange', () => {
		const patch = (overrides: Partial<ClientPatch>): ClientPatch => ({
			upsertedNodes: [],
			upsertedEdges: [],
			removedNodeIds: [],
			removedEdgeIds: [],
			...overrides,
		});
		const fourDrawn = drawnGraph({ a: {}, b: {}, c: {}, d: {} });

		it('is false for a small change', () => {
			expect(isWholesaleChange(patch({ upsertedNodes: [node('e')] }), fourDrawn)).toBe(false);
		});

		it('is true when half the drawn notes are removed', () => {
			expect(isWholesaleChange(patch({ removedNodeIds: ['a', 'b'] }), fourDrawn)).toBe(true);
		});

		it('is true when new notes would be half of what is drawn', () => {
			const added = ['e', 'f', 'g', 'h'].map((id) => node(id));
			expect(isWholesaleChange(patch({ upsertedNodes: added }), fourDrawn)).toBe(true);
		});

		it('does not count an update to a drawn note as new', () => {
			const updated = ['a', 'b', 'c'].map((id) => node(id, { label: 'x' }));
			expect(isWholesaleChange(patch({ upsertedNodes: updated }), fourDrawn)).toBe(false);
		});
	});
});
