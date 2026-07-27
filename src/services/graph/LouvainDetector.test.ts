import { LouvainDetector } from './LouvainDetector';
import { Note } from '../../data/Types';
import { GraphEdge } from './types';

function note(id: string, title: string, body = ''): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body,
		created_time: 0,
		updated_time: 1,
		links: [],
		tags: [],
	};
}

describe('LouvainDetector', () => {
	let detector: LouvainDetector;

	beforeEach(() => {
		detector = new LouvainDetector();
	});

	describe('sparse fallback (keyword grouping)', () => {
		it('groups notes sharing a dominant keyword into the same community', () => {
			const notes = [
				note('a', 'Gardening tips', 'Watering the garden every gardening morning'),
				note('b', 'More gardening', 'Gardening pruning gardening advice'),
				note('c', 'Cooking basics', 'Cooking pasta cooking recipes'),
			];

			const communities = detector.detectCommunities(notes, []);

			expect(communities.get('a')).toBe(communities.get('b'));
			expect(communities.get('a')).not.toBe(communities.get('c'));
		});

		it('falls back to keyword grouping when there are fewer than 3 notes, even with edges', () => {
			const notes = [note('a', 'Alpha document'), note('b', 'Beta document')];
			const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.size).toBe(2);
			expect(communities.get('a')).not.toBe(communities.get('b'));
		});

		it('gives each note its own community when no keyword repeats across notes', () => {
			const notes = [
				note('a', 'Zebra migration'),
				note('b', 'Quantum entanglement'),
				note('c', 'Symphony orchestra'),
			];

			const communities = detector.detectCommunities(notes, []);

			expect(new Set(communities.values()).size).toBe(3);
		});
	});

	describe('Louvain', () => {
		it('places directly connected notes in the same community and separates disconnected clusters', () => {
			const notes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => note(id, id));
			const edges: GraphEdge[] = [
				{ source: 'a', target: 'b', type: 'link' },
				{ source: 'b', target: 'c', type: 'link' },
				{ source: 'a', target: 'c', type: 'link' },
				{ source: 'd', target: 'e', type: 'link' },
				{ source: 'e', target: 'f', type: 'link' },
				{ source: 'd', target: 'f', type: 'link' },
			];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('a')).toBe(communities.get('b'));
			expect(communities.get('a')).toBe(communities.get('c'));
			expect(communities.get('d')).toBe(communities.get('e'));
			expect(communities.get('d')).toBe(communities.get('f'));
			expect(communities.get('a')).not.toBe(communities.get('d'));
		});

		it('numbers communities by descending size, ties broken by the lowest member id, so results are stable', () => {
			const notes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => note(id, id));
			const edges: GraphEdge[] = [
				{ source: 'a', target: 'b', type: 'link' },
				{ source: 'b', target: 'c', type: 'link' },
				{ source: 'a', target: 'c', type: 'link' },
				{ source: 'd', target: 'e', type: 'link' },
				{ source: 'e', target: 'f', type: 'link' },
				{ source: 'd', target: 'f', type: 'link' },
			];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('a')).toBe(0);
			expect(communities.get('d')).toBe(1);
		});

		it('produces identical assignments across repeated runs on the same graph', () => {
			const notes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => note(id, id));
			const edges: GraphEdge[] = [
				{ source: 'a', target: 'b', type: 'link' },
				{ source: 'b', target: 'c', type: 'link' },
				{ source: 'a', target: 'c', type: 'link' },
				{ source: 'd', target: 'e', type: 'link' },
				{ source: 'e', target: 'f', type: 'link' },
				{ source: 'd', target: 'f', type: 'link' },
			];

			const first = detector.detectCommunities(notes, edges);
			const second = detector.detectCommunities(notes, edges);

			expect(Array.from(second.entries())).toEqual(Array.from(first.entries()));
		});

		it('weighs a note more strongly toward a cluster it shares multiple edge types with', () => {
			// x is tied to triangle A by two relationships (a link and a tag
			// between the same pair) and to triangle B by a single link.
			// Tested this against the real library. Without adding up the
			// weight per edge type, x-a1 and x-b1 both stay at weight 1 and x
			// ties toward B. With the weight added up, x-a1 reaches weight 2
			// and pulls x into A instead. This is a real regression test for
			// that logic, not just a "doesn't throw" check.
			const triangle = (prefix: string): GraphEdge[] => [
				{ source: `${prefix}1`, target: `${prefix}2`, type: 'link' },
				{ source: `${prefix}2`, target: `${prefix}3`, type: 'link' },
				{ source: `${prefix}1`, target: `${prefix}3`, type: 'link' },
			];
			const notes = ['x', 'a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((id) => note(id, id));
			const edges: GraphEdge[] = [
				...triangle('a'),
				...triangle('b'),
				{ source: 'x', target: 'a1', type: 'link' },
				{ source: 'x', target: 'a1', type: 'tag' },
				{ source: 'x', target: 'b1', type: 'link' },
			];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('x')).toBe(communities.get('a1'));
			expect(communities.get('x')).not.toBe(communities.get('b1'));
		});

		it('assigns every note a community, including notes with no edges of their own', () => {
			const notes = ['a', 'b', 'c', 'd', 'isolated'].map((id) => note(id, id));
			const edges: GraphEdge[] = [
				{ source: 'a', target: 'b', type: 'link' },
				{ source: 'b', target: 'c', type: 'link' },
				{ source: 'a', target: 'c', type: 'link' },
				{ source: 'c', target: 'd', type: 'link' },
			];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.size).toBe(notes.length);
			expect(communities.has('isolated')).toBe(true);
		});

		it('does not throw on edges referencing notes outside the note set', () => {
			const notes = [note('a', 'A'), note('b', 'B'), note('c', 'C')];
			const edges: GraphEdge[] = [
				{ source: 'a', target: 'b', type: 'link' },
				{ source: 'b', target: 'c', type: 'link' },
				{ source: 'a', target: 'missing', type: 'link' },
			];

			expect(() => detector.detectCommunities(notes, edges)).not.toThrow();
		});

		it('falls back to keyword grouping when Louvain resolves to near-all singletons', () => {
			const notes = [
				note('a', 'Linked one'),
				note('b', 'Linked two'),
				note('c', 'Gardening tips', 'Gardening advice gardening'),
				note('d', 'More gardening', 'Gardening notes gardening tips'),
				note('e1', 'Isolate one'),
				note('e2', 'Isolate two'),
				note('e3', 'Isolate three'),
				note('e4', 'Isolate four'),
				note('e5', 'Isolate five'),
				note('e6', 'Isolate six'),
			];
			// Just one edge among 10 otherwise disconnected notes. Louvain
			// would end up with 9 communities (one pair plus eight
			// singletons), well past the degenerate threshold, even though
			// edges.length is greater than 0.
			const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('c')).toBe(communities.get('d'));
		});
	});
});
