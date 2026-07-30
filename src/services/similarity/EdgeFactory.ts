import { Note } from '../../data/Types';
import { GraphEdge } from '../graph/types';
import { SimilarityPair } from './SimilarityEngine';

export class EdgeFactory {
	/**
	 * Creates graph edges from explicit note links and shared tags.
	 * @param notes - notes with `links` and `tags` already populated.
	 * @returns deduplicated edges of type `link` and `tag`.
	 */
	public createEdges(notes: Note[]): GraphEdge[] {
		return [...this.createLinkEdges(notes), ...this.createTagEdges(notes)];
	}

	/** Builds one deduplicated edge per explicit `:/noteId` link between two notes in scope. */
	private createLinkEdges(notes: Note[]): GraphEdge[] {
		const noteIdSet = new Set(notes.map((n) => n.id));
		const edges: GraphEdge[] = [];
		const linkKeySet = new Set<string>();

		for (const note of notes) {
			for (const link of note.links ?? []) {
				if (noteIdSet.has(link) && link !== note.id) {
					const key = `${note.id}::${link}::link`;
					if (!linkKeySet.has(key)) {
						linkKeySet.add(key);
						edges.push({ source: note.id, target: link, type: 'link' });
					}
				}
			}
		}

		return edges;
	}

	/**
	 * Builds one edge per pair of notes sharing a tag, merging multiple shared
	 * tag names onto the same edge. Tags shared by more than 20 notes are
	 * skipped to avoid a combinatorial blowup of pairs.
	 */
	private createTagEdges(notes: Note[]): GraphEdge[] {
		const tagToNotes = this.groupNoteIdsByTag(notes);
		const tagEdgeMap = new Map<string, { source: string; target: string; tagNames: string[] }>();

		for (const [tagName, noteIds] of tagToNotes) {
			if (noteIds.length > 20) continue;

			for (let i = 0; i < noteIds.length; i++) {
				for (let j = i + 1; j < noteIds.length; j++) {
					const a = noteIds[i];
					const b = noteIds[j];
					const [source, target] = a < b ? [a, b] : [b, a];
					const pairKey = `${source}::${target}`;

					const existing = tagEdgeMap.get(pairKey);
					if (existing) {
						existing.tagNames.push(tagName);
					} else {
						tagEdgeMap.set(pairKey, { source, target, tagNames: [tagName] });
					}
				}
			}
		}

		return Array.from(tagEdgeMap.values()).map((edge) => ({
			source: edge.source,
			target: edge.target,
			type: 'tag',
			tagName: edge.tagNames.slice().sort().join(', '),
		}));
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
			});
		}

		return edges;
	}
}
