import { Note } from '../../data/Types';
import { GraphEdge } from '../graph/types';
import { SimilarityPair } from './SimilarityEngine';

export const TAG_CLIQUE_MAX_NOTES = 20;
export const TAG_CAPPED_NEIGHBORS_PER_NOTE = 4;

export class EdgeFactory {
	/**
	 * Creates graph edges from explicit note links and shared tags.
	 * @param notes - notes with `links` and `tags` already populated.
	 * @returns deduplicated edges of type `link` and `tag`.
	 */
	public createEdges(notes: Note[]): GraphEdge[] {
		return [...this.createLinkEdges(notes), ...this.createTagEdges(notes)];
	}

	/**
	 * Builds one deduplicated edge per explicit `:/noteId` link between two notes
	 * in scope. Direction-agnostic, same as `createTagEdges`: a mutual A<->B link
	 * is one edge, not two, and its `source`/`target` are normalized to id order
	 * rather than kept in authored order.
	 */
	private createLinkEdges(notes: Note[]): GraphEdge[] {
		const noteIdSet = new Set(notes.map((n) => n.id));
		const linkEdgeMap = new Map<string, GraphEdge>();

		for (const note of notes) {
			for (const link of note.links ?? []) {
				if (noteIdSet.has(link) && link !== note.id) {
					const [a, b] = note.id < link ? [note.id, link] : [link, note.id];
					const pairKey = `${a}::${b}`;
					if (!linkEdgeMap.has(pairKey)) {
						linkEdgeMap.set(pairKey, { source: a, target: b, type: 'link' });
					}
				}
			}
		}

		return Array.from(linkEdgeMap.values());
	}

	private createTagEdges(notes: Note[]): GraphEdge[] {
		const tagToNotes = this.groupNoteIdsByTag(notes);
		const tagEdgeMap = new Map<
			string,
			{ source: string; target: string; tagNames: string[] }
		>();

		for (const [tagName, noteIds] of tagToNotes) {
			if (noteIds.length <= TAG_CLIQUE_MAX_NOTES) {
				this.connectClique(tagEdgeMap, noteIds, tagName);
			} else {
				this.connectCapped(tagEdgeMap, noteIds, tagName);
			}
		}

		return Array.from(tagEdgeMap.values()).map((edge) => ({
			source: edge.source,
			target: edge.target,
			type: 'tag',
			tagName: edge.tagNames.slice().sort().join(', '),
		}));
	}

	private connectClique(
		tagEdgeMap: Map<string, { source: string; target: string; tagNames: string[] }>,
		noteIds: string[],
		tagName: string
	): void {
		for (let i = 0; i < noteIds.length; i++) {
			for (let j = i + 1; j < noteIds.length; j++) {
				this.addTagPair(tagEdgeMap, noteIds[i], noteIds[j], tagName);
			}
		}
	}

	private connectCapped(
		tagEdgeMap: Map<string, { source: string; target: string; tagNames: string[] }>,
		noteIds: string[],
		tagName: string
	): void {
		const sorted = [...noteIds].sort();
		const m = sorted.length;
		const k = Math.min(TAG_CAPPED_NEIGHBORS_PER_NOTE, m - 1);

		for (let i = 0; i < m; i++) {
			for (let j = 1; j <= k; j++) {
				this.addTagPair(tagEdgeMap, sorted[i], sorted[(i + j) % m], tagName);
			}
		}
	}

	private addTagPair(
		tagEdgeMap: Map<string, { source: string; target: string; tagNames: string[] }>,
		a: string,
		b: string,
		tagName: string
	): void {
		const [source, target] = a < b ? [a, b] : [b, a];
		const pairKey = `${source}::${target}`;

		const existing = tagEdgeMap.get(pairKey);
		if (existing) {
			existing.tagNames.push(tagName);
		} else {
			tagEdgeMap.set(pairKey, { source, target, tagNames: [tagName] });
		}
	}

	private groupNoteIdsByTag(notes: Note[]): Map<string, string[]> {
		const tagToNotes = new Map<string, string[]>();
		for (const note of notes) {
			for (const tag of note.tags ?? []) {
				if (!tagToNotes.has(tag)) {
					tagToNotes.set(tag, []);
				}
				tagToNotes.get(tag)!.push(note.id);
			}
		}
		return tagToNotes;
	}

	/**
	 * Creates semantic edges from similarity pairs.
	 * Each pair represents a strong semantic connection between two notes.
	 */
	public createSemanticEdges(pairs: SimilarityPair[]): GraphEdge[] {
		const edges: GraphEdge[] = [];

		for (const pair of pairs) {
			if (pair.score <= 0) continue;

			edges.push({
				source: pair.source,
				target: pair.target,
				type: 'semantic',
				score: pair.score,
			});
		}

		return edges;
	}
}
