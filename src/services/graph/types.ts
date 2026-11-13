export type EdgeType = 'link' | 'tag' | 'semantic';

/** Joins a note's tag names into one string, because nodes are compared field by field and an array would always look changed. */
export const TAG_NAME_SEPARATOR = '\n';

export interface GraphNode {
	id: string;
	label: string;
	noteId: string;
	degree: number;
	community: number;
	size: number;
	category?: string;
	notebookId?: string;
	/** The note's tags, joined with TAG_NAME_SEPARATOR. */
	tagNames?: string;
	/** Set on a note drawn only because it connects to the notebook being shown. */
	outsideScope?: boolean;
}

export interface GraphEdge {
	source: string;
	target: string;
	type: EdgeType;
	/** Comma-separated tag names when type === 'tag'. */
	tagName?: string;
	relationshipLabel?: string;
	score?: number;
	/** A tag too widely used to connect all its notes, so this edge only links neighbours in an ID-sorted ring. It carries no meaning about this particular pair. */
	ring?: boolean;
}

export interface RenderedEdge extends GraphEdge {
	id: string;
}

export interface GraphData {
	nodes: Array<{ data: GraphNode }>;
	edges: Array<{ data: RenderedEdge }>;
	allNotesVeryShort?: boolean;
}
