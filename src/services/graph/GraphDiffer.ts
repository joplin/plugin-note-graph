import { GraphData, GraphNode, RenderedEdge } from './types';

export interface GraphDiff {
	upsertedNodes: Array<{ data: GraphNode }>;
	upsertedEdges: Array<{ data: RenderedEdge }>;
	removedNodeIds: string[];
	removedEdgeIds: string[];
}

function definedKeys(record: Record<string, unknown>): string[] {
	return Object.keys(record).filter((key) => record[key] !== undefined);
}

function dataEqual<T extends object>(a: T | undefined, b: T): boolean {
	if (!a) return false;
	const aRecord = a as unknown as Record<string, unknown>;
	const bRecord = b as unknown as Record<string, unknown>;
	const keys = new Set([...definedKeys(aRecord), ...definedKeys(bRecord)]);
	return Array.from(keys).every((key) => aRecord[key] === bRecord[key]);
}

export class GraphDiffer {
	public computeDiff(previous: GraphData | null, current: GraphData): GraphDiff {
		if (!previous) {
			return {
				upsertedNodes: current.nodes,
				upsertedEdges: current.edges,
				removedNodeIds: [],
				removedEdgeIds: [],
			};
		}

		const previousNodesById = new Map(previous.nodes.map((n) => [n.data.id, n.data]));
		const previousEdgesById = new Map(previous.edges.map((e) => [e.data.id, e.data]));
		const currentNodeIds = new Set(current.nodes.map((n) => n.data.id));
		const currentEdgeIds = new Set(current.edges.map((e) => e.data.id));

		const upsertedNodes = current.nodes.filter(
			(n) => !dataEqual(previousNodesById.get(n.data.id), n.data)
		);
		const upsertedEdges = current.edges.filter(
			(e) => !dataEqual(previousEdgesById.get(e.data.id), e.data)
		);
		const removedNodeIds = Array.from(previousNodesById.keys()).filter(
			(id) => !currentNodeIds.has(id)
		);
		const removedEdgeIds = Array.from(previousEdgesById.keys()).filter(
			(id) => !currentEdgeIds.has(id)
		);

		return { upsertedNodes, upsertedEdges, removedNodeIds, removedEdgeIds };
	}
}
