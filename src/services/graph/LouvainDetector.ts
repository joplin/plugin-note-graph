import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { Note } from '../../data/Types';
import { GraphEdge } from './types';

/** Below this note count there isn't enough structure for Louvain to produce a meaningful result. */
const MIN_NOTES_FOR_LOUVAIN = 3;

/** If Louvain ends up with this many communities per note or more, it hasn't found real structure (for example one stray edge in an otherwise disconnected graph). Grouping by keyword works better than near-all-singleton clusters in that case. */
const DEGENERATE_COMMUNITY_RATIO = 0.8;

/**
 * Seeded PRNG (mulberry32) so the same graph always produces the same
 * Louvain result. The library's default `rng` is `Math.random`, which would
 * otherwise reshuffle community ids, and node colors, on every rebuild of
 * the same graph.
 */
const createDeterministicRng = (): (() => number) => {
	let state = 0x9e3779b9;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

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

/**
 * Assigns each note to a community. Runs Louvain clustering on the note
 * graph when it's dense enough to give a meaningful result, and falls back
 * to grouping notes by their most frequent keyword otherwise.
 */
export class LouvainDetector {
	/**
	 * When `isDegenerate` is true, the whole Louvain result gets thrown away
	 * for keyword grouping, even notes that were genuinely well connected. We
	 * could keep Louvain's real clusters and only keyword-group the
	 * singletons, but that adds real complexity: merging two id schemes and
	 * deciding how they're colored relative to each other. This case is
	 * already the sparse, low-signal tail end of the data, so it's kept
	 * all-or-nothing for now.
	 */
	public detectCommunities(notes: Note[], edges: GraphEdge[]): Map<string, number> {
		if (this.isTooSparse(notes, edges)) {
			return this.groupByKeyword(notes);
		}

		const raw = this.runLouvain(notes, edges);
		if (this.isDegenerate(raw, notes.length)) {
			return this.groupByKeyword(notes);
		}
		return this.renumberBySize(raw);
	}

	/** Too few notes, or no connections at all, means Louvain would only produce singleton communities. */
	private isTooSparse(notes: Note[], edges: GraphEdge[]): boolean {
		return notes.length < MIN_NOTES_FOR_LOUVAIN || edges.length === 0;
	}

	/** Catches something a raw edge count can't: a few edges scattered across an otherwise disconnected graph, like a strict similarity threshold. Louvain resolves that to almost all singletons. */
	private isDegenerate(raw: Record<string, number>, noteCount: number): boolean {
		const communityCount = new Set(Object.values(raw)).size;
		return communityCount >= noteCount * DEGENERATE_COMMUNITY_RATIO;
	}

	/**
	 * Builds the graphology graph, weighting each edge by how many different
	 * relationships connect the same pair of notes. Two notes that are both
	 * linked and semantically similar are a stronger pair than two notes that
	 * just happen to share a tag. Louvain reads this through its 'weight'
	 * edge attribute by default, so adding up the weight here, instead of
	 * collapsing every relationship into one unweighted edge, lets strongly
	 * related notes end up in the same community more easily.
	 */
	private runLouvain(notes: Note[], edges: GraphEdge[]): Record<string, number> {
		const graph = new Graph({ type: 'undirected' });
		for (const note of notes) {
			graph.addNode(note.id);
		}
		for (const edge of edges) {
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
				continue;
			}
			if (graph.hasEdge(edge.source, edge.target)) {
				graph.updateEdgeAttribute(edge.source, edge.target, 'weight', (w) => (w ?? 1) + 1);
			} else {
				graph.mergeEdge(edge.source, edge.target, { weight: 1 });
			}
		}

		return louvain(graph, { rng: createDeterministicRng() });
	}

	/**
	 * Louvain's raw community ids are arbitrary. Renumbering by community
	 * size, largest first, and breaking ties by the lowest member note id,
	 * gives stable and meaningful ids. Id 0 is always the largest cluster, so
	 * the UI can save its most distinct colors for the communities that
	 * matter most.
	 */
	private renumberBySize(raw: Record<string, number>): Map<string, number> {
		const membersByRawId = new Map<number, string[]>();
		for (const [noteId, rawId] of Object.entries(raw)) {
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
		groups.sort((a, b) => b.members.length - a.members.length || (a.minId < b.minId ? -1 : 1));

		const renumbered = new Map<string, number>();
		groups.forEach(({ members }, newId) => {
			for (const noteId of members) {
				renumbered.set(noteId, newId);
			}
		});
		return renumbered;
	}

	/** Groups notes sharing the same dominant keyword into the same community. */
	private groupByKeyword(notes: Note[]): Map<string, number> {
		const communityByKeyword = new Map<string, number>();
		const assignments = new Map<string, number>();

		for (const note of notes) {
			const keyword = this.extractKeyword(note);
			let community = communityByKeyword.get(keyword);
			if (community === undefined) {
				community = communityByKeyword.size;
				communityByKeyword.set(keyword, community);
			}
			assignments.set(note.id, community);
		}

		return assignments;
	}

	/** Picks the note's own most frequent significant word, weighting the title over the body. Falls back to a note-unique key when nothing qualifies, so unrelated notes never collide. */
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

	/** Only matches Latin-script words. Notes in other scripts always miss and fall through to `extractKeyword`'s per-note key. This is a known limit of this fallback-of-a-fallback path. */
	private tokenize(text: string): string[] {
		return text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
	}
}
