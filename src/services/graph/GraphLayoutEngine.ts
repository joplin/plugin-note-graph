import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { NodePositions } from '../../data/Database/GraphCacheRepository';
import { GraphData, GraphNode } from './types';
import { Logger, consoleLogger } from '../../utils/Logger';

cytoscape.use(fcose);

export type LayoutName = 'fcose' | 'hierarchical';

export interface LayoutRequest {
	data: GraphData;
	layout: LayoutName;
	/** Keeps each community's notes together, for when the panel draws boxes around them. */
	grouped: boolean;
}

/** Above this, force layout takes long enough that placing notes community by community is the better trade. */
const FORCE_LAYOUT_NODE_LIMIT = 600;
/** The meta-graph of communities stays small enough for force layout, however large the vault is. */
const MAX_LAYOUT_COMMUNITIES = 300;
const MAX_META_EDGES_PER_COMMUNITY = 4;

const SPIRAL_SPACING = 34;
const COMMUNITY_MARGIN = 60;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const NEW_NODE_DISTANCE = 40;
const MIN_REUSABLE_SHARE = 0.5;

const NEW_NODE_MARGIN = 12;
const MAX_PLACEMENT_STEPS = 500;
const SEPARATION_PASSES = 200;
const GRID_SPACING = 160;

const FCOSE_OPTIONS = {
	name: 'fcose',
	quality: 'default',
	randomize: true,
	animate: false,
	fit: false,
	nodeDimensionsIncludeLabels: false,
	uniformNodeDimensions: false,
	packComponents: false,
	nodeSeparation: 200,
	nodeRepulsion: () => 20000,
	gravity: 0.05,
	gravityRange: 5.0,
	idealEdgeLength: 180,
	edgeElasticity: 0.2,
	numIter: 3000,
	tile: true,
	tilingPaddingVertical: 40,
	tilingPaddingHorizontal: 40,
};

const HIERARCHICAL_OPTIONS = {
	name: 'breadthfirst',
	directed: false,
	fit: false,
	spacingFactor: 1.6,
	avoidOverlap: true,
	animate: false,
};

/** Mirrors the sizes the panel draws, so nodes are spaced for what is really on screen. */
function nodeDiameter(node: GraphNode): number {
	const size = node.size || 1;
	return 18 + (size - 1) * 3;
}

function spiralRadius(memberCount: number): number {
	return SPIRAL_SPACING * Math.sqrt(memberCount) + COMMUNITY_MARGIN;
}

interface LayoutElement {
	data: Record<string, unknown>;
}

/**
 * Computes node positions in the plugin's own hidden window. The panel shares
 * Joplin's UI thread, so it never runs a layout itself and only draws the result.
 */
export class GraphLayoutEngine {
	public constructor(private readonly logger: Logger = consoleLogger) {}

	/** Never fails: a graph in a plain grid is better than no graph at all. */
	public async compute(request: LayoutRequest): Promise<NodePositions> {
		try {
			return await this.computeLayout(request);
		} catch (e) {
			this.logger.error('Layout failed; placing the notes in a grid instead:', e);
			return this.gridPositions(request.data);
		}
	}

	private gridPositions(data: GraphData): NodePositions {
		const columns = Math.ceil(Math.sqrt(data.nodes.length));
		const positions: NodePositions = {};
		data.nodes.forEach((node, index) => {
			positions[node.data.id] = {
				x: (index % columns) * GRID_SPACING,
				y: Math.floor(index / columns) * GRID_SPACING,
			};
		});
		return positions;
	}

	private async computeLayout(request: LayoutRequest): Promise<NodePositions> {
		const { data, layout, grouped } = request;
		if (data.nodes.length === 0) return {};

		if (layout === 'hierarchical') {
			return this.runLayout(this.toElements(data), HIERARCHICAL_OPTIONS);
		}
		if (grouped || data.nodes.length > FORCE_LAYOUT_NODE_LIMIT) {
			return this.communityLayout(data);
		}
		return this.runLayout(this.toElements(data), FCOSE_OPTIONS);
	}

	/** Force layout only tends to keep nodes apart, so this pushes any that still overlap until none do. */
	private separateOverlaps(
		positions: NodePositions,
		radiusById: Map<string, number>
	): NodePositions {
		const ids = Object.keys(positions);
		const moved: NodePositions = {};
		for (const id of ids) moved[id] = { ...positions[id] };

		for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
			let anyOverlap = false;
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					if (this.pushApart(moved, ids[i], ids[j], i, radiusById)) anyOverlap = true;
				}
			}
			if (!anyOverlap) break;
		}
		return moved;
	}

	private pushApart(
		positions: NodePositions,
		a: string,
		b: string,
		tieBreak: number,
		radiusById: Map<string, number>
	): boolean {
		const pointA = positions[a];
		const pointB = positions[b];
		const needed = (radiusById.get(a) ?? 0) + (radiusById.get(b) ?? 0);
		const dx = pointB.x - pointA.x;
		const dy = pointB.y - pointA.y;
		const distance = Math.hypot(dx, dy);
		if (distance >= needed) return false;

		// Identical positions have no direction to push along, so pick a different one for each node.
		const angle = distance === 0 ? tieBreak * GOLDEN_ANGLE : Math.atan2(dy, dx);
		const push = (needed - distance) / 2;
		pointA.x -= Math.cos(angle) * push;
		pointA.y -= Math.sin(angle) * push;
		pointB.x += Math.cos(angle) * push;
		pointB.y += Math.sin(angle) * push;
		return true;
	}

	/**
	 * Reuses `previous` so unchanged notes stay exactly where they are, placing
	 * only new notes next to what they connect to. Returns null when too little
	 * of the graph has a position to be worth keeping.
	 */
	public placeNewNodes(data: GraphData, previous: NodePositions): NodePositions | null {
		const known = data.nodes.filter((node) => previous[node.data.id]);
		if (data.nodes.length === 0 || known.length < data.nodes.length * MIN_REUSABLE_SHARE) {
			return null;
		}

		const positions: NodePositions = {};
		for (const node of known) positions[node.data.id] = previous[node.data.id];

		const radiusById = new Map(
			data.nodes.map((node) => [node.data.id, nodeDiameter(node.data) / 2 + NEW_NODE_MARGIN])
		);
		const neighbors = this.neighborsById(data);
		for (const node of data.nodes) {
			if (positions[node.data.id]) continue;
			positions[node.data.id] = this.findFreeSpotNear(
				node.data.id,
				neighbors,
				positions,
				radiusById
			);
		}

		return positions;
	}

	/** Spirals out from the note's neighbours until nothing already placed is in the way. */
	private findFreeSpotNear(
		id: string,
		neighbors: Map<string, string[]>,
		positions: NodePositions,
		radiusById: Map<string, number>
	): { x: number; y: number } {
		const placedNeighbors = (neighbors.get(id) ?? [])
			.map((other) => positions[other])
			.filter(Boolean);
		const anchor = this.centroid(
			placedNeighbors.length > 0 ? placedNeighbors : Object.values(positions)
		);
		const radius = radiusById.get(id) ?? 0;

		const blockers = Object.entries(positions).map(([otherId, point]) => ({
			point,
			clearance: radius + (radiusById.get(otherId) ?? 0),
		}));
		const isFree = (x: number, y: number): boolean =>
			blockers.every(
				({ point, clearance }) => Math.hypot(point.x - x, point.y - y) >= clearance
			);

		for (let step = 1; step <= MAX_PLACEMENT_STEPS; step++) {
			const distance = NEW_NODE_DISTANCE * Math.sqrt(step);
			const angle = step * GOLDEN_ANGLE;
			const x = anchor.x + distance * Math.cos(angle);
			const y = anchor.y + distance * Math.sin(angle);
			if (isFree(x, y)) return { x, y };
		}
		// A view this crowded has no free spot nearby, so keep clear of it instead.
		const farthest = NEW_NODE_DISTANCE * Math.sqrt(MAX_PLACEMENT_STEPS + 1);
		return { x: anchor.x + farthest, y: anchor.y };
	}

	private centroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
		const sum = points.reduce((total, p) => ({ x: total.x + p.x, y: total.y + p.y }), {
			x: 0,
			y: 0,
		});
		return { x: sum.x / points.length, y: sum.y / points.length };
	}

	private neighborsById(data: GraphData): Map<string, string[]> {
		const neighbors = new Map<string, string[]>();
		const add = (from: string, to: string): void => {
			const list = neighbors.get(from);
			if (list) list.push(to);
			else neighbors.set(from, [to]);
		};
		for (const { data: edge } of data.edges) {
			add(edge.source, edge.target);
			add(edge.target, edge.source);
		}
		return neighbors;
	}

	/** Lays out the communities as one small graph, then spirals each community's notes around its centre. */
	private async communityLayout(data: GraphData): Promise<NodePositions> {
		const groups = this.groupByCommunity(data);
		const centers = await this.layoutCommunities(data, groups);

		const positions: NodePositions = {};
		for (const [groupId, members] of groups) {
			const center = centers[groupId];
			members.forEach((member, rank) => {
				const radius = SPIRAL_SPACING * Math.sqrt(rank);
				const angle = rank * GOLDEN_ANGLE;
				positions[member.id] = {
					x: center.x + radius * Math.cos(angle),
					y: center.y + radius * Math.sin(angle),
				};
			});
		}
		return positions;
	}

	/** Largest communities first, each with its most connected notes first, so hubs end up in the centre. */
	private groupByCommunity(data: GraphData): Map<string, GraphNode[]> {
		const byCommunity = new Map<number, GraphNode[]>();
		for (const { data: node } of data.nodes) {
			const members = byCommunity.get(node.community);
			if (members) members.push(node);
			else byCommunity.set(node.community, [node]);
		}

		const ordered = Array.from(byCommunity.entries()).sort((a, b) => b[1].length - a[1].length);
		const groups = new Map<string, GraphNode[]>();
		const rest: GraphNode[] = [];
		for (const [community, members] of ordered) {
			if (groups.size < MAX_LAYOUT_COMMUNITIES) groups.set(`group-${community}`, members);
			else rest.push(...members);
		}
		if (rest.length > 0) groups.set('group-rest', rest);

		for (const members of groups.values()) {
			members.sort((a, b) => b.degree - a.degree);
		}
		return groups;
	}

	private async layoutCommunities(
		data: GraphData,
		groups: Map<string, GraphNode[]>
	): Promise<NodePositions> {
		const groupByNote = new Map<string, string>();
		for (const [groupId, members] of groups) {
			for (const member of members) groupByNote.set(member.id, groupId);
		}

		const weights = new Map<string, number>();
		for (const { data: edge } of data.edges) {
			const a = groupByNote.get(edge.source);
			const b = groupByNote.get(edge.target);
			if (!a || !b || a === b) continue;
			const key = a < b ? `${a}|${b}` : `${b}|${a}`;
			weights.set(key, (weights.get(key) ?? 0) + 1);
		}

		const metaEdges = Array.from(weights.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, groups.size * MAX_META_EDGES_PER_COMMUNITY)
			.map(([key]) => {
				const [source, target] = key.split('|');
				return { data: { id: `meta-${key}`, source, target } };
			});

		const metaNodes = Array.from(groups, ([groupId, members]) => ({
			data: { id: groupId, diameter: spiralRadius(members.length) * 2 },
		}));
		const radiusById = new Map(
			Array.from(groups, ([groupId, members]) => [groupId, spiralRadius(members.length)])
		);
		const centers = await this.runLayout([...metaNodes, ...metaEdges], FCOSE_OPTIONS);
		return this.separateOverlaps(centers, radiusById);
	}

	private toElements(data: GraphData): LayoutElement[] {
		return [
			...data.nodes.map((node) => ({
				data: { id: node.data.id, diameter: nodeDiameter(node.data) },
			})),
			...data.edges.map((edge) => ({
				data: { id: edge.data.id, source: edge.data.source, target: edge.data.target },
			})),
		];
	}

	private runLayout(elements: LayoutElement[], options: object): Promise<NodePositions> {
		const cy = cytoscape({
			headless: true,
			styleEnabled: true,
			elements: elements as unknown as cytoscape.ElementDefinition[],
			style: [
				{ selector: 'node', style: { width: 'data(diameter)', height: 'data(diameter)' } },
			],
		});

		return new Promise<NodePositions>((resolve, reject) => {
			try {
				const layout = cy.elements().layout(options as unknown as cytoscape.LayoutOptions);
				layout.one('layoutstop', () => {
					const positions: NodePositions = {};
					cy.nodes().forEach((node) => {
						const { x, y } = node.position();
						positions[node.id()] = { x, y };
					});
					cy.destroy();
					resolve(positions);
				});
				layout.run();
			} catch (e) {
				cy.destroy();
				reject(e);
			}
		});
	}
}
