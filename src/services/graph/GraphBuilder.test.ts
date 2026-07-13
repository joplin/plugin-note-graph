import { GraphBuilder } from './GraphBuilder';
import { EdgeFactory } from '../similarity/EdgeFactory';
import { SimilarityEngine } from '../similarity/SimilarityEngine';
import { Note } from '../../data/Types';

jest.mock('../similarity/EdgeFactory');
jest.mock('../similarity/SimilarityEngine');

const MockEdgeFactory = EdgeFactory as jest.MockedClass<typeof EdgeFactory>;
const MockSimilarityEngine = SimilarityEngine as jest.MockedClass<typeof SimilarityEngine>;

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

	describe('buildWithSimilarity', () => {
		it('adds semantic edges computed from embeddings alongside structural edges', async () => {
			mockEdgeFactory.createEdges.mockReturnValue([{ source: 'a', target: 'c', type: 'link' }]);
			mockEdgeFactory.createSemanticEdges.mockReturnValue([
				{ source: 'a', target: 'b', type: 'semantic' },
			]);
			MockSimilarityEngine.mockImplementation(() => ({
				compute: jest.fn().mockResolvedValue([{ source: 'a', target: 'b', score: 0.8 }]),
			}) as unknown as SimilarityEngine);

			const notes = [note('a', 'A'), note('b', 'B'), note('c', 'C')];
			const embeddedNotes = [
				{ note: notes[0], embedding: [1, 0] },
				{ note: notes[1], embedding: [0.9, 0.1] },
			];

			const result = await builder.buildWithSimilarity(notes, embeddedNotes);

			expect(mockEdgeFactory.createSemanticEdges).toHaveBeenCalledWith([
				{ source: 'a', target: 'b', score: 0.8 },
			]);
			expect(result.edges).toContainEqual({ data: { source: 'a', target: 'b', type: 'semantic' } });
			expect(result.edges).toContainEqual({ data: { source: 'a', target: 'c', type: 'link' } });
			expect(result.edges).toHaveLength(2);
		});

		it('still returns a graph when there are no semantic matches', async () => {
			mockEdgeFactory.createEdges.mockReturnValue([]);
			mockEdgeFactory.createSemanticEdges.mockReturnValue([]);
			MockSimilarityEngine.mockImplementation(() => ({
				compute: jest.fn().mockResolvedValue([]),
			}) as unknown as SimilarityEngine);

			const notes = [note('a', 'A'), note('b', 'B')];
			const result = await builder.buildWithSimilarity(notes, []);

			expect(result.nodes).toHaveLength(2);
			expect(result.edges).toEqual([]);
		});
	});
});
