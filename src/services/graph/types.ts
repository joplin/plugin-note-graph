/** The three edge kinds this graph represents. */
export type EdgeType = 'link' | 'tag' | 'semantic';

export interface GraphNode {
	id: string;
	label: string;
	noteId: string;
	degree: number;
}

export interface GraphEdge {
	source: string;
	target: string;
	type: EdgeType;
	/** Comma-separated tag names when type === 'tag'. */
	tagName?: string;
}

export interface GraphData {
	nodes: Array<{ data: GraphNode }>;
	edges: Array<{ data: GraphEdge }>;
}
