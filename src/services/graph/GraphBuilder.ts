import { Note } from '../../data/Types';
import { EdgeFactory } from '../similarity/EdgeFactory';
import { GraphData, GraphNode } from './types';

export class GraphBuilder {
	private readonly edgeFactory: EdgeFactory;

	public constructor(edgeFactory = new EdgeFactory()) {
		this.edgeFactory = edgeFactory;
	}

	public build(notes: Note[]): GraphData {
		const degreeMap = new Map<string, number>();
		for (const note of notes) {
			degreeMap.set(note.id, 0);
		}

		const edges = this.edgeFactory.createEdges(notes);

		for (const edge of edges) {
			degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
			degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
		}

		const maxDegree = Math.max(1, ...degreeMap.values());

		const nodes: Array<{ data: GraphNode }> = [];
		for (const note of notes) {
			const degree = degreeMap.get(note.id) ?? 0;
			const label = note.title || '(untitled)';
			nodes.push({
				data: {
					id: note.id,
					label: label.length > 64 ? label.substring(0, 61) + '...' : label,
					noteId: note.id,
					degree,
				},
			});
		}

		const nodeIdSet = new Set(nodes.map((n) => n.data.id));
		const visibleEdges = edges.filter(
			(e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target)
		);

		const connectedIds = new Set<string>();
		for (const edge of visibleEdges) {
			connectedIds.add(edge.source);
			connectedIds.add(edge.target);
		}
		const isolatedCount = nodes.length - connectedIds.size;

		console.info(
			`Graph built: ${nodes.length} nodes, ${visibleEdges.length} edges ` +
				`(${isolatedCount} isolated, max degree ${maxDegree})`
		);

		return { nodes, edges: visibleEdges.map((e) => ({ data: e })) };
	}
}
