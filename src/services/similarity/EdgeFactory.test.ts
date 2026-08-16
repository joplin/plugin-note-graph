import { EdgeFactory, TAG_CAPPED_NEIGHBORS_PER_NOTE, TAG_CLIQUE_MAX_NOTES } from './EdgeFactory';
import { Note } from '../../data/Types';

function note(id: string, title: string, links: string[] = [], tags: string[] = []): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body: '',
		created_time: 0,
		updated_time: 1,
		links,
		tags,
	};
}

describe('EdgeFactory', () => {
	let factory: EdgeFactory;

	beforeEach(() => {
		factory = new EdgeFactory();
	});

	it('returns empty for empty notes', () => {
		expect(factory.createEdges([])).toEqual([]);
	});

	it('returns empty for notes with no links or tags', () => {
		expect(factory.createEdges([note('a', 'A'), note('b', 'B')])).toEqual([]);
	});

	it('ignores resource links that are not note IDs', () => {
		const notes = [note('a', 'A', ['resource123']), note('b', 'B', ['resource123'])];
		expect(factory.createEdges(notes)).toEqual([]);
	});

	it('creates link edge when note body references another note ID', () => {
		const edges = factory.createEdges([note('a', 'A', ['b']), note('b', 'B', [])]);
		expect(edges).toEqual([{ source: 'a', target: 'b', type: 'link' }]);
	});

	it('collapses a mutual link into a single edge', () => {
		const edges = factory.createEdges([note('a', 'A', ['b']), note('b', 'B', ['a'])]);
		expect(edges).toEqual([{ source: 'a', target: 'b', type: 'link' }]);
	});

	it('normalizes link edges to id order regardless of authored direction', () => {
		const edges = factory.createEdges([note('z', 'Z', ['a']), note('a', 'A', [])]);
		expect(edges).toEqual([{ source: 'a', target: 'z', type: 'link' }]);
	});

	it('creates tag edge with tagName for shared tags', () => {
		const edges = factory.createEdges([
			note('a', 'A', [], ['shared']),
			note('b', 'B', [], ['shared']),
		]);
		expect(edges).toEqual([{ source: 'a', target: 'b', type: 'tag', tagName: 'shared' }]);
	});

	it('merges multiple shared tag names into one edge', () => {
		const edges = factory.createEdges([
			note('a', 'A', [], ['t1', 't2']),
			note('b', 'B', [], ['t1', 't2']),
		]);
		expect(edges).toHaveLength(1);
		expect(edges[0].type).toBe('tag');
		expect(edges[0].tagName).toBe('t1, t2');
	});

	it('keeps the same source/target for a tag edge regardless of note iteration order', () => {
		const forward = factory.createEdges([
			note('a', 'A', [], ['shared']),
			note('b', 'B', [], ['shared']),
		]);
		const reversed = factory.createEdges([
			note('b', 'B', [], ['shared']),
			note('a', 'A', [], ['shared']),
		]);

		expect(forward).toEqual([{ source: 'a', target: 'b', type: 'tag', tagName: 'shared' }]);
		expect(reversed).toEqual([{ source: 'a', target: 'b', type: 'tag', tagName: 'shared' }]);
	});

	it('keeps the same tagName text regardless of note iteration order, for a pair sharing multiple tags', () => {
		const forward = factory.createEdges([
			note('x', 'X', [], ['t2']),
			note('a', 'A', [], ['t1', 't2']),
			note('b', 'B', [], ['t1', 't2']),
		]);
		const reversed = factory.createEdges([
			note('a', 'A', [], ['t1', 't2']),
			note('b', 'B', [], ['t1', 't2']),
			note('x', 'X', [], ['t2']),
		]);

		const forwardEdge = forward.find(
			(e) => e.type === 'tag' && e.source === 'a' && e.target === 'b'
		);
		const reversedEdge = reversed.find(
			(e) => e.type === 'tag' && e.source === 'a' && e.target === 'b'
		);

		expect(forwardEdge?.tagName).toBe(reversedEdge?.tagName);
	});

	it('creates separate tag edges for different pairs', () => {
		const edges = factory.createEdges([
			note('a', 'A', [], ['t1']),
			note('b', 'B', [], ['t1']),
			note('c', 'C', [], ['t1']),
		]);
		expect(edges).toHaveLength(3);
	});

	it('creates both link and tag edges for the same pair', () => {
		const edges = factory.createEdges([
			note('a', 'A', ['b'], ['shared']),
			note('b', 'B', [], ['shared']),
		]);
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'link' });
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'tag', tagName: 'shared' });
	});

	it('ignores self-referencing links', () => {
		expect(factory.createEdges([note('a', 'A', ['a'])])).toEqual([]);
	});

	describe('large tags (more than TAG_CLIQUE_MAX_NOTES notes)', () => {
		const pad = (i: number): string => String(i).padStart(2, '0');
		const bigTagNotes = (count: number): Note[] =>
			Array.from({ length: count }, (_, i) => note(`n${pad(i)}`, `N${i}`, [], ['big']));

		it('caps each note to TAG_CAPPED_NEIGHBORS_PER_NOTE neighbors instead of skipping the tag', () => {
			const notes = bigTagNotes(TAG_CLIQUE_MAX_NOTES + 1);
			const edges = factory.createEdges(notes).filter((e) => e.type === 'tag');

			expect(edges).toHaveLength(notes.length * TAG_CAPPED_NEIGHBORS_PER_NOTE);

			const degree = new Map<string, number>();
			for (const edge of edges) {
				degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
				degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
			}
			for (const n of notes) {
				expect(degree.get(n.id)).toBe(TAG_CAPPED_NEIGHBORS_PER_NOTE * 2);
			}

			for (const edge of edges) {
				expect(edge.source).not.toBe(edge.target);
			}
		});

		it('keeps a full clique at the threshold and caps just above it', () => {
			const clique = factory
				.createEdges(bigTagNotes(TAG_CLIQUE_MAX_NOTES))
				.filter((e) => e.type === 'tag');
			expect(clique).toHaveLength((TAG_CLIQUE_MAX_NOTES * (TAG_CLIQUE_MAX_NOTES - 1)) / 2);

			const capped = factory
				.createEdges(bigTagNotes(TAG_CLIQUE_MAX_NOTES + 1))
				.filter((e) => e.type === 'tag');
			expect(capped).toHaveLength((TAG_CLIQUE_MAX_NOTES + 1) * TAG_CAPPED_NEIGHBORS_PER_NOTE);
		});

		it('produces identical edges regardless of note iteration order', () => {
			const forward = factory.createEdges(bigTagNotes(TAG_CLIQUE_MAX_NOTES + 1));
			const reversed = factory.createEdges(bigTagNotes(TAG_CLIQUE_MAX_NOTES + 1).reverse());
			expect(forward).toEqual(reversed);
		});

		it('merges a small-tag pair onto the same edge when it is also connected by a capped tag', () => {
			const notes = bigTagNotes(TAG_CLIQUE_MAX_NOTES + 1);
			notes[0].tags = ['big', 'small'];
			notes[1].tags = ['big', 'small'];

			const edges = factory.createEdges(notes).filter((e) => e.type === 'tag');
			const shared = edges.find((e) => e.source === 'n00' && e.target === 'n01');

			expect(shared).toBeDefined();
			expect(shared!.tagName).toBe('big, small');
		});
	});

	describe('createSemanticEdges', () => {
		it('returns empty for no pairs', () => {
			expect(factory.createSemanticEdges([])).toEqual([]);
		});

		it('creates a semantic edge for each positive-score pair', () => {
			const edges = factory.createSemanticEdges([{ source: 'a', target: 'b', score: 0.8 }]);
			expect(edges).toEqual([{ source: 'a', target: 'b', type: 'semantic', score: 0.8 }]);
		});

		it('excludes pairs with a non-positive score', () => {
			const edges = factory.createSemanticEdges([
				{ source: 'a', target: 'b', score: 0 },
				{ source: 'c', target: 'd', score: -0.1 },
			]);
			expect(edges).toEqual([]);
		});
	});
});
