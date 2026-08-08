import { GraphBuilder } from './GraphBuilder';
import { EdgeFactory } from '../similarity/EdgeFactory';
import { SimilarityEngine } from '../similarity/SimilarityEngine';
import { LouvainDetector } from './LouvainDetector';
import { CentralityScorer } from './CentralityScorer';
import { Note } from '../../data/Types';

jest.mock('../similarity/EdgeFactory');
jest.mock('../similarity/SimilarityEngine');
jest.mock('./LouvainDetector');
jest.mock('./CentralityScorer');

const MockEdgeFactory = EdgeFactory as jest.MockedClass<typeof EdgeFactory>;
const MockSimilarityEngine = SimilarityEngine as jest.MockedClass<typeof SimilarityEngine>;
const MockLouvainDetector = LouvainDetector as jest.MockedClass<typeof LouvainDetector>;
const MockCentralityScorer = CentralityScorer as jest.MockedClass<typeof CentralityScorer>;

function note(id: string, title: string, links: string[] = []): Note {
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
	let mockLouvainDetector: jest.Mocked<LouvainDetector>;
	let mockCentralityScorer: jest.Mocked<CentralityScorer>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockEdgeFactory = new MockEdgeFactory() as jest.Mocked<EdgeFactory>;
		mockLouvainDetector = new MockLouvainDetector() as jest.Mocked<LouvainDetector>;
		mockCentralityScorer = new MockCentralityScorer() as jest.Mocked<CentralityScorer>;
		mockLouvainDetector.detectCommunities.mockReturnValue(new Map());
		mockCentralityScorer.score.mockReturnValue(new Map());
		builder = new GraphBuilder(mockEdgeFactory, mockLouvainDetector, mockCentralityScorer);
	});

	it('creates nodes with degree 0 when no edges', () => {
		mockEdgeFactory.createEdges.mockReturnValue([]);
		const notes = [note('a', 'Note A'), note('b', 'Note B')];
		const result = builder.build(notes);
		expect(result.nodes).toHaveLength(2);
		expect(result.nodes[0].data).toMatchObject({ id: 'a', label: 'Note A', degree: 0 });
	});

	it('computes degree from edges', () => {
		mockEdgeFactory.createEdges.mockReturnValue([{ source: 'a', target: 'b', type: 'link' }]);
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

	it('applies the detected community and centrality size to each node', () => {
		mockEdgeFactory.createEdges.mockReturnValue([{ source: 'a', target: 'b', type: 'link' }]);
		mockLouvainDetector.detectCommunities.mockReturnValue(
			new Map([
				['a', 2],
				['b', 2],
			])
		);
		mockCentralityScorer.score.mockReturnValue(
			new Map([
				['a', 7],
				['b', 3],
			])
		);

		const notes = [note('a', 'A'), note('b', 'B')];
		const result = builder.build(notes);

		expect(result.nodes[0].data).toMatchObject({ id: 'a', community: 2, size: 7 });
		expect(result.nodes[1].data).toMatchObject({ id: 'b', community: 2, size: 3 });
	});

	it('defaults community to 0 and size to 1 when a note is missing from either map, and logs it', () => {
		const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		mockEdgeFactory.createEdges.mockReturnValue([]);
		const notes = [note('a', 'A')];
		const result = builder.build(notes);
		expect(result.nodes[0].data).toMatchObject({ community: 0, size: 1 });
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('a'));
		consoleErrorSpy.mockRestore();
	});

	describe('buildWithSimilarity', () => {
		it('adds semantic edges computed from embeddings alongside structural edges', async () => {
			mockEdgeFactory.createEdges.mockReturnValue([
				{ source: 'a', target: 'c', type: 'link' },
			]);
			mockEdgeFactory.createSemanticEdges.mockReturnValue([
				{ source: 'a', target: 'b', type: 'semantic' },
			]);
			MockSimilarityEngine.mockImplementation(
				() =>
					({
						compute: jest
							.fn()
							.mockResolvedValue([{ source: 'a', target: 'b', score: 0.8 }]),
					} as unknown as SimilarityEngine)
			);

			const notes = [note('a', 'A'), note('b', 'B'), note('c', 'C')];
			const embeddedNotes = [
				{ note: notes[0], embedding: [1, 0] },
				{ note: notes[1], embedding: [0.9, 0.1] },
			];

			const result = await builder.buildWithSimilarity(notes, embeddedNotes);

			expect(mockEdgeFactory.createSemanticEdges).toHaveBeenCalledWith([
				{ source: 'a', target: 'b', score: 0.8 },
			]);
			expect(result.edges).toContainEqual({
				data: { source: 'a', target: 'b', type: 'semantic' },
			});
			expect(result.edges).toContainEqual({
				data: { source: 'a', target: 'c', type: 'link' },
			});
			expect(result.edges).toHaveLength(2);
		});

		it('still returns a graph when there are no semantic matches', async () => {
			mockEdgeFactory.createEdges.mockReturnValue([]);
			mockEdgeFactory.createSemanticEdges.mockReturnValue([]);
			MockSimilarityEngine.mockImplementation(
				() =>
					({
						compute: jest.fn().mockResolvedValue([]),
					} as unknown as SimilarityEngine)
			);

			const notes = [note('a', 'A'), note('b', 'B')];
			const result = await builder.buildWithSimilarity(notes, []);

			expect(result.nodes).toHaveLength(2);
			expect(result.edges).toEqual([]);
		});

		it('forwards a custom threshold and top-K to SimilarityEngine.compute', async () => {
			mockEdgeFactory.createEdges.mockReturnValue([]);
			mockEdgeFactory.createSemanticEdges.mockReturnValue([]);
			const computeMock = jest.fn().mockResolvedValue([]);
			MockSimilarityEngine.mockImplementation(
				() => ({ compute: computeMock } as unknown as SimilarityEngine)
			);

			const notes = [note('a', 'A'), note('b', 'B')];
			await builder.buildWithSimilarity(notes, [], 0.7, 3);

			expect(computeMock).toHaveBeenCalledWith(0.7, 3);
		});
	});
});
