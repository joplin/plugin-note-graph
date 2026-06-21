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
		expect(result.nodes[0].data).toMatchObject({ id: 'a', label: 'Note A', degree: 0 });
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

	it('truncates long note labels to 64 chars', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);
		const longTitle = 'A'.repeat(100);
		const result = builder.build([note('a', longTitle)]);
		expect(result.nodes[0].data.label).toHaveLength(64);
		expect(result.nodes[0].data.label.endsWith('...')).toBe(true);
	});

	it('uses (untitled) for empty titles', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);
		const result = builder.build([note('a', '')]);
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
});
