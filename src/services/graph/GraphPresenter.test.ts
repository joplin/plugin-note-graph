import { GraphPresenter } from './GraphPresenter';
import { GraphViewBuilder, GraphViewLimits } from './GraphViewBuilder';
import { ResolvedScope, WHOLE_VAULT_SCOPE } from '../settings/NoteScopeResolver';
import { GraphData } from './types';

const LIMITS: GraphViewLimits = {
	maxNodes: 6,
	maxEdges: 100,
	maxOutsideNotes: 2,
	maxNeighborhoodNodes: 5,
};

function node(id: string, community = 0) {
	return {
		data: {
			id,
			label: id,
			noteId: id,
			degree: 1,
			community,
			size: 1,
			notebookId: `f${community + 1}`,
		},
	};
}

function notebookScope(folderId: string): ResolvedScope {
	return {
		folderIds: new Set([folderId]),
		scopeKey: `current:${folderId}`,
		label: folderId,
		notebookTitles: new Map(),
		followsSelection: true,
	};
}

function link(source: string, target: string) {
	return { data: { id: `${source}::${target}::link`, source, target, type: 'link' as const } };
}

const smallGraph = (): GraphData => ({
	nodes: [node('a'), node('b'), node('c')],
	edges: [link('a', 'b')],
});

const largeGraph = (): GraphData => ({
	nodes: Array.from({ length: 8 }, (_, i) => node(`n${i}`, i % 2)),
	edges: [link('n0', 'n2'), link('n1', 'n3')],
});

describe('GraphPresenter', () => {
	let compute: jest.Mock;
	let store: { loadLayout: jest.Mock; saveLayout: jest.Mock };
	let presenter: GraphPresenter;
	let scope: ResolvedScope;
	let resolveScope: jest.Mock;

	/** Pretends to be the real engine: anything with a known position keeps it, as long as most nodes have one. */
	const placeNewNodes = jest.fn(
		(data: GraphData, previous: Record<string, { x: number; y: number }>) => {
			const known = data.nodes.filter((n) => previous[n.data.id]);
			if (data.nodes.length === 0 || known.length < data.nodes.length / 2) return null;
			return Object.fromEntries(
				data.nodes.map((n) => [n.data.id, previous[n.data.id] ?? { x: 99, y: 99 }])
			);
		}
	);

	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
		placeNewNodes.mockClear();
		compute = jest.fn(async ({ data }: { data: GraphData }) =>
			Object.fromEntries(data.nodes.map((n, i) => [n.data.id, { x: i, y: i }]))
		);
		store = {
			loadLayout: jest.fn().mockResolvedValue(null),
			saveLayout: jest.fn().mockResolvedValue(undefined),
		};
		scope = WHOLE_VAULT_SCOPE;
		resolveScope = jest.fn(async () => scope);
		presenter = new GraphPresenter(
			new GraphViewBuilder(LIMITS),
			{ compute, placeNewNodes } as never,
			store,
			resolveScope
		);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('first graph', () => {
		it('computes positions and sends every node with one', async () => {
			const { payload, patch } = await presenter.setGraph(smallGraph());

			expect(patch).toBeNull();
			expect(compute).toHaveBeenCalledTimes(1);
			expect(payload.nodes.map((n) => n.position)).toEqual([
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: 2, y: 2 },
			]);
			expect(payload.view.kind).toBe('full');
		});

		it('reuses a saved layout instead of computing one', async () => {
			store.loadLayout.mockResolvedValue({
				a: { x: 7, y: 7 },
				b: { x: 8, y: 8 },
				c: { x: 9, y: 9 },
			});

			const { payload } = await presenter.setGraph(smallGraph());

			expect(compute).not.toHaveBeenCalled();
			expect(payload.nodes[0].position).toEqual({ x: 7, y: 7 });
		});

		it('computes a layout when loading the saved one fails', async () => {
			jest.spyOn(console, 'error').mockImplementation(() => undefined);
			store.loadLayout.mockRejectedValue(new Error('db locked'));

			await presenter.setGraph(smallGraph());

			expect(compute).toHaveBeenCalledTimes(1);
		});

		it('saves a computed layout under the view, layout and grouping', async () => {
			await presenter.setGraph(smallGraph());

			expect(store.saveLayout).toHaveBeenCalledWith('full|fcose|plain', expect.anything());
		});
	});

	describe('a later version of the same view', () => {
		it('sends a patch and keeps existing notes in place, with no new layout', async () => {
			await presenter.setGraph(smallGraph());
			compute.mockClear();
			const next = smallGraph();
			next.nodes.push(node('d'));
			next.edges.push(link('c', 'd'));

			const { patch, payload } = await presenter.setGraph(next);

			expect(compute).not.toHaveBeenCalled();
			expect(patch?.upsertedNodes.map((n) => n.data.id)).toEqual(['d']);
			expect(patch?.upsertedEdges.map((e) => e.data.id)).toEqual(['c::d::link']);
			expect(payload.nodes.find((n) => n.data.id === 'a')?.position).toEqual({ x: 0, y: 0 });
		});

		it('gives a new note in a patch its position', async () => {
			await presenter.setGraph(smallGraph());
			const next = smallGraph();
			next.nodes.push(node('d'));

			const { patch } = await presenter.setGraph(next);

			expect((patch?.upsertedNodes[0] as unknown as { position: unknown }).position).toEqual({
				x: 99,
				y: 99,
			});
		});

		it('reports an empty patch for an unchanged graph', async () => {
			await presenter.setGraph(smallGraph());

			const { patch } = await presenter.setGraph(smallGraph());

			expect(patch).toEqual({
				upsertedNodes: [],
				upsertedEdges: [],
				removedNodeIds: [],
				removedEdgeIds: [],
			});
		});

		it('reports removed notes in the patch', async () => {
			await presenter.setGraph(smallGraph());
			const next = { nodes: [node('a'), node('b')], edges: [link('a', 'b')] };

			const { patch } = await presenter.setGraph(next);

			expect(patch?.removedNodeIds).toEqual(['c']);
		});

		it('lays out again when a change adds many edges, such as semantic edges arriving', async () => {
			const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
			await presenter.setGraph({ nodes, edges: [] });
			compute.mockClear();
			const edges = [];
			for (let i = 0; i < 6; i++) {
				for (let j = i + 1; j < 6; j++) edges.push(link(`n${i}`, `n${j}`));
			}
			// A real store still holds the layout saved a moment ago, from before these edges.
			store.loadLayout.mockResolvedValue(
				Object.fromEntries(nodes.map((n, i) => [n.data.id, { x: i, y: i }]))
			);

			const { patch } = await presenter.setGraph({ nodes, edges });

			expect(patch).toBeNull();
			expect(compute).toHaveBeenCalledTimes(1);
			expect(compute.mock.calls[0][0].data.edges).toHaveLength(edges.length);
		});

		it('saves the new layout, so reopening shows the shape that includes those edges', async () => {
			const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`));
			await presenter.setGraph({ nodes, edges: [] });
			store.saveLayout.mockClear();
			const edges = [];
			for (let i = 0; i < 6; i++) {
				for (let j = i + 1; j < 6; j++) edges.push(link(`n${i}`, `n${j}`));
			}

			await presenter.setGraph({ nodes, edges });

			expect(store.saveLayout).toHaveBeenCalledTimes(1);
		});

		it('changes the layout revision only when positions are computed fresh', async () => {
			const first = await presenter.setGraph(smallGraph());
			const patched = await presenter.setGraph(smallGraph());
			expect(patched.payload.layoutRevision).toBe(first.payload.layoutRevision);

			const relaid = await presenter.setLayout('hierarchical', false);
			expect(relaid?.payload.layoutRevision).not.toBe(first.payload.layoutRevision);
		});
	});

	describe('moving between views', () => {
		beforeEach(() => {
			scope = notebookScope('f1');
		});

		it("opens a note's connections as a new drawing", async () => {
			await presenter.setGraph(largeGraph());

			const opened = await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			expect(opened?.patch).toBeNull();
			expect(opened?.payload.view.kind).toBe('neighborhood');
		});

		it('stays on the connections view when the graph changes', async () => {
			await presenter.setGraph(largeGraph());
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			const { payload } = await presenter.setGraph(largeGraph());

			expect(payload.view.kind).toBe('neighborhood');
		});

		it('stays on the connections view when the user moves to another notebook', async () => {
			await presenter.setGraph(largeGraph());
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });
			scope = notebookScope('f2');

			const refreshed = await presenter.refresh();

			expect(refreshed?.payload.view.kind).toBe('neighborhood');
			expect(presenter.currentScope().scopeKey).toBe('current:f2');
		});

		it('returns to the main view', async () => {
			await presenter.setGraph(largeGraph());
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			const back = await presenter.openView({ kind: 'auto' });

			expect(back?.payload.view.kind).toBe('notebook');
		});

		it('does nothing before a graph exists', async () => {
			await expect(presenter.openView({ kind: 'auto' })).resolves.toBeNull();
			await expect(presenter.setLayout('fcose', true)).resolves.toBeNull();
			await expect(presenter.setTagFilter('x')).resolves.toBeNull();
			await expect(presenter.refresh()).resolves.toBeNull();
		});

		it('goes back to the main view with no filter after a reset', async () => {
			await presenter.setGraph(largeGraph());
			await presenter.setTagFilter('work');
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			presenter.resetView();
			const refreshed = await presenter.refresh();

			expect(refreshed?.payload.view.kind).toBe('notebook');
			expect(refreshed?.payload.view.activeTag).toBeNull();
		});
	});

	describe('scope', () => {
		it('asks for the scope with whether the vault is too large to draw', async () => {
			await presenter.setGraph(smallGraph());
			expect(resolveScope).toHaveBeenLastCalledWith(false);

			await presenter.setGraph(largeGraph());
			expect(resolveScope).toHaveBeenLastCalledWith(true);
		});

		it('never draws a large vault whole', async () => {
			const { payload } = await presenter.setGraph(largeGraph());

			expect(payload.view.kind).toBe('empty');
			expect(payload.nodes).toEqual([]);
			expect(compute).not.toHaveBeenCalled();
		});

		it('moves to a different notebook as a new drawing, with no reload needed', async () => {
			scope = notebookScope('f1');
			await presenter.setGraph(largeGraph());
			scope = notebookScope('f2');

			const moved = await presenter.refresh();

			expect(moved?.patch).toBeNull();
			expect(moved?.payload.nodes.map((n) => n.data.id)).toEqual(['n1', 'n3', 'n5', 'n7']);
		});

		it("keeps the last scope when it can't be worked out, so the graph survives", async () => {
			jest.spyOn(console, 'error').mockImplementation(() => undefined);
			scope = notebookScope('f1');
			await presenter.setGraph(largeGraph());
			resolveScope.mockRejectedValueOnce(new Error('api down'));

			const { payload } = await presenter.setGraph(largeGraph());

			expect(payload.view.kind).toBe('notebook');
			expect(presenter.currentScope().scopeKey).toBe('current:f1');
		});

		it('applies a change to the notebook tree on the next graph, as a patch', async () => {
			scope = notebookScope('f1');
			await presenter.setGraph(largeGraph());

			const { payload, patch } = await presenter.setGraph(largeGraph());

			expect(patch).not.toBeNull();
			expect(payload.view.key).toBe('notebook::current:f1');
		});
	});

	describe('tag filter', () => {
		const tagged = (): GraphData => ({
			nodes: [
				{ data: { ...node('a').data, tagNames: 'work' } },
				{ data: { ...node('b').data, tagNames: 'home' } },
			],
			edges: [],
		});

		it('shows only the notes with that tag, and clears when given none', async () => {
			await presenter.setGraph(tagged());

			const filtered = await presenter.setTagFilter('work');
			expect(filtered?.payload.nodes.map((n) => n.data.id)).toEqual(['a']);
			expect(filtered?.payload.view.activeTag).toBe('work');

			const cleared = await presenter.setTagFilter(null);
			expect(cleared?.payload.nodes.map((n) => n.data.id)).toEqual(['a', 'b']);
		});

		it('keeps the filter when the graph changes', async () => {
			await presenter.setGraph(tagged());
			await presenter.setTagFilter('work');

			const { payload } = await presenter.setGraph(tagged());

			expect(payload.view.activeTag).toBe('work');
		});

		it('does not fill the disk with a layout for every tag', async () => {
			await presenter.setGraph(tagged());
			store.saveLayout.mockClear();

			await presenter.setTagFilter('work');

			expect(store.saveLayout).not.toHaveBeenCalled();
		});
	});

	describe('which layouts are kept', () => {
		beforeEach(() => {
			scope = notebookScope('f1');
		});

		it("keeps a notebook's main view on disk, but not connections views", async () => {
			await presenter.setGraph(largeGraph());
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			const keys = store.saveLayout.mock.calls.map(([key]) => key);
			expect(keys).toEqual(['notebook::current:f1|fcose|plain']);
		});

		it('does not grow the disk layout table as more notes are viewed', async () => {
			await presenter.setGraph(largeGraph());
			store.saveLayout.mockClear();

			for (let i = 0; i < 8; i++) {
				await presenter.openView({ kind: 'neighborhood', noteId: `n${i}` });
			}

			expect(store.saveLayout).not.toHaveBeenCalled();
		});

		it('keeps a connections view where it was when the user comes back to it', async () => {
			await presenter.setGraph(largeGraph());
			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });
			await presenter.openView({ kind: 'auto' });
			compute.mockClear();

			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			expect(compute).not.toHaveBeenCalled();
		});

		it('forgets the oldest views, so memory stays bounded', async () => {
			const many = {
				nodes: Array.from({ length: 30 }, (_, i) => node(`n${i}`, i)),
				edges: [] as GraphData['edges'],
			};
			await presenter.setGraph(many);
			for (let i = 0; i < 25; i++)
				await presenter.openView({ kind: 'neighborhood', noteId: `n${i}` });
			compute.mockClear();

			await presenter.openView({ kind: 'neighborhood', noteId: 'n0' });

			expect(compute).toHaveBeenCalledTimes(1);
		});
	});

	describe('setLayout', () => {
		it('recomputes with the requested layout and grouping', async () => {
			await presenter.setGraph(smallGraph());
			compute.mockClear();

			const result = await presenter.setLayout('hierarchical', false);

			expect(compute).toHaveBeenCalledWith(
				expect.objectContaining({ layout: 'hierarchical', grouped: false })
			);
			expect(result?.patch).toBeNull();
		});

		it('stores each layout separately', async () => {
			await presenter.setGraph(smallGraph());

			await presenter.setLayout('fcose', true);

			expect(store.saveLayout).toHaveBeenLastCalledWith(
				'full|fcose|grouped',
				expect.anything()
			);
		});
	});

	describe('overlapping updates', () => {
		it('finishes them in the order they were made', async () => {
			let finishFirst: (value: Record<string, { x: number; y: number }>) => void = () =>
				undefined;
			compute.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishFirst = resolve;
					})
			);
			const order: string[] = [];

			const first = presenter.setGraph(smallGraph()).then(() => order.push('first'));
			const second = presenter.setGraph(smallGraph()).then(() => order.push('second'));
			await new Promise((resolve) => setImmediate(resolve));
			finishFirst({ a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, c: { x: 2, y: 2 } });
			await Promise.all([first, second]);

			expect(order).toEqual(['first', 'second']);
		});

		it('keeps working after one update fails', async () => {
			compute.mockRejectedValueOnce(new Error('layout failed'));

			await expect(presenter.setGraph(smallGraph())).rejects.toThrow('layout failed');
			await expect(presenter.setGraph(smallGraph())).resolves.toBeDefined();
		});
	});

	describe('search', () => {
		it('finds notes across the whole vault, not just the current view', async () => {
			scope = notebookScope('f1');
			await presenter.setGraph(largeGraph());

			expect(presenter.search('n7').map((r) => r.noteId)).toEqual(['n7']);
		});

		it('returns nothing before a graph exists', () => {
			expect(presenter.search('x')).toEqual([]);
		});
	});
});
