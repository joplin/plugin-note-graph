import { Note } from '../../data/Types';
import { GraphEdge, EdgeType } from '../graph/types';

export class EdgeFactory {
	public createEdges(notes: Note[]): GraphEdge[] {
		const noteIdSet = new Set(notes.map((n) => n.id));
		const edgeSet = new Set<string>();
		const edges: GraphEdge[] = [];

		const addEdge = (source: string, target: string, type: EdgeType) => {
			const key =
				source < target
					? `${source}::${target}::${type}`
					: `${target}::${source}::${type}`;
			if (!edgeSet.has(key)) {
				edgeSet.add(key);
				edges.push({ source, target, type });
			}
		};

		for (const note of notes) {
			for (const link of note.links ?? []) {
				if (noteIdSet.has(link) && link !== note.id) {
					addEdge(note.id, link, 'link');
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

		for (const [, noteIds] of tagToNotes) {
			for (let i = 0; i < noteIds.length; i++) {
				for (let j = i + 1; j < noteIds.length; j++) {
					addEdge(noteIds[i], noteIds[j], 'tag');
				}
			}
		}

		return edges;
	}
}
