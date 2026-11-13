import { GraphBuilder } from './GraphBuilder';
import { Note } from '../../data/Types';

describe('GraphBuilder.rebuildStructure', () => {
	const makeNote = (id: string, links: string[] = []): Note => ({
		id,
		parent_id: 'p',
		title: id,
		body: '',
		created_time: 0,
		updated_time: 1,
		links,
		tags: [],
	});
	const semanticEdge = (source: string, target: string) => ({
		data: {
			id: `${source}::${target}::semantic`,
			source,
			target,
			type: 'semantic' as const,
			score: 0.8,
			relationshipLabel: 'label',
		},
	});

	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('keeps existing semantic edges, with their labels, and adds new structural edges', () => {
		const notes = [makeNote('a', ['b']), makeNote('b'), makeNote('c')];

		const graph = new GraphBuilder().rebuildStructure(notes, {
			nodes: [],
			edges: [semanticEdge('a', 'c')],
		});

		const byType = (type: string) => graph.edges.filter((edge) => edge.data.type === type);
		expect(byType('link')).toHaveLength(1);
		expect(byType('semantic')).toHaveLength(1);
		expect(byType('semantic')[0].data.relationshipLabel).toBe('label');
	});

	it('drops semantic edges that point at a note no longer present', () => {
		const graph = new GraphBuilder().rebuildStructure([makeNote('a'), makeNote('b')], {
			nodes: [],
			edges: [semanticEdge('a', 'b'), semanticEdge('a', 'gone')],
		});

		expect(graph.edges.map((edge) => edge.data.id)).toEqual(['a::b::semantic']);
	});

	it('does not carry over old link or tag edges', () => {
		const graph = new GraphBuilder().rebuildStructure([makeNote('a'), makeNote('b')], {
			nodes: [],
			edges: [{ data: { id: 'a::b::link', source: 'a', target: 'b', type: 'link' } }],
		});

		expect(graph.edges).toEqual([]);
	});

	it('keeps community numbers from a cached graph after a restart', () => {
		const tagged = (id: string, tag: string): Note => ({ ...makeNote(id), tags: [tag] });
		const notes = [
			...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tagged(id, 'big')),
			...['x', 'y', 'z'].map((id) => tagged(id, 'small')),
		];
		const original = new GraphBuilder().build(notes);
		const numberOf = (
			graph: { nodes: Array<{ data: { id: string; community: number } }> },
			id: string
		) => graph.nodes.find((n) => n.data.id === id)?.data.community;
		const swapped = original.nodes.map((n) => ({
			data: { ...n.data, community: n.data.community === 0 ? 1 : 0 },
		}));
		const cached = { nodes: swapped, edges: original.edges };

		const restarted = new GraphBuilder();
		restarted.rememberCommunities(cached);
		const rebuilt = restarted.rebuildStructure(notes, cached);

		expect(numberOf(rebuilt, 'a')).toBe(numberOf(cached, 'a'));
		expect(numberOf(rebuilt, 'x')).toBe(numberOf(cached, 'x'));
	});
});
