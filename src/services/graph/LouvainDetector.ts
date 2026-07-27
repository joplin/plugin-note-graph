import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { Note } from '../../data/Types';
import { GraphEdge } from './types';

/** Below this note count there isn't enough structure for Louvain to produce a meaningful result. */
const MIN_NOTES_FOR_LOUVAIN = 3;

/** At or above this ratio of communities to notes, Louvain has basically found nothing (near-all singletons). */
const DEGENERATE_COMMUNITY_RATIO = 0.8;

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
	/** Degenerate results are discarded entirely rather than partially kept, on purpose, to avoid mixing two different id schemes. */
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

	private isDegenerate(raw: Record<string, number>, noteCount: number): boolean {
		const communityCount = new Set(Object.values(raw)).size;
		return communityCount >= noteCount * DEGENERATE_COMMUNITY_RATIO;
	}

	/** Weights each edge by how many relationships connect the same pair of notes, so a note linked and tagged and semantically similar to another counts for more than a single coincidental edge. */
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

	/** Louvain's raw ids are arbitrary. Renumbering by size (largest first, ties broken by lowest member id) makes id 0 always the biggest cluster. */
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

	/** Latin-script words only; other scripts fall through to the per-note key above. */
	private tokenize(text: string): string[] {
		return text.toLowerCase().match(/[a-z]{2,}/g) ?? [];
	}
}
