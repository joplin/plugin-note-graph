import { ResolvedScope, WHOLE_VAULT_SCOPE } from '../settings/NoteScopeResolver';
import {
	DEFAULT_VIEW_LIMITS,
	GraphViewBuilder,
	GraphViewLimits,
	GraphViewRequest,
} from './GraphViewBuilder';
import { GraphData, GraphNode, RenderedEdge, TAG_NAME_SEPARATOR } from './types';

function note(id: string, notebookId = 'nb', extra: Partial<GraphNode> = {}) {
	return {
		data: {
			id,
			label: `Note ${id}`,
			noteId: id,
			degree: 1,
			community: 0,
			size: 1,
			notebookId,
			...extra,
		},
	};
}

function tagged(id: string, notebookId: string, ...tags: string[]) {
	return note(id, notebookId, { tagNames: tags.join(TAG_NAME_SEPARATOR) });
}

function edge(
	source: string,
	target: string,
	type: RenderedEdge['type'],
	extra: Partial<RenderedEdge> = {}
) {
	return { data: { id: `${source}::${target}::${type}`, source, target, type, ...extra } };
}

function notebook(label: string, ...folderIds: string[]): ResolvedScope {
	return {
		folderIds: new Set(folderIds),
		scopeKey: `current:${folderIds[0]}`,
		label,
		notebookTitles: new Map([
			['nb', 'Mine'],
			['other', 'Elsewhere'],
		]),
		followsSelection: true,
	};
}

const MINE = notebook('Mine', 'nb');

const SMALL_LIMITS: GraphViewLimits = {
	maxNodes: 10,
	maxEdges: 20,
	maxOutsideNotes: 3,
	maxNeighborhoodNodes: 5,
};

/** Notes joined in a chain, so each is exactly one step further from the first. */
function chain(count: number): GraphData {
	const nodes = Array.from({ length: count }, (_, i) => note(`n${i}`));
	const edges = Array.from({ length: count - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`, 'link'));
	return { nodes, edges };
}

function ids(view: { data: GraphData }): string[] {
	return view.data.nodes.map((node) => node.data.id);
}

describe('GraphViewBuilder', () => {
	const build = (
		graph: GraphData,
		scope: ResolvedScope = MINE,
		request: GraphViewRequest = { kind: 'auto' },
		tag: string | null = null,
		limits: GraphViewLimits = SMALL_LIMITS
	) => new GraphViewBuilder(limits).build(graph, request, { scope, tag });

	describe('at the size of the vault that crashed', () => {
		const notes = Array.from({ length: 10500 }, (_, i) => note(`n${i}`, `nb${i % 8}`));
		const edges = notes.slice(1).map((n, i) => edge(`n${i}`, n.data.id, 'tag'));
		const graph = { nodes: notes, edges };

		it('never hands the panel more than the limits, whichever view it is', () => {
			const views = [
				build(graph, notebook('Big', 'nb0'), { kind: 'auto' }, null, DEFAULT_VIEW_LIMITS),
				build(
					graph,
					notebook('Big', 'nb0'),
					{ kind: 'neighborhood', noteId: 'n5', depth: 3 },
					null,
					DEFAULT_VIEW_LIMITS
				),
				build(graph, WHOLE_VAULT_SCOPE, { kind: 'auto' }, null, DEFAULT_VIEW_LIMITS),
			];

			for (const view of views) {
				expect(view.data.nodes.length).toBeLessThanOrEqual(DEFAULT_VIEW_LIMITS.maxNodes);
				expect(view.data.edges.length).toBeLessThanOrEqual(DEFAULT_VIEW_LIMITS.maxEdges);
			}
		});
	});

	describe('when no notebook is in scope', () => {
		it('draws a small vault whole, with nothing to say about it', () => {
			const graph = { nodes: [note('a'), note('b')], edges: [edge('a', 'b', 'link')] };

			const view = build(graph, WHOLE_VAULT_SCOPE);

			expect(view.kind).toBe('full');
			expect(view.key).toBe('full');
			expect(ids(view)).toEqual(['a', 'b']);
			expect(view.summary).toBe('');
			expect(view.isPartial).toBe(false);
		});

		it("never draws a large vault whole, showing the open note's connections instead", () => {
			const scope = { ...WHOLE_VAULT_SCOPE, openNoteId: 'n1', wholeVaultUnavailable: true };

			const view = build(chain(12), scope);

			expect(view.kind).toBe('neighborhood');
			expect(view.centerNoteId).toBe('n1');
			expect(view.canGoBack).toBe(false);
			expect(view.summary).toContain('too large to draw at once');
		});

		it('asks for a notebook or a note on a large vault with neither open', () => {
			const view = build(chain(12), { ...WHOLE_VAULT_SCOPE, openNoteId: null });

			expect(view.kind).toBe('empty');
			expect(view.data.nodes).toEqual([]);
			expect(view.emptyMessage).toBe('Open a notebook or a note to see its graph.');
			expect(view.isPartial).toBe(true);
		});

		it('does not fall back to an open note that is no longer in the graph', () => {
			const view = build(chain(12), { ...WHOLE_VAULT_SCOPE, openNoteId: 'gone' });

			expect(view.kind).toBe('empty');
		});
	});

	describe('notebook view', () => {
		it('shows the notes in scope, including those in nested notebooks', () => {
			const graph = {
				nodes: [note('a', 'parent'), note('b', 'child'), note('c', 'unrelated')],
				edges: [],
			};

			const view = build(graph, notebook('Parent', 'parent', 'child'));

			expect(view.kind).toBe('notebook');
			expect(ids(view)).toEqual(['a', 'b']);
			expect(view.isPartial).toBe(true);
			expect(view.summary).toBe('');
		});

		it('brings in a note from another notebook that connects to one in scope, marked as outside', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other')],
				edges: [edge('a', 'b', 'link')],
			};

			const view = build(graph);

			expect(ids(view)).toEqual(['a', 'b']);
			expect(view.data.nodes[0].data.outsideScope).toBeUndefined();
			expect(view.data.nodes[1].data.outsideScope).toBe(true);
			expect(view.data.edges).toHaveLength(1);
			expect(view.summary).toBe('1 note, plus 1 connected note from other notebooks.');
		});

		it('leaves the shared graph unmarked, because it is used for every other view', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other')],
				edges: [edge('a', 'b', 'link')],
			};

			build(graph);

			expect(graph.nodes[1].data).not.toHaveProperty('outsideScope');
		});

		it('never lets a ring edge bring a note in, because it says nothing about the pair', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other')],
				edges: [edge('a', 'b', 'tag', { ring: true })],
			};

			expect(ids(build(graph))).toEqual(['a']);
		});

		it('keeps ring edges between notes that are both in scope', () => {
			const graph = {
				nodes: [note('a'), note('b')],
				edges: [edge('a', 'b', 'tag', { ring: true })],
			};

			expect(build(graph).data.edges).toHaveLength(1);
		});

		it('leaves out edges between two outside notes', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other'), note('c', 'other')],
				edges: [edge('a', 'b', 'link'), edge('a', 'c', 'link'), edge('b', 'c', 'link')],
			};

			expect(build(graph).data.edges.map((e) => e.data.id)).toEqual([
				'a::b::link',
				'a::c::link',
			]);
		});

		it('picks outside notes by links first, then similarity, then shared tags', () => {
			const graph = {
				nodes: [
					note('a'),
					note('tag1', 'other'),
					note('sem1', 'other'),
					note('link1', 'other'),
					note('tag2', 'other'),
				],
				edges: [
					edge('a', 'tag1', 'tag'),
					edge('a', 'tag2', 'tag'),
					edge('a', 'sem1', 'semantic', { score: 0.9 }),
					edge('a', 'link1', 'link'),
				],
			};

			expect(ids(build(graph))).toEqual(['a', 'link1', 'sem1', 'tag1']);
		});

		it('prefers the outside note with more connections, then the higher score', () => {
			const graph = {
				nodes: [
					note('a'),
					note('b'),
					note('weak', 'other'),
					note('strong', 'other'),
					note('both', 'other'),
				],
				edges: [
					edge('a', 'weak', 'semantic', { score: 0.1 }),
					edge('a', 'strong', 'semantic', { score: 0.9 }),
					edge('a', 'both', 'semantic', { score: 0.2 }),
					edge('b', 'both', 'semantic', { score: 0.2 }),
				],
			};

			expect(ids(build(graph))).toEqual(['a', 'b', 'both', 'strong', 'weak']);
		});

		it('shows the most connected notes of a notebook too large to fit, and says so', () => {
			const nodes = Array.from({ length: 15 }, (_, i) => note(`n${i}`, 'nb', { degree: i }));

			const view = build({ nodes, edges: [] });

			expect(ids(view)).toEqual(Array.from({ length: 10 }, (_, i) => `n${14 - i}`));
			expect(view.summary).toBe(
				'Showing the 10 most connected of 15 notes. Search to reach the rest.'
			);
		});

		it('keeps room for outside notes when a notebook is too large to fit', () => {
			const nodes = [
				...Array.from({ length: 15 }, (_, i) => note(`n${i}`, 'nb', { degree: 15 - i })),
				note('x', 'other'),
			];

			const view = build({ nodes, edges: [edge('n0', 'x', 'link')] });

			expect(view.data.nodes).toHaveLength(10);
			expect(ids(view)).toContain('x');
			expect(view.summary).toContain('howing the 9 most connected of 15 notes');
			expect(view.summary).toContain('plus 1 connected note');
		});

		it('does not call a note in scope "outside" just because it did not fit', () => {
			const nodes = Array.from({ length: 15 }, (_, i) =>
				note(`n${i}`, 'nb', { degree: 15 - i })
			);

			const view = build({ nodes, edges: [edge('n0', 'n14', 'link')] });

			expect(ids(view)).not.toContain('n14');
			expect(view.data.nodes.every((n) => !n.data.outsideScope)).toBe(true);
		});

		it('caps the outside notes', () => {
			const outside = Array.from({ length: 6 }, (_, i) => note(`x${i}`, 'other'));
			const graph = {
				nodes: [note('a'), ...outside],
				edges: outside.map((n) => edge('a', n.data.id, 'link')),
			};

			expect(build(graph).data.nodes).toHaveLength(1 + SMALL_LIMITS.maxOutsideNotes);
		});

		it('names the notebooks of the notes it shows', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other')],
				edges: [edge('a', 'b', 'link')],
			};

			expect(build(graph).notebookTitles).toEqual({ nb: 'Mine', other: 'Elsewhere' });
		});

		it('says so when the notebook has no notes', () => {
			const view = build({ nodes: [note('a', 'other')], edges: [] });

			expect(view.data.nodes).toEqual([]);
			expect(view.emptyMessage).toBe('Mine has no notes.');
		});

		it('gives each notebook its own key, so moving between them redraws', () => {
			const graph = { nodes: [note('a'), note('b', 'other')], edges: [] };

			expect(build(graph, notebook('A', 'nb')).key).not.toBe(
				build(graph, notebook('B', 'other')).key
			);
		});

		it('tells a user who chose all notebooks why they see less', () => {
			const view = build(chain(2), { ...MINE, wholeVaultUnavailable: true });

			expect(view.summary).toContain('too large to draw at once');
		});
	});

	describe('edge limit', () => {
		const limits = { ...SMALL_LIMITS, maxEdges: 2 };
		const graph = {
			nodes: [note('a'), note('b'), note('c'), note('d')],
			edges: [
				edge('a', 'b', 'tag', { ring: true }),
				edge('b', 'c', 'tag'),
				edge('c', 'd', 'semantic', { score: 0.5 }),
				edge('a', 'd', 'link'),
			],
		};

		it('keeps links first, then semantic, then tags, with ring edges last', () => {
			const view = build(graph, MINE, { kind: 'auto' }, null, limits);

			expect(view.data.edges.map((e) => e.data.type)).toEqual(['link', 'semantic']);
		});

		it('says how many connections were left out', () => {
			const view = build(graph, MINE, { kind: 'auto' }, null, limits);

			expect(view.summary).toContain('Showing 2 of 4 connections.');
		});

		it('says so on a whole-vault view too', () => {
			const view = build(graph, WHOLE_VAULT_SCOPE, { kind: 'auto' }, null, limits);

			expect(view.kind).toBe('full');
			expect(view.summary).toBe('Showing 2 of 4 connections.');
		});

		it('does not change the graph it was given', () => {
			const before = graph.edges.map((e) => e.data.id);

			build(graph, MINE, { kind: 'auto' }, null, limits);

			expect(graph.edges.map((e) => e.data.id)).toEqual(before);
		});
	});

	describe('tag filter', () => {
		const graph = {
			nodes: [
				tagged('a', 'nb', 'work', 'urgent'),
				tagged('b', 'nb', 'work'),
				tagged('c', 'nb', 'home'),
				tagged('x', 'other', 'work'),
				tagged('y', 'other', 'home'),
			],
			edges: [edge('a', 'x', 'link'), edge('a', 'y', 'link')],
		};

		it('shows only the notes in scope with that tag, and only outside notes with it', () => {
			expect(ids(build(graph, MINE, { kind: 'auto' }, 'work'))).toEqual(['a', 'b', 'x']);
		});

		it('reaches a tagged note that would not fit in the unfiltered view', () => {
			const nodes = [
				...Array.from({ length: 15 }, (_, i) => note(`n${i}`, 'nb', { degree: 100 })),
				tagged('rare', 'nb', 'work'),
			];

			expect(ids(build({ nodes, edges: [] }, MINE, { kind: 'auto' }, 'work'))).toEqual([
				'rare',
			]);
		});

		it('works without any notebook in scope', () => {
			const view = build(graph, WHOLE_VAULT_SCOPE, { kind: 'auto' }, 'home');

			expect(ids(view)).toEqual(['c', 'y']);
			expect(view.kind).toBe('full');
		});

		it('offers the tags in scope, most used first, however it is filtered', () => {
			const options = [
				{ name: 'work', noteCount: 2 },
				{ name: 'home', noteCount: 1 },
				{ name: 'urgent', noteCount: 1 },
			];

			expect(build(graph).tagOptions).toEqual(options);
			expect(build(graph, MINE, { kind: 'auto' }, 'urgent').tagOptions).toEqual(options);
		});

		it('offers at most 200 tags, so the message stays small', () => {
			const tags = Array.from({ length: 300 }, (_, i) => `tag${i}`);

			expect(
				build({ nodes: [tagged('a', 'nb', ...tags)], edges: [] }).tagOptions
			).toHaveLength(200);
		});

		it('reports the tag in use, and gives the filtered view its own key', () => {
			const plain = build(graph);
			const filtered = build(graph, MINE, { kind: 'auto' }, 'work');

			expect(plain.activeTag).toBeNull();
			expect(filtered.activeTag).toBe('work');
			expect(filtered.key).not.toBe(plain.key);
			expect(filtered.summary).toContain('Tag "work"');
		});

		it('says so when no note in scope has the tag', () => {
			const view = build(graph, MINE, { kind: 'auto' }, 'missing');

			expect(view.data.nodes).toEqual([]);
			expect(view.emptyMessage).toBe('No notes tagged "missing" in Mine.');
		});

		it('tells apart two tags that only look alike when run together', () => {
			const nodes = [tagged('a', 'nb', 'work life'), tagged('b', 'nb', 'work')];

			expect(ids(build({ nodes, edges: [] }, MINE, { kind: 'auto' }, 'work'))).toEqual(['b']);
		});
	});

	describe('connections view', () => {
		const open = (noteId: string, depth?: number) => ({
			kind: 'neighborhood' as const,
			noteId,
			depth,
		});

		it('goes as many steps out as the depth says', () => {
			const graph = chain(8);

			expect(ids(build(graph, MINE, open('n0', 1)))).toEqual(['n0', 'n1']);
			expect(ids(build(graph, MINE, open('n0', 2)))).toEqual(['n0', 'n1', 'n2']);
			expect(ids(build(graph, MINE, open('n0', 3)))).toEqual(['n0', 'n1', 'n2', 'n3']);
		});

		it('uses two steps by default, and reports the depth it used', () => {
			const view = build(chain(8), MINE, open('n0'));

			expect(view.depth).toBe(2);
			expect(ids(view)).toEqual(['n0', 'n1', 'n2']);
		});

		it.each([
			[0, 1],
			[-5, 1],
			[9, 3],
			[1.6, 2],
			[Number.NaN, 2],
		])('turns a depth of %s into %s', (requested, used) => {
			expect(build(chain(8), MINE, open('n0', requested)).depth).toBe(used);
		});

		it('gives each depth its own key, so changing depth redraws', () => {
			const graph = chain(8);

			expect(build(graph, MINE, open('n0', 1)).key).not.toBe(
				build(graph, MINE, open('n0', 2)).key
			);
		});

		it('includes notes from any notebook, whatever the scope', () => {
			const graph = {
				nodes: [note('a'), note('b', 'other')],
				edges: [edge('a', 'b', 'link')],
			};

			const view = build(graph, MINE, open('a'));

			expect(ids(view)).toEqual(['a', 'b']);
			expect(view.data.nodes[1].data.outsideScope).toBeUndefined();
		});

		it('stops at the limit, nearest notes first, and says what it left out', () => {
			const spokes = Array.from({ length: 3 }, (_, i) => note(`near${i}`));
			const far = Array.from({ length: 6 }, (_, i) => note(`far${i}`));
			const graph = {
				nodes: [note('c'), ...spokes, ...far],
				edges: [
					...far.map((n) => edge('near0', n.data.id, 'link')),
					...spokes.map((n) => edge('c', n.data.id, 'tag')),
				],
			};

			const view = build(graph, MINE, open('c', 2));

			expect(view.data.nodes).toHaveLength(SMALL_LIMITS.maxNeighborhoodNodes);
			expect(ids(view)).toEqual(expect.arrayContaining(['c', 'near0', 'near1', 'near2']));
			expect(view.summary).toBe('Connections of Note c: showing 5 of 10 notes.');
		});

		it('follows the strongest connections first when not all of them fit', () => {
			const others = Array.from({ length: 6 }, (_, i) => note(`t${i}`));
			const graph = {
				nodes: [note('c'), ...others, note('linked')],
				edges: [
					...others.map((n) => edge('c', n.data.id, 'tag')),
					edge('c', 'linked', 'link'),
				],
			};

			expect(ids(build(graph, MINE, open('c', 1)))).toContain('linked');
		});

		it('has a way back when the user opened it, and no filter', () => {
			const view = build(chain(3), MINE, open('n0'), 'work');

			expect(view.canGoBack).toBe(true);
			expect(view.tagOptions).toEqual([]);
			expect(view.activeTag).toBeNull();
		});

		it('falls back to the main view when the note no longer exists', () => {
			expect(build(chain(3), MINE, open('gone')).kind).toBe('notebook');
		});
	});

	describe('search', () => {
		const graph = {
			nodes: [note('apple'), note('pineapple', 'other'), note('pear')],
			edges: [],
		};
		const builder = new GraphViewBuilder();

		it('finds notes in any notebook, with prefix matches first', () => {
			graph.nodes[0].data.label = 'pineapple';
			graph.nodes[1].data.label = 'apple';

			expect(builder.search(graph, 'apple').map((r) => r.noteId)).toEqual([
				'pineapple',
				'apple',
			]);
		});

		it('returns nothing for an empty query', () => {
			expect(builder.search(graph, '   ')).toEqual([]);
		});

		it('stops at 20 results', () => {
			const many = { nodes: Array.from({ length: 50 }, (_, i) => note(`n${i}`)), edges: [] };

			expect(builder.search(many, 'note')).toHaveLength(20);
		});
	});

	describe('totals', () => {
		const graph = {
			nodes: [note('a'), note('b'), note('x', 'other'), note('y', 'other')],
			edges: [
				edge('a', 'b', 'link'),
				edge('a', 'x', 'semantic'),
				edge('b', 'x', 'tag', { tagName: 'work, home' }),
				edge('x', 'y', 'link'),
				edge('x', 'y', 'tag', { tagName: 'elsewhere' }),
			],
		};

		it('counts the notebook and what touches it, not the rest of the vault', () => {
			expect(build(graph).totals).toEqual({ notes: 2, explicit: 1, semantic: 1, tags: 2 });
		});

		it('counts what a connections view draws, not the notebook', () => {
			const view = build(graph, MINE, { kind: 'neighborhood', noteId: 'y', depth: 1 });

			expect(view.totals).toEqual({ notes: 2, explicit: 1, semantic: 0, tags: 1 });
		});

		it('counts everything when no notebook is in scope', () => {
			expect(build(graph, WHOLE_VAULT_SCOPE).totals).toEqual({
				notes: 4,
				explicit: 2,
				semantic: 1,
				tags: 3,
			});
		});
	});

	it('sends only plain values on nodes, because patches compare them with ===', () => {
		const graph = {
			nodes: [tagged('a', 'nb', 'x', 'y'), note('b', 'other')],
			edges: [edge('a', 'b', 'link')],
		};

		for (const { data } of build(graph).data.nodes) {
			for (const value of Object.values(data)) expect(typeof value).not.toBe('object');
		}
	});

	it('sees changes in a new graph instead of reusing what it worked out for the last one', () => {
		const builder = new GraphViewBuilder(SMALL_LIMITS);
		const context = { scope: MINE, tag: null };
		builder.build(chain(3), { kind: 'auto' }, context);

		expect(ids(builder.build(chain(2), { kind: 'auto' }, context))).toEqual(['n0', 'n1']);
	});
});
