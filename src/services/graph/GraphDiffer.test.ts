import { GraphDiffer } from './GraphDiffer';
import { GraphData } from './types';

function node(id: string, overrides: Partial<GraphData['nodes'][0]['data']> = {}) {
	return {
		data: {
			id,
			label: id,
			noteId: id,
			degree: 0,
			community: 0,
			size: 1,
			...overrides,
		},
	};
}

function edge(source: string, target: string, type: 'link' | 'tag' | 'semantic' = 'link') {
	return { data: { id: `${source}::${target}::${type}`, source, target, type } };
}

describe('GraphDiffer', () => {
	let differ: GraphDiffer;

	beforeEach(() => {
		differ = new GraphDiffer();
	});

	it('treats everything as upserted when there is no previous graph', () => {
		const current: GraphData = { nodes: [node('a')], edges: [edge('a', 'b')] };

		const diff = differ.computeDiff(null, current);

		expect(diff).toEqual({
			upsertedNodes: current.nodes,
			upsertedEdges: current.edges,
			removedNodeIds: [],
			removedEdgeIds: [],
		});
	});

	it('reports no changes when the graph is identical', () => {
		const graph: GraphData = { nodes: [node('a')], edges: [edge('a', 'b')] };

		const diff = differ.computeDiff(graph, graph);

		expect(diff).toEqual({
			upsertedNodes: [],
			upsertedEdges: [],
			removedNodeIds: [],
			removedEdgeIds: [],
		});
	});

	it('reports a brand-new node and edge as upserted', () => {
		const previous: GraphData = { nodes: [node('a')], edges: [] };
		const current: GraphData = { nodes: [node('a'), node('b')], edges: [edge('a', 'b')] };

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedNodes).toEqual([node('b')]);
		expect(diff.upsertedEdges).toEqual([edge('a', 'b')]);
		expect(diff.removedNodeIds).toEqual([]);
		expect(diff.removedEdgeIds).toEqual([]);
	});

	it('reports a node whose data changed (e.g. degree) as upserted even though its id is unchanged', () => {
		const previous: GraphData = { nodes: [node('a', { degree: 1 })], edges: [] };
		const current: GraphData = { nodes: [node('a', { degree: 2 })], edges: [] };

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedNodes).toEqual([node('a', { degree: 2 })]);
	});

	it('does not report an unchanged node as upserted just because another node changed', () => {
		const previous: GraphData = {
			nodes: [node('a', { degree: 1 }), node('b', { degree: 1 })],
			edges: [],
		};
		const current: GraphData = {
			nodes: [node('a', { degree: 2 }), node('b', { degree: 1 })],
			edges: [],
		};

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedNodes).toEqual([node('a', { degree: 2 })]);
	});

	it('reports a removed node and its dangling edge', () => {
		const previous: GraphData = {
			nodes: [node('a'), node('b')],
			edges: [edge('a', 'b')],
		};
		const current: GraphData = { nodes: [node('a')], edges: [] };

		const diff = differ.computeDiff(previous, current);

		expect(diff.removedNodeIds).toEqual(['b']);
		expect(diff.removedEdgeIds).toEqual(['a::b::link']);
		expect(diff.upsertedNodes).toEqual([]);
		expect(diff.upsertedEdges).toEqual([]);
	});

	it('treats a key explicitly set to undefined the same as the key being absent', () => {
		const previous: GraphData = { nodes: [node('a', { category: undefined })], edges: [] };
		const current: GraphData = { nodes: [node('a')], edges: [] };

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedNodes).toEqual([]);
	});

	it('reports a node as upserted when it gains a real (non-undefined) optional field', () => {
		const previous: GraphData = { nodes: [node('a')], edges: [] };
		const current: GraphData = { nodes: [node('a', { category: 'Gardening' })], edges: [] };

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedNodes).toEqual([node('a', { category: 'Gardening' })]);
	});

	it('distinguishes edges of different types between the same two notes', () => {
		const previous: GraphData = {
			nodes: [node('a'), node('b')],
			edges: [edge('a', 'b', 'link')],
		};
		const current: GraphData = {
			nodes: [node('a'), node('b')],
			edges: [edge('a', 'b', 'link'), edge('a', 'b', 'tag')],
		};

		const diff = differ.computeDiff(previous, current);

		expect(diff.upsertedEdges).toEqual([edge('a', 'b', 'tag')]);
		expect(diff.removedEdgeIds).toEqual([]);
	});
});
