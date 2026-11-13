/**
 * How the panel decides what to do with an update from the plugin. Kept apart from
 * Cytoscape so it can be tested: the panel passes in what it has drawn.
 */

export interface ElementData {
	id: string;
	[key: string]: unknown;
}

export interface ElementItem {
	data: ElementData;
	position?: { x: number; y: number };
}

export interface GraphUpdateMessage {
	version?: number;
	view?: { key: string };
	layoutRevision?: number | null;
	nodes?: ElementItem[];
	edges?: ElementItem[];
}

export interface ClientPatch {
	view?: { key: string };
	upsertedNodes: ElementItem[];
	upsertedEdges: ElementItem[];
	removedNodeIds: string[];
	removedEdgeIds: string[];
}

export interface PanelState {
	hasRenderedOnce: boolean;
	lastSeenVersion: number;
	renderInProgress: boolean;
	viewKey: string | null;
	layoutRevision: number | null | undefined;
}

/** What is on screen now. Community boxes are not notes, so they are left out of `nodeIds`. */
export interface DrawnGraph {
	nodeIds: string[];
	edgeIds: string[];
	dataOf: (id: string) => Record<string, unknown> | null;
}

export type UpdateAction = 'skip' | 'apply-patch' | 'redraw' | 'compare';

/** A patch or graph the panel already has, or one older than it. */
export function isOutdated(version: number, state: PanelState): boolean {
	return state.hasRenderedOnce && version <= state.lastSeenVersion;
}

/**
 * A patch only applies on top of the version just before it; one that skips a
 * version is dropped, and the next poll fetches the whole graph instead.
 */
export function decideUpdate(
	type: 'graph-data' | 'graph-patch',
	message: GraphUpdateMessage,
	state: PanelState
): UpdateAction {
	const version = message.version || 0;
	if (type === 'graph-patch') {
		return state.hasRenderedOnce && version === state.lastSeenVersion + 1 ? 'apply-patch' : 'skip';
	}
	return !state.hasRenderedOnce || needsFullRedraw(message, state) ? 'redraw' : 'compare';
}

/** A different view, or positions computed from scratch, can't be applied as a patch. */
export function needsFullRedraw(message: GraphUpdateMessage, state: PanelState): boolean {
	return (
		state.renderInProgress ||
		!state.viewKey ||
		!message.view ||
		message.view.key !== state.viewKey ||
		message.layoutRevision !== state.layoutRevision
	);
}

function definedKeys(data: Record<string, unknown>): string[] {
	return Object.keys(data).filter((key) => data[key] !== undefined && key !== 'parent');
}

/** Ignores `parent`, which the panel adds itself when grouping by community. */
export function dataEqual(existing: Record<string, unknown> | null, data: ElementData): boolean {
	if (!existing) return false;
	const keys = new Set([...definedKeys(existing), ...definedKeys(data)]);
	return Array.from(keys).every((key) => existing[key] === data[key]);
}

/** What changed between what is drawn and a full graph from the plugin. */
export function computeClientPatch(graph: GraphUpdateMessage, drawn: DrawnGraph): ClientPatch {
	const nodes = graph.nodes || [];
	const edges = graph.edges || [];
	const nodeIds = new Set(nodes.map((n) => n.data.id));
	const edgeIds = new Set(edges.map((e) => e.data.id));

	return {
		view: graph.view,
		upsertedNodes: nodes.filter((n) => !dataEqual(drawn.dataOf(n.data.id), n.data)),
		upsertedEdges: edges.filter((e) => !dataEqual(drawn.dataOf(e.data.id), e.data)),
		removedNodeIds: drawn.nodeIds.filter((id) => !nodeIds.has(id)),
		removedEdgeIds: drawn.edgeIds.filter((id) => !edgeIds.has(id)),
	};
}

const WHOLESALE_CHANGE_RATIO = 0.5;

/** Past this much change, redrawing is cheaper than patching, and looks no worse. */
export function isWholesaleChange(patch: ClientPatch, drawn: DrawnGraph): boolean {
	const drawnIds = new Set(drawn.nodeIds);
	const currentCount = drawnIds.size;
	const removedCount = patch.removedNodeIds.length;
	const newCount = patch.upsertedNodes.filter((item) => !drawnIds.has(item.data.id)).length;

	if (currentCount > 0 && removedCount >= currentCount * WHOLESALE_CHANGE_RATIO) return true;
	const resultingCount = currentCount - removedCount + newCount;
	return newCount >= resultingCount * WHOLESALE_CHANGE_RATIO;
}
