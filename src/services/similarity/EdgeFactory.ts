import { Note } from '../../data/Types';
import { GraphEdge } from '../graph/types';

export class EdgeFactory {
	public createEdges(notes: Note[]): GraphEdge[] {
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

		const tagToNotes = new Map<string, string[]>();
		for (const note of notes) {
			for (const tag of note.tags ?? []) {
				if (!tagToNotes.has(tag)) {
					tagToNotes.set(tag, []);
				}
				tagToNotes.get(tag)!.push(note.id);
			}
		}

		const tagEdgeMap = new Map<string, GraphEdge>();
		for (const [tagName, noteIds] of tagToNotes) {
			if (noteIds.length > 20) continue;

			for (let i = 0; i < noteIds.length; i++) {
				for (let j = i + 1; j < noteIds.length; j++) {
					const a = noteIds[i];
					const b = noteIds[j];
					const pairKey = a < b ? `${a}::${b}` : `${b}::${a}`;

					const existing = tagEdgeMap.get(pairKey);
					if (existing) {
						existing.tagName = existing.tagName + ', ' + tagName;
					} else {
						tagEdgeMap.set(pairKey, {
							source: a,
							target: b,
							type: 'tag',
							tagName: tagName,
						});
					}
				}
			}
		}

		for (const edge of tagEdgeMap.values()) {
			edges.push(edge);
		}

		return edges;
	}
}
