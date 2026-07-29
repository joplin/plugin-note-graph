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

		it('keeps directly linked notes together even under the 3-note Louvain threshold, despite differing keywords', () => {
			const notes = [note('a', 'Alpha document'), note('b', 'Beta document')];
			const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.size).toBe(2);
			expect(communities.get('a')).toBe(communities.get('b'));
		});

		it('gives each note its own community when no keyword repeats and nothing links them', () => {
			const notes = [
				note('a', 'Zebra migration'),
				note('b', 'Quantum entanglement'),
				note('c', 'Symphony orchestra'),
			];

			const communities = detector.detectCommunities(notes, []);

			expect(new Set(communities.values())).toEqual(new Set([0, 1, 2]));
		});

		it('numbers keyword-fallback communities by descending size, not by first-appearance order', () => {
			const notes = [
				note('solo1', 'Astronomy basics'),
				note('solo2', 'Philosophy overview'),
				note('a', 'Gardening tips', 'Watering the garden every gardening morning'),
				note('b', 'More gardening', 'Gardening pruning gardening advice'),
				note('c', 'Gardening again', 'Gardening season gardening harvest'),
			];

			const communities = detector.detectCommunities(notes, []);

			// The 3-note gardening group is the largest, so it must get id 0 even though
			// it appears after the two singleton notes in the input.
			expect(communities.get('a')).toBe(0);
			expect(communities.get('b')).toBe(0);
			expect(communities.get('c')).toBe(0);
			expect(communities.get('solo1')).not.toBe(0);
			expect(communities.get('solo2')).not.toBe(0);
		});

		it('logs when the graph is too sparse for Louvain and the keyword/link fallback is used', () => {
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			detector.detectCommunities([note('a', 'Alpha'), note('b', 'Beta')], []);

			expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('too sparse for Louvain'));
			consoleInfoSpy.mockRestore();
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

		it('produces identical assignments regardless of the order notes and edges are supplied in', () => {
			// Two triangles bridged by a single edge each to node x - a genuine modularity tie,
			// since x has no reason to prefer one triangle over the other. Only the order notes/edges
			// arrive in should be able to break the tie one way or the other; that order must not
			// leak in from the caller (e.g. a note-fetch order that isn't guaranteed stable).
			// Uses fixed shuffles rather than a plain .reverse() - a reversal of this symmetric
			// fixture can coincidentally land on the same tie-break, masking the bug this guards.
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
				{ source: 'x', target: 'b1', type: 'link' },
			];

			const permute = <T,>(arr: T[], order: number[]): T[] => order.map((i) => arr[i]);
			const shuffledOrders: Array<{ notes: number[]; edges: number[] }> = [
				{ notes: [3, 6, 1, 4, 0, 5, 2], edges: [5, 2, 7, 0, 4, 1, 6, 3] },
				{ notes: [6, 5, 4, 3, 2, 1, 0], edges: [7, 6, 5, 4, 3, 2, 1, 0] },
				{ notes: [0, 4, 1, 5, 2, 6, 3], edges: [1, 0, 3, 2, 5, 4, 7, 6] },
			];

			const expected = Array.from(detector.detectCommunities(notes, edges).entries()).sort();

			for (const order of shuffledOrders) {
				const result = detector.detectCommunities(permute(notes, order.notes), permute(edges, order.edges));
				expect(Array.from(result.entries()).sort()).toEqual(expected);
			}
		});

		it('weighs a note more strongly toward a cluster it shares multiple edge types with', () => {
			// x has two relationships with a1 (link + tag) but only one with b1.
			// Verified against the real library that this specific setup is what
			// flips x from tying toward b1 to grouping with a1.
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

		it('falls back to keyword/link grouping when it consolidates better than a degenerate Louvain result', () => {
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
			// One edge among 10 otherwise disconnected notes: 9 communities, past the degenerate
			// threshold. The keyword fallback consolidates far better here (shared "linked",
			// "gardening" and "isolate" keywords), so it must win over the degenerate Louvain result -
			// and, since it's the winning path, must still come out size-ordered (id 0 largest).
			const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(new Set(communities.values()).size).toBeLessThan(9);
			expect(communities.get('c')).toBe(communities.get('d'));
			expect(communities.get('a')).toBe(communities.get('b'));

			const isolateGroupId = communities.get('e1');
			for (const id of ['e2', 'e3', 'e4', 'e5', 'e6']) {
				expect(communities.get(id)).toBe(isolateGroupId);
			}
			// The 6-note isolate group is the largest community, so it must be id 0.
			expect(isolateGroupId).toBe(0);
		});

		it('keeps the degenerate Louvain result when the keyword/link fallback would not consolidate any better', () => {
			// Every note has a unique keyword and no two notes share more than one edge, so the
			// keyword/link fallback can only merge exactly the pairs already directly linked -
			// no better than what Louvain itself found. Falling back here would be a lateral move,
			// not an improvement, so the (degenerate) Louvain result should be kept.
			const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
			const uniqueTopics = [
				'Aardvark',
				'Butterfly',
				'Crocodile',
				'Dolphin',
				'Elephant',
				'Flamingo',
				'Giraffe',
				'Hedgehog',
				'Iguana',
				'Jellyfish',
			];
			const notes = ids.map((id, i) => note(id, uniqueTopics[i]));
			const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('a')).toBe(communities.get('b'));
			expect(new Set(communities.values()).size).toBe(9);
		});

		it('keeps the degenerate Louvain result rather than a keyword/link fallback that collapses almost everyone into one bucket', () => {
			// A realistic collapse trigger: templated titles ("Daily Log Entry N") share the same
			// dominant keyword across the whole vault, since the fallback can't tell a meaningful
			// recurring topic from an incidental template. Falling back here would trade a
			// too-fragmented Louvain result for a too-collapsed one - neither is an improvement,
			// so the degenerate Louvain result should be kept.
			const notes = Array.from({ length: 10 }, (_, i) => note(`d${i}`, `Daily Log Entry ${i}`));
			const edges: GraphEdge[] = [{ source: 'd0', target: 'd1', type: 'link' }];

			const communities = detector.detectCommunities(notes, edges);

			expect(communities.get('d0')).toBe(communities.get('d1'));
			expect(new Set(communities.values()).size).toBe(9);
		});
	});
});
