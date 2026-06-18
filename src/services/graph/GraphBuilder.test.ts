import { GraphBuilder } from './GraphBuilder';
import { EdgeFactory } from '../similarity/EdgeFactory';
import { Note } from '../../data/Types';

jest.mock('../similarity/EdgeFactory');

const MockEdgeFactory = EdgeFactory as jest.MockedClass<typeof EdgeFactory>;

function note(
	id: string,
	title: string,
	links: string[] = []
): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body: '',
		created_time: 0,
		updated_time: 1,
		links,
		tags: [],
	};
}

describe('GraphBuilder', () => {
	let builder: GraphBuilder;
	let mockEdgeFactory: jest.Mocked<EdgeFactory>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockEdgeFactory = new MockEdgeFactory() as jest.Mocked<EdgeFactory>;
		builder = new GraphBuilder(mockEdgeFactory);
	});

	it('creates nodes with degree 0 when no edges', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);

		const notes = [note('a', 'Note A'), note('b', 'Note B')];

		const result = builder.build(notes);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes[0].data).toMatchObject({
			id: 'a',
			label: 'Note A',
			noteId: 'a',
			degree: 0,
		});
		expect(result.nodes[1].data).toMatchObject({
			id: 'b',
			label: 'Note B',
			noteId: 'b',
			degree: 0,
		});
	});

	it('computes degree from edges', () => {
		mockEdgeFactory.createEdges.mockReturnValue([
			{ source: 'a', target: 'b', type: 'link' },
		]);

		const notes = [note('a', 'A'), note('b', 'B')];

		const result = builder.build(notes);
		expect(result.nodes[0].data.degree).toBe(1);
		expect(result.nodes[1].data.degree).toBe(1);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].data).toEqual({ source: 'a', target: 'b', type: 'link' });
	});

	it('truncates long node labels to 64 chars', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);

		const longTitle = 'A'.repeat(100);
		const notes = [note('a', longTitle)];

		const result = builder.build(notes);
		const label = result.nodes[0].data.label;
		expect(label).toHaveLength(64);
		expect(label.endsWith('...')).toBe(true);
	});

	it('uses (untitled) for empty titles', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);

		const notes = [note('a', '')];

		const result = builder.build(notes);
		expect(result.nodes[0].data.label).toBe('(untitled)');
	});

	it('filters edges to non-existent nodes', () => {
		mockEdgeFactory.createEdges.mockReturnValue([
			{ source: 'a', target: 'missing', type: 'link' },
			{ source: 'a', target: 'b', type: 'link' },
		]);

		const notes = [note('a', 'A'), note('b', 'B')];

		const result = builder.build(notes);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].data).toEqual({ source: 'a', target: 'b', type: 'link' });
	});

	it('computes correct degree for hub node', () => {
		mockEdgeFactory.createEdges.mockReturnValue([
			{ source: 'a', target: 'b', type: 'link' },
			{ source: 'a', target: 'c', type: 'link' },
			{ source: 'c', target: 'd', type: 'tag' },
		]);

		const notes = [
			note('a', 'A'),
			note('b', 'B'),
			note('c', 'C'),
			note('d', 'D'),
		];

		const result = builder.build(notes);
		const nodeA = result.nodes.find((n) => n.data.id === 'a');
		const nodeC = result.nodes.find((n) => n.data.id === 'c');
		expect(nodeA?.data.degree).toBe(2);
		expect(nodeC?.data.degree).toBe(2);
	});
});
