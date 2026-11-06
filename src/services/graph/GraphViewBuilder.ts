import { ResolvedScope } from '../settings/NoteScopeResolver';
import { GraphData, GraphNode, RenderedEdge, TAG_NAME_SEPARATOR } from './types';

export const MIN_CONNECTION_DEPTH = 1;
export const MAX_CONNECTION_DEPTH = 3;
export const DEFAULT_CONNECTION_DEPTH = 2;

export type GraphViewRequest =
	| { kind: 'auto' }
	| { kind: 'neighborhood'; noteId: string; depth?: number };

export type GraphViewKind = 'full' | 'notebook' | 'neighborhood' | 'empty';

export interface GraphTotals {
	notes: number;
	explicit: number;
	semantic: number;
	tags: number;
}

export interface TagOption {
	name: string;
	noteCount: number;
}

export interface GraphView {
	kind: GraphViewKind;
	/** Identifies what this view shows, so a later rebuild of the same view can be applied as a patch. */
	key: string;
	/** One line describing the view, including anything left out of it. Empty when there's nothing to say. */
	summary: string;
	data: GraphData;
	/** For the notebooks in scope, not just what this view draws. */
	totals: GraphTotals;
	/** True when the vault is too large to draw whole, so "All notebooks" isn't offered. */
	isLarge: boolean;
	/** True when some notes aren't on screen, so a search has to ask the plugin. */
	isPartial: boolean;
	canGoBack: boolean;
	scopeLabel: string;
	notebookTitles: Record<string, string>;
	/** Empty when this view can't be filtered by tag. */
	tagOptions: TagOption[];
	activeTag: string | null;
	centerNoteId?: string;
	depth?: number;
	/** What to say in place of a graph, when there are no notes to draw. */
	emptyMessage?: string;
}

export interface NoteSearchResult {
	noteId: string;
	label: string;
}

export interface GraphViewLimits {
	maxNodes: number;
	maxEdges: number;
	maxOutsideNotes: number;
	maxNeighborhoodNodes: number;
}

export const DEFAULT_VIEW_LIMITS: GraphViewLimits = {
	maxNodes: 1500,
	maxEdges: 3000,
	maxOutsideNotes: 300,
	maxNeighborhoodNodes: 300,
};

export interface ViewContext {
	scope: ResolvedScope;
	tag: string | null;
}

const MAX_SEARCH_RESULTS = 20;
const MAX_TAG_OPTIONS = 200;
const FULL_VIEW_KEY = 'full';

type NodeEntry = { data: GraphNode };
type EdgeEntry = { data: RenderedEdge };

interface GraphIndex {
	nodeById: Map<string, NodeEntry>;
	edgesByNote: Map<string, EdgeEntry[]>;
}

interface OutsideRank {
	entry: NodeEntry;
	bestPriority: number;
	connections: number;
	bestScore: number;
}

/** Link edges were written by the user, so they go first; ring edges tie arbitrary notes together, so they go last. */
function edgePriority(edge: RenderedEdge): number {
	if (edge.type === 'link') return 0;
	if (edge.type === 'semantic') return 1;
	return edge.ring ? 3 : 2;
}

function compareEdges(a: EdgeEntry, b: EdgeEntry): number {
	return edgePriority(a.data) - edgePriority(b.data) || (b.data.score ?? 0) - (a.data.score ?? 0);
}

function compareOutsideRanks(a: OutsideRank, b: OutsideRank): number {
	return (
		a.bestPriority - b.bestPriority ||
		b.connections - a.connections ||
		b.bestScore - a.bestScore ||
		(a.entry.data.id < b.entry.data.id ? -1 : 1)
	);
}

function noteTags(node: GraphNode): string[] {
	return node.tagNames ? node.tagNames.split(TAG_NAME_SEPARATOR) : [];
}

function clampDepth(depth: number | undefined): number {
	if (typeof depth !== 'number' || !Number.isFinite(depth)) return DEFAULT_CONNECTION_DEPTH;
	return Math.min(MAX_CONNECTION_DEPTH, Math.max(MIN_CONNECTION_DEPTH, Math.round(depth)));
}

function noteCountLabel(count: number): string {
	return `${count} ${count === 1 ? 'note' : 'notes'}`;
}

/**
 * Turns the whole graph into a view the panel can draw. No view ever exceeds the
 * limits, however large the vault is, so the cost of drawing stays fixed.
 */
export class GraphViewBuilder {
	private indexedGraph: GraphData | null = null;
	private index: GraphIndex | null = null;

	public constructor(private readonly limits: GraphViewLimits = DEFAULT_VIEW_LIMITS) {}

	public build(graph: GraphData, request: GraphViewRequest, context: ViewContext): GraphView {
		const index = this.indexFor(graph);
		const { scope } = context;

		if (request.kind === 'neighborhood' && index.nodeById.has(request.noteId)) {
			return this.buildNeighborhood(
				graph,
				index,
				request.noteId,
				request.depth,
				context,
				true
			);
		}
		if (scope.folderIds || !this.isLarge(graph)) {
			return this.buildMainView(graph, index, context);
		}
		if (scope.openNoteId && index.nodeById.has(scope.openNoteId)) {
			return this.buildNeighborhood(
				graph,
				index,
				scope.openNoteId,
				undefined,
				context,
				false
			);
		}
		return this.buildEmpty(graph, context);
	}

	public isLarge(graph: GraphData): boolean {
		return graph.nodes.length > this.limits.maxNodes;
	}

	public search(graph: GraphData, query: string): NoteSearchResult[] {
		const needle = query.trim().toLowerCase();
		if (!needle) return [];

		const startsWith: NoteSearchResult[] = [];
		const contains: NoteSearchResult[] = [];
		for (const { data } of graph.nodes) {
			const position = data.label.toLowerCase().indexOf(needle);
			if (position === 0) {
				startsWith.push({ noteId: data.id, label: data.label });
				if (startsWith.length >= MAX_SEARCH_RESULTS) break;
			} else if (position > 0 && contains.length < MAX_SEARCH_RESULTS) {
				contains.push({ noteId: data.id, label: data.label });
			}
		}
		return [...startsWith, ...contains].slice(0, MAX_SEARCH_RESULTS);
	}

	/** What a scope shows: its notes, most connected first if they don't all fit, plus the notes elsewhere that connect to them. */
	private buildMainView(graph: GraphData, index: GraphIndex, context: ViewContext): GraphView {
		const { scope, tag } = context;
		const inScope = graph.nodes.filter((node) => this.isInScope(node, scope));
		const members = tag ? inScope.filter((node) => noteTags(node.data).includes(tag)) : inScope;

		const shown = this.limitMembers(members, index, context);
		const outside = this.rankOutsideNotes(shown, index, context).slice(
			0,
			this.limits.maxOutsideNotes
		);
		const nodes = [
			...shown,
			...outside.map(({ data }) => ({ data: { ...data, outsideScope: true } })),
		];
		const edges = this.edgesTouching(graph, shown, outside);
		const limitedEdges = this.limitEdges(edges);

		return {
			...this.commonDetails(graph, nodes, context),
			kind: scope.folderIds ? 'notebook' : 'full',
			key: this.mainViewKey(context),
			summary: this.summarizeMainView(context, shown.length, members.length, outside.length, {
				shown: limitedEdges.length,
				available: edges.length,
			}),
			data: {
				nodes,
				edges: limitedEdges,
				allNotesVeryShort: scope.folderIds ? undefined : graph.allNotesVeryShort,
			},
			canGoBack: false,
			tagOptions: this.tagOptionsFor(inScope),
			activeTag: tag,
			emptyMessage: members.length > 0 ? undefined : this.describeNoNotes(context),
		};
	}

	private describeNoNotes({ scope, tag }: ViewContext): string {
		return tag ? `No notes tagged "${tag}" in ${scope.label}.` : `${scope.label} has no notes.`;
	}

	private isInScope(node: NodeEntry, scope: ResolvedScope): boolean {
		return !scope.folderIds || scope.folderIds.has(node.data.notebookId ?? '');
	}

	private mainViewKey({ scope, tag }: ViewContext): string {
		const base = scope.folderIds ? `notebook::${scope.scopeKey}` : FULL_VIEW_KEY;
		return tag ? `${base}::tag::${tag}` : base;
	}

	/** Leaves room for the outside notes, so a very large notebook still shows what connects to it. */
	private limitMembers(
		members: NodeEntry[],
		index: GraphIndex,
		context: ViewContext
	): NodeEntry[] {
		if (members.length <= this.limits.maxNodes - this.limits.maxOutsideNotes) return members;

		const outsideCount = Math.min(
			this.rankOutsideNotes(members, index, context).length,
			this.limits.maxOutsideNotes
		);
		const room = this.limits.maxNodes - outsideCount;
		if (members.length <= room) return members;
		return [...members].sort((a, b) => b.data.degree - a.data.degree).slice(0, room);
	}

	/** Ring edges carry no meaning about a particular pair, so they never bring a note in. */
	private rankOutsideNotes(
		shown: NodeEntry[],
		index: GraphIndex,
		{ scope, tag }: ViewContext
	): NodeEntry[] {
		if (!scope.folderIds) return [];

		const ranks = new Map<string, OutsideRank>();
		for (const { data: note } of shown) {
			for (const { data: edge } of index.edgesByNote.get(note.id) ?? []) {
				if (edge.ring) continue;

				const otherId = edge.source === note.id ? edge.target : edge.source;
				const other = index.nodeById.get(otherId);
				if (!other || this.isInScope(other, scope)) continue;
				if (tag && !noteTags(other.data).includes(tag)) continue;

				this.recordConnection(ranks, other, edge);
			}
		}
		return Array.from(ranks.values())
			.sort(compareOutsideRanks)
			.map(({ entry }) => entry);
	}

	private recordConnection(
		ranks: Map<string, OutsideRank>,
		entry: NodeEntry,
		edge: RenderedEdge
	): void {
		const rank = ranks.get(entry.data.id) ?? {
			entry,
			bestPriority: Infinity,
			connections: 0,
			bestScore: 0,
		};
		rank.bestPriority = Math.min(rank.bestPriority, edgePriority(edge));
		rank.bestScore = Math.max(rank.bestScore, edge.score ?? 0);
		rank.connections++;
		ranks.set(entry.data.id, rank);
	}

	/** An edge between two outside notes says nothing about the notes in scope, so it's left out. */
	private edgesTouching(graph: GraphData, shown: NodeEntry[], outside: NodeEntry[]): EdgeEntry[] {
		const shownIds = new Set(shown.map((node) => node.data.id));
		const outsideIds = new Set(outside.map((node) => node.data.id));
		return graph.edges.filter(({ data }) => {
			const sourceShown = shownIds.has(data.source);
			const targetShown = shownIds.has(data.target);
			return (
				(sourceShown && targetShown) ||
				(sourceShown && outsideIds.has(data.target)) ||
				(targetShown && outsideIds.has(data.source))
			);
		});
	}

	private tagOptionsFor(nodes: NodeEntry[]): TagOption[] {
		const counts = new Map<string, number>();
		for (const { data } of nodes) {
			for (const name of noteTags(data)) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return Array.from(counts, ([name, noteCount]) => ({ name, noteCount }))
			.sort((a, b) => b.noteCount - a.noteCount || (a.name < b.name ? -1 : 1))
			.slice(0, MAX_TAG_OPTIONS);
	}

	private summarizeMainView(
		{ scope, tag }: ViewContext,
		shown: number,
		available: number,
		outside: number,
		edges: { shown: number; available: number }
	): string {
		const name = tag ? `Tag "${tag}"` : '';
		const elsewhere =
			outside > 0
				? `plus ${outside} connected ${
						outside === 1 ? 'note' : 'notes'
				  } from other notebooks`
				: '';
		const notes =
			shown < available
				? `showing the ${shown} most connected of ${noteCountLabel(available)}`
				: name || elsewhere
				? noteCountLabel(available)
				: '';

		const parts = [
			this.unavailableNotice(scope),
			[name, [notes, elsewhere].filter(Boolean).join(', ')].filter(Boolean).join(': '),
			shown < available ? 'Search to reach the rest.' : '',
			this.describeEdgeLimit(edges),
		];
		return this.joinSentences(parts);
	}

	private unavailableNotice(scope: ResolvedScope): string {
		return scope.wholeVaultUnavailable
			? 'This vault is too large to draw at once, so only part of it is shown.'
			: '';
	}

	private describeEdgeLimit({ shown, available }: { shown: number; available: number }): string {
		return shown < available ? `Showing ${shown} of ${available} connections.` : '';
	}

	private joinSentences(parts: string[]): string {
		return parts
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
			.join(' ');
	}

	private buildNeighborhood(
		graph: GraphData,
		index: GraphIndex,
		noteId: string,
		requestedDepth: number | undefined,
		context: ViewContext,
		canGoBack: boolean
	): GraphView {
		const depth = clampDepth(requestedDepth);
		const reachable = this.reachableCount(index, noteId, depth);
		const included = this.closestNotes(index, noteId, depth);

		const nodes = Array.from(included, (id) => index.nodeById.get(id) as NodeEntry);
		const center = index.nodeById.get(noteId) as NodeEntry;
		const edges = graph.edges.filter(
			({ data }) => included.has(data.source) && included.has(data.target)
		);
		const limitedEdges = this.limitEdges(edges);

		const title = `Connections of ${center.data.label}`;
		return {
			...this.commonDetails(graph, nodes, context),
			totals: this.drawnTotals(nodes, limitedEdges),
			kind: 'neighborhood',
			key: `neighborhood::${noteId}::${depth}`,
			summary: this.joinSentences([
				canGoBack ? '' : this.unavailableNotice(context.scope),
				nodes.length < reachable
					? `${title}: showing ${nodes.length} of ${reachable} notes`
					: title,
				this.describeEdgeLimit({ shown: limitedEdges.length, available: edges.length }),
			]),
			data: { nodes, edges: limitedEdges },
			canGoBack,
			tagOptions: [],
			activeTag: null,
			centerNoteId: noteId,
			depth,
		};
	}

	/** How many notes are within `depth` steps, counting the note itself. Tells the user what a limit left out. */
	private reachableCount(index: GraphIndex, noteId: string, depth: number): number {
		const reached = new Set([noteId]);
		let frontier = [noteId];
		for (let step = 0; step < depth && frontier.length > 0; step++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const { data } of index.edgesByNote.get(id) ?? []) {
					const otherId = data.source === id ? data.target : data.source;
					if (reached.has(otherId)) continue;
					reached.add(otherId);
					next.push(otherId);
				}
			}
			frontier = next;
		}
		return reached.size;
	}

	/** Takes the nearest notes first, and the strongest connections first at each step, until the limit. */
	private closestNotes(index: GraphIndex, noteId: string, depth: number): Set<string> {
		const included = new Set([noteId]);
		let frontier = [noteId];
		for (let step = 0; step < depth && frontier.length > 0; step++) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const otherId of this.neighborsByStrength(index, id)) {
					if (included.size >= this.limits.maxNeighborhoodNodes) return included;
					if (included.has(otherId)) continue;
					included.add(otherId);
					next.push(otherId);
				}
			}
			frontier = next;
		}
		return included;
	}

	private neighborsByStrength(index: GraphIndex, noteId: string): string[] {
		return [...(index.edgesByNote.get(noteId) ?? [])]
			.sort(compareEdges)
			.map(({ data }) => (data.source === noteId ? data.target : data.source));
	}

	private buildEmpty(graph: GraphData, context: ViewContext): GraphView {
		return {
			...this.commonDetails(graph, [], context),
			kind: 'empty',
			key: 'empty',
			summary: this.unavailableNotice(context.scope),
			data: { nodes: [], edges: [] },
			canGoBack: false,
			tagOptions: [],
			activeTag: null,
			emptyMessage: 'Open a notebook or a note to see its graph.',
		};
	}

	private commonDetails(
		graph: GraphData,
		nodes: NodeEntry[],
		{ scope }: ViewContext
	): Pick<GraphView, 'totals' | 'isLarge' | 'isPartial' | 'scopeLabel' | 'notebookTitles'> {
		return {
			totals: this.computeTotals(graph, scope),
			isLarge: this.isLarge(graph),
			isPartial: nodes.length < graph.nodes.length,
			scopeLabel: scope.label,
			notebookTitles: this.notebookTitlesOf(nodes, scope),
		};
	}

	private notebookTitlesOf(nodes: NodeEntry[], scope: ResolvedScope): Record<string, string> {
		const titles: Record<string, string> = {};
		for (const { data } of nodes) {
			const title = data.notebookId ? scope.notebookTitles.get(data.notebookId) : undefined;
			if (title !== undefined) titles[data.notebookId as string] = title;
		}
		return titles;
	}

	private limitEdges(edges: EdgeEntry[]): EdgeEntry[] {
		if (edges.length <= this.limits.maxEdges) return edges;
		return [...edges].sort(compareEdges).slice(0, this.limits.maxEdges);
	}

	private indexFor(graph: GraphData): GraphIndex {
		if (this.indexedGraph !== graph || !this.index) {
			this.index = this.buildIndex(graph);
			this.indexedGraph = graph;
		}
		return this.index;
	}

	private buildIndex(graph: GraphData): GraphIndex {
		const edgesByNote = new Map<string, EdgeEntry[]>();
		for (const edge of graph.edges) {
			for (const noteId of [edge.data.source, edge.data.target]) {
				const list = edgesByNote.get(noteId);
				if (list) {
					list.push(edge);
				} else {
					edgesByNote.set(noteId, [edge]);
				}
			}
		}

		return {
			nodeById: new Map(graph.nodes.map((node) => [node.data.id, node])),
			edgesByNote,
		};
	}

	private computeTotals(graph: GraphData, scope: ResolvedScope): GraphTotals {
		const scopeIds = scope.folderIds
			? new Set(
					graph.nodes
						.filter((node) => this.isInScope(node, scope))
						.map((node) => node.data.id)
			  )
			: null;
		const edges = scopeIds
			? graph.edges.filter(
					({ data }) => scopeIds.has(data.source) || scopeIds.has(data.target)
			  )
			: graph.edges;
		return { notes: scopeIds ? scopeIds.size : graph.nodes.length, ...this.countEdges(edges) };
	}

	/** For a view that is about one note rather than a notebook, so its numbers match what is drawn. */
	private drawnTotals(nodes: NodeEntry[], edges: EdgeEntry[]): GraphTotals {
		return { notes: nodes.length, ...this.countEdges(edges) };
	}

	private countEdges(edges: EdgeEntry[]): Omit<GraphTotals, 'notes'> {
		let explicit = 0;
		let semantic = 0;
		const tagNames = new Set<string>();
		for (const { data } of edges) {
			if (data.type === 'link') explicit++;
			else if (data.type === 'semantic') semantic++;
			else if (data.type === 'tag' && data.tagName) {
				for (const name of data.tagName.split(', ')) tagNames.add(name);
			}
		}
		return { explicit, semantic, tags: tagNames.size };
	}
}
