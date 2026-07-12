import { EdgeFactory } from './EdgeFactory';
import { Note } from '../../data/Types';

function note(
	id: string,
	title: string,
	links: string[] = [],
	tags: string[] = []
): Note {
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
		const notes = [
			note('a', 'A', ['resource123']),
			note('b', 'B', ['resource123']),
		];
		expect(factory.createEdges(notes)).toEqual([]);
	});

	it('creates link edge when note body references another note ID', () => {
		const edges = factory.createEdges([
			note('a', 'A', ['b']),
			note('b', 'B', []),
		]);
		expect(edges).toEqual([{ source: 'a', target: 'b', type: 'link' }]);
	});

	it('creates bidirectional links when notes reference each other', () => {
		const edges = factory.createEdges([
			note('a', 'A', ['b']),
			note('b', 'B', ['a']),
		]);
		expect(edges).toHaveLength(2);
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'link' });
		expect(edges).toContainEqual({ source: 'b', target: 'a', type: 'link' });
	});

	it('creates tag edge with tagName for shared tags', () => {
		const edges = factory.createEdges([
			note('a', 'A', [], ['shared']),
			note('b', 'B', [], ['shared']),
		]);
		expect(edges).toEqual([
			{ source: 'a', target: 'b', type: 'tag', tagName: 'shared' },
		]);
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
});
