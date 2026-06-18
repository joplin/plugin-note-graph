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

	it('returns empty array for empty notes', () => {
		expect(factory.createEdges([])).toEqual([]);
	});

	it('returns empty array for notes with no links or tags', () => {
		const notes = [note('a', 'A'), note('b', 'B')];
		expect(factory.createEdges(notes)).toEqual([]);
	});

	it('returns empty for resource links that are not note IDs', () => {
		const notes = [
			note('a', 'A', ['resource123']),
			note('b', 'B', ['resource123']),
		];

		expect(factory.createEdges(notes)).toEqual([]);
	});

	it('creates link edge when note body references another note ID', () => {
		const notes = [
			note('a', 'A', ['b']),
			note('b', 'B', []),
		];

		const edges = factory.createEdges(notes);
		expect(edges).toEqual([{ source: 'a', target: 'b', type: 'link' }]);
	});

	it('creates bidirectional link when notes reference each other', () => {
		const notes = [
			note('a', 'A', ['b']),
			note('b', 'B', ['a']),
		];

		const edges = factory.createEdges(notes);
		expect(edges).toHaveLength(1);
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'link' });
	});

	it('creates tag edges for shared tags', () => {
		const notes = [
			note('a', 'A', [], ['shared']),
			note('b', 'B', [], ['shared']),
		];

		expect(factory.createEdges(notes)).toEqual([
			{ source: 'a', target: 'b', type: 'tag' },
		]);
	});

	it('creates many tag edges for multiple shared tags', () => {
		const notes = [
			note('a', 'A', [], ['t1', 't2']),
			note('b', 'B', [], ['t1', 't2']),
			note('c', 'C', [], ['t1']),
		];

		const edges = factory.createEdges(notes);
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'tag' });
		expect(edges).toContainEqual({ source: 'a', target: 'c', type: 'tag' });
		expect(edges).toContainEqual({ source: 'b', target: 'c', type: 'tag' });
	});

	it('creates both link and tag edges for the same pair', () => {
		const notes = [
			note('a', 'A', ['b'], ['shared']),
			note('b', 'B', [], ['shared']),
		];

		const edges = factory.createEdges(notes);
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'link' });
		expect(edges).toContainEqual({ source: 'a', target: 'b', type: 'tag' });
		expect(edges).toHaveLength(2);
	});

	it('ignores self-referencing links', () => {
		const notes = [
			note('a', 'A', ['a']),
		];

		expect(factory.createEdges(notes)).toEqual([]);
	});
});
