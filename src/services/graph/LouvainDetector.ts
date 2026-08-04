import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { Note } from '../../data/Types';
import { GraphEdge } from './types';

/** Below this note count there isn't enough structure for Louvain to produce a meaningful result. */
const MIN_NOTES_FOR_LOUVAIN = 3;

/** At or above this ratio of communities to notes, Louvain has basically found nothing (near-all singletons). */
const DEGENERATE_COMMUNITY_RATIO = 0.8;

/** If a single keyword/link-fallback community would hold at least this share of all notes, treat the fallback as a collapse - "everyone lumped into one bucket" is no more meaningful than "everyone in their own bucket". */
const MAX_FALLBACK_DOMINANT_SHARE = 0.8;

/** Seeded PRNG so the same graph always produces the same Louvain result, instead of the library's default `Math.random` reshuffling colors on every rebuild. */
const createDeterministicRng = (): (() => number) => {
	let state = 0x9e3779b9;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** Sorts by note/edge identity so a graph's structure depends only on which notes and edges it contains, never on the order the caller happened to hand them in. */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const STOPWORDS = new Set([
	'this',
	'that',
	'these',
	'those',
	'with',
	'from',
	'have',
	'were',
	'been',
	'being',
	'about',
	'into',
	'over',
	'under',
	'again',
	'there',
	'their',
	'they',
	'them',
	'then',
	'than',
	'when',
	'what',
	'which',
	'while',
	'where',
	'your',
	'yours',
	'will',
	'would',
	'could',
	'should',
	'note',
	'notes',
	'today',
	'just',
	'also',
	'here',
	'some',
	'each',
	'more',
	'most',
	'other',
	'such',
	'only',
	'same',
]);

/** Tracks which notes have been merged into the same community, used to combine keyword grouping with edge connectivity. */
class DisjointSet {
	private readonly parent = new Map<string, string>();

	public add(id: string): void {
		if (!this.parent.has(id)) {
			this.parent.set(id, id);
		}
	}

	public has(id: string): boolean {
		return this.parent.has(id);
	}

	public union(a: string, b: string): void {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA !== rootB) {
			this.parent.set(rootA, rootB);
		}
	}

	public find(id: string): string {
		let root = id;
		while (this.parent.get(root) !== root) {
			root = this.parent.get(root) as string;
		}
		let current = id;
		while (current !== root) {
			const next = this.parent.get(current) as string;
			this.parent.set(current, root);
			current = next;
		}
		return root;
	}
}

/**
 * Assigns each note to a community. Runs Louvain clustering on the note
 * graph when it's dense enough to give a meaningful result, and falls back
 * to grouping notes by shared keyword and direct connections otherwise.
 *
 * Community ids are deterministic and size-ordered (id 0 is always the
 * largest community) for a *fixed* note/edge set, so re-running on an
 * unchanged graph never reshuffles colors. That guarantee does not extend
 * across rebuilds where the corpus itself changes: adding or removing notes
 * can change relative community sizes and therefore reassign ids. Anchoring
 * ids to a previous rebuild (so unrelated communities don't change color
 * when the vault grows) is left for the incremental-update work.
 */
export class LouvainDetector {
	public detectCommunities(notes: Note[], edges: GraphEdge[]): Map<string, number> {
		if (this.isTooSparse(notes, edges)) {
			console.info(
				`Community detection: graph too sparse for Louvain (${notes.length} notes, ${edges.length} edges), using keyword/link fallback.`
			);
			return this.renumberBySize(this.groupByKeyword(notes, edges));
		}

		let raw: Record<string, number>;
		try {
			raw = this.runLouvain(notes, edges);
		} catch (error) {
			console.error('Louvain community detection failed, using keyword/link fallback instead:', error);
			return this.renumberBySize(this.groupByKeyword(notes, edges));
		}

		if (this.isDegenerate(raw, notes.length)) {
			return this.chooseLessFragmented(raw, notes, edges);
		}
		return this.renumberBySize(new Map(Object.entries(raw)));
	}

	/** Too few notes, or no connections at all, means Louvain would only produce singleton communities. */
	private isTooSparse(notes: Note[], edges: GraphEdge[]): boolean {
		return notes.length < MIN_NOTES_FOR_LOUVAIN || edges.length === 0;
	}

	private isDegenerate(raw: Record<string, number>, noteCount: number): boolean {
		const communityCount = new Set(Object.values(raw)).size;
		return communityCount >= noteCount * DEGENERATE_COMMUNITY_RATIO;
	}

	private chooseLessFragmented(
		raw: Record<string, number>,
		notes: Note[],
		edges: GraphEdge[]
	): Map<string, number> {
		const louvainResult = new Map(Object.entries(raw));
		const fallbackResult = this.groupByKeyword(notes, edges);

		const louvainCommunityCount = new Set(louvainResult.values()).size;
		const fallbackCommunityCount = new Set(fallbackResult.values()).size;
		const fallbackIsBetter =
			fallbackCommunityCount < louvainCommunityCount && !this.isCollapsed(fallbackResult, notes.length);

		if (fallbackIsBetter) {
			console.info(
				`Community detection: Louvain result too fragmented (${louvainCommunityCount} communities ` +
					`for ${notes.length} notes), using keyword/link fallback (${fallbackCommunityCount} communities).`
			);
			return this.renumberBySize(fallbackResult);
		}
		return this.renumberBySize(louvainResult);
	}

	/** True when one community absorbed most of the notes - as meaningless a partition as near-all singletons. */
	private isCollapsed(assignments: Map<string, number>, noteCount: number): boolean {
		const sizeByGroup = new Map<number, number>();
		for (const groupId of assignments.values()) {
			sizeByGroup.set(groupId, (sizeByGroup.get(groupId) ?? 0) + 1);
		}
		let largestGroupSize = 0;
		for (const size of sizeByGroup.values()) {
			if (size > largestGroupSize) largestGroupSize = size;
		}
		return largestGroupSize >= noteCount * MAX_FALLBACK_DOMINANT_SHARE;
	}

	/** Weights each edge by how many relationships connect the same pair of notes, so a note linked and tagged and semantically similar to another counts for more than a single coincidental edge. */
	private runLouvain(notes: Note[], edges: GraphEdge[]): Record<string, number> {
		const graph = new Graph({ type: 'undirected' });

		const sortedNotes = [...notes].sort((a, b) => compareStrings(a.id, b.id));
		for (const note of sortedNotes) {
			graph.addNode(note.id);
		}

		const sortedEdges = [...edges].sort(
			(a, b) => compareStrings(a.source, b.source) || compareStrings(a.target, b.target)
		);
		for (const edge of sortedEdges) {
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
				continue;
			}
			if (graph.hasEdge(edge.source, edge.target)) {
				graph.updateEdgeAttribute(edge.source, edge.target, 'weight', (w) => w + 1);
			} else {
				graph.mergeEdge(edge.source, edge.target, { weight: 1 });
			}
		}

		return louvain(graph, { rng: createDeterministicRng() });
	}

	/** Raw ids (from either Louvain or the keyword fallback) are arbitrary. Renumbering by size (largest first, ties broken by lowest member id) makes id 0 always the biggest cluster. */
	private renumberBySize(raw: Map<string, number>): Map<string, number> {
		const membersByRawId = new Map<number, string[]>();
		for (const [noteId, rawId] of raw) {
			const members = membersByRawId.get(rawId);
			if (members) {
				members.push(noteId);
			} else {
				membersByRawId.set(rawId, [noteId]);
			}
		}

		const groups = Array.from(membersByRawId.values()).map((members) => ({
			members,
			minId: members.reduce((min, id) => (id < min ? id : min)),
		}));
		groups.sort((a, b) => b.members.length - a.members.length || compareStrings(a.minId, b.minId));

		const renumbered = new Map<string, number>();
		groups.forEach(({ members }, newId) => {
			for (const noteId of members) {
				renumbered.set(noteId, newId);
			}
		});
		return renumbered;
	}

	private groupByKeyword(notes: Note[], edges: GraphEdge[]): Map<string, number> {
		const groups = new DisjointSet();
		for (const note of notes) {
			groups.add(note.id);
		}

		const representativeByKeyword = new Map<string, string>();
		for (const note of notes) {
			const keyword = this.extractKeyword(note);
			const representative = representativeByKeyword.get(keyword);
			if (representative) {
				groups.union(note.id, representative);
			} else {
				representativeByKeyword.set(keyword, note.id);
			}
		}

		for (const edge of edges) {
			if (groups.has(edge.source) && groups.has(edge.target)) {
				groups.union(edge.source, edge.target);
			}
		}

		const assignments = new Map<string, number>();
		const idByRoot = new Map<string, number>();
		for (const note of notes) {
			const root = groups.find(note.id);
			let id = idByRoot.get(root);
			if (id === undefined) {
				id = idByRoot.size;
				idByRoot.set(root, id);
			}
			assignments.set(note.id, id);
		}
		return assignments;
	}

	/** Falls back to a note-unique key when nothing qualifies, so unrelated notes never collide. */
	private extractKeyword(note: Note): string {
		const counts = new Map<string, number>();
		for (const word of this.tokenize(`${note.title} ${note.title} ${note.body ?? ''}`)) {
			if (STOPWORDS.has(word) || word.length <= 3) continue;
			counts.set(word, (counts.get(word) ?? 0) + 1);
		}

		let bestWord: string | null = null;
		let bestCount = 0;
		for (const [word, count] of counts) {
			if (count > bestCount) {
				bestWord = word;
				bestCount = count;
			}
		}

		return bestWord ?? `note:${note.id}`;
	}

	/**
	 * Latin-script words only; other scripts fall through to the per-note key above.
	 * TODO: extend the regex (or use a script-aware tokenizer) to support non-Latin
	 * scripts as a post-GSoC enhancement.
	 */
	private tokenize(text: string): string[] {
		return text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
	}
}
