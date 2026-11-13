import { GraphLayoutEngine } from './GraphLayoutEngine';
import { GraphData } from './types';

function graphOf(nodeCount: number, communities = 1, edgesPerNode = 2): GraphData {
	const nodes = Array.from({ length: nodeCount }, (_, i) => ({
		data: {
			id: `n${i}`,
			label: `n${i}`,
			noteId: `n${i}`,
			degree: nodeCount - i,
			community: i % communities,
			size: 1,
		},
	}));
	const edges = [];
	for (let i = 0; i < nodeCount; i++) {
		for (let k = 1; k <= edgesPerNode; k++) {
			const j = (i + k * communities) % nodeCount;
			if (i !== j) {
				edges.push({
					data: {
						id: `e${i}-${j}`,
						source: `n${i}`,
						target: `n${j}`,
						type: 'link' as const,
					},
				});
			}
		}
	}
	return { nodes, edges };
}

function expectEveryNodePositioned(
	positions: Record<string, { x: number; y: number }>,
	graph: GraphData
): void {
	for (const { data } of graph.nodes) {
		expect(Number.isFinite(positions[data.id]?.x)).toBe(true);
		expect(Number.isFinite(positions[data.id]?.y)).toBe(true);
	}
}

function closestPairDistance(points: Array<{ x: number; y: number }>): number {
	let closest = Infinity;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			closest = Math.min(
				closest,
				Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
			);
		}
	}
	return closest;
}

describe('GraphLayoutEngine', () => {
	const engine = new GraphLayoutEngine();

	beforeEach(() => {
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	describe('compute', () => {
		it('places notes in a grid when layout fails, so the graph still appears', async () => {
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			const graph = graphOf(9);
			const failing = new GraphLayoutEngine();
			jest.spyOn(
				failing as unknown as { runLayout: () => Promise<never> },
				'runLayout'
			).mockRejectedValue(new Error('layout exploded'));

			const positions = await failing.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
			expect(closestPairDistance(Object.values(positions))).toBeGreaterThan(50);
			expect(errorSpy).toHaveBeenCalled();
		});

		it('returns nothing for an empty graph', async () => {
			await expect(
				engine.compute({ data: { nodes: [], edges: [] }, layout: 'fcose', grouped: false })
			).resolves.toEqual({});
		});

		it('positions a small graph with force layout', async () => {
			const graph = graphOf(30, 3);

			const positions = await engine.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
		});

		it('positions a single note', async () => {
			const graph = graphOf(1);

			const positions = await engine.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
		});

		it('positions notes with no edges at all', async () => {
			const graph = { ...graphOf(40), edges: [] };

			const positions = await engine.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
		});

		it('positions a hierarchical layout', async () => {
			const graph = graphOf(30, 3);

			const positions = await engine.compute({
				data: graph,
				layout: 'hierarchical',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
		});

		it('handles the largest view the panel can show quickly, without overlapping notes', async () => {
			const graph = graphOf(1500, 30, 3);
			const started = Date.now();

			const positions = await engine.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expect(Date.now() - started).toBeLessThan(20000);
			expectEveryNodePositioned(positions, graph);
			expect(closestPairDistance(Object.values(positions))).toBeGreaterThan(10);
		}, 30000);

		it('keeps each community together when grouped', async () => {
			const graph = graphOf(60, 3);

			const positions = await engine.compute({ data: graph, layout: 'fcose', grouped: true });

			const centerOf = (community: number) => {
				const members = graph.nodes.filter((n) => n.data.community === community);
				const xs = members.map((n) => positions[n.data.id].x);
				const ys = members.map((n) => positions[n.data.id].y);
				return {
					x: xs.reduce((a, b) => a + b, 0) / xs.length,
					y: ys.reduce((a, b) => a + b, 0) / ys.length,
					spread: Math.max(...xs) - Math.min(...xs),
				};
			};
			const [a, b] = [centerOf(0), centerOf(1)];
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.spread / 2);
		});

		it('copes with more communities than it lays out individually', async () => {
			const graph = { ...graphOf(700, 400), edges: [] };

			const positions = await engine.compute({
				data: graph,
				layout: 'fcose',
				grouped: false,
			});

			expectEveryNodePositioned(positions, graph);
		}, 30000);

	});

	describe('placeNewNodes', () => {
		const positionsFor = (graph: GraphData) =>
			Object.fromEntries(graph.nodes.map((n, i) => [n.data.id, { x: i * 100, y: 0 }]));

		it('leaves every existing note exactly where it was', () => {
			const graph = graphOf(10);
			const previous = positionsFor(graph);

			expect(engine.placeNewNodes(graph, previous)).toEqual(previous);
		});

		it('places a new note beside the notes it connects to', () => {
			const graph = graphOf(5, 1, 0);
			const previous = positionsFor(graph);
			graph.nodes.push({
				data: { id: 'new', label: 'new', noteId: 'new', degree: 1, community: 0, size: 1 },
			});
			graph.edges.push({ data: { id: 'e', source: 'new', target: 'n4', type: 'link' } });

			const positions = engine.placeNewNodes(graph, previous)!;

			const distance = Math.hypot(
				positions.new.x - previous.n4.x,
				positions.new.y - previous.n4.y
			);
			expect(distance).toBeLessThan(100);
			expect(positions.n0).toEqual(previous.n0);
		});

		it('places an unconnected new note away from the middle, not on top of anything', () => {
			const graph = graphOf(5, 1, 0);
			const previous = positionsFor(graph);
			graph.nodes.push({
				data: { id: 'new', label: 'new', noteId: 'new', degree: 0, community: 0, size: 1 },
			});

			const positions = engine.placeNewNodes(graph, previous)!;

			expect(Object.values(previous)).not.toContainEqual(positions.new);
		});

		it('spreads several new notes that share one neighbour', () => {
			const graph = graphOf(5, 1, 0);
			const previous = positionsFor(graph);
			for (const id of ['x', 'y']) {
				graph.nodes.push({
					data: { id, label: id, noteId: id, degree: 1, community: 0, size: 1 },
				});
				graph.edges.push({
					data: { id: `e${id}`, source: id, target: 'n0', type: 'link' },
				});
			}

			const positions = engine.placeNewNodes(graph, previous)!;

			expect(positions.x).not.toEqual(positions.y);
		});

		it('gives up when most of the graph has no position, so a fresh layout runs', () => {
			const graph = graphOf(10);

			expect(engine.placeNewNodes(graph, { n0: { x: 0, y: 0 } })).toBeNull();
		});

		it('gives up on an empty graph', () => {
			expect(engine.placeNewNodes({ nodes: [], edges: [] }, {})).toBeNull();
		});
	});
});
