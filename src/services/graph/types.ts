export type EdgeType = 'link' | 'tag';

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
	tagName?: string;
}

export interface GraphData {
	nodes: Array<{ data: GraphNode }>;
	edges: Array<{ data: GraphEdge }>;
}
