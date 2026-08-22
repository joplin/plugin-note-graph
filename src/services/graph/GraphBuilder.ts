import { Note } from '../../data/Types';
import { EdgeFactory } from '../similarity/EdgeFactory';
import { SimilarityEngine } from '../similarity/SimilarityEngine';
import { EmbeddedNote } from '../embeddings/Types';
import { GraphData, GraphEdge, GraphNode, RenderedEdge } from './types';
import { LouvainDetector } from './LouvainDetector';
import { CentralityScorer } from './CentralityScorer';

const VERY_SHORT_BODY_CHARS = 20;

export class GraphBuilder {
	private readonly edgeFactory: EdgeFactory;
	private readonly louvainDetector: LouvainDetector;
	private readonly centralityScorer: CentralityScorer;

	public constructor(
		edgeFactory = new EdgeFactory(),
		louvainDetector = new LouvainDetector(),
		centralityScorer = new CentralityScorer()
	) {
		this.edgeFactory = edgeFactory;
		this.louvainDetector = louvainDetector;
		this.centralityScorer = centralityScorer;
	}

	/**
	 * Builds a graph from enriched notes, creating nodes and edges from links and shared tags.
	 * @param notes - notes with `links` and `tags` already populated.
	 * @returns graph data ready for rendering (nodes and edges).
	 */
	public build(notes: Note[]): GraphData {
		const edges = this.edgeFactory.createEdges(notes);
		return this.buildData(notes, edges);
	}

	/**
	 * Builds a graph with semantic edges computed from embedding vectors,
	 * in addition to link and tag edges.
	 */
	public async buildWithSimilarity(
		notes: Note[],
		embeddedNotes: EmbeddedNote[],
		threshold?: number,
		topK?: number,
		isCancelled?: () => boolean
	): Promise<GraphData> {
		const structuralEdges = this.edgeFactory.createEdges(notes);

		const engine = new SimilarityEngine(notes, embeddedNotes);
		const pairs = await engine.compute(threshold, topK, isCancelled);
		const semanticEdges = this.edgeFactory.createSemanticEdges(pairs);

		const allEdges = [...structuralEdges, ...semanticEdges];
		return this.buildData(notes, allEdges);
	}

	private buildData(notes: Note[], edges: GraphEdge[]): GraphData {
		const degreeMap = this.computeDegreeMap(notes, edges);
		const communities = this.louvainDetector.detectCommunities(notes, edges);
		const sizes = this.centralityScorer.score(degreeMap);
		const nodes = this.buildNodes(notes, degreeMap, communities, sizes);

		const nodeIdSet = new Set(nodes.map((n) => n.data.id));
		const visibleEdges = this.filterVisibleEdges(edges, nodeIdSet);

		this.logGraphStats(nodes, visibleEdges, degreeMap, communities);

		return {
			nodes,
			edges: visibleEdges.map((e) => ({ data: this.toRenderedEdge(e) })),
			allNotesVeryShort: this.isAllNotesVeryShort(notes),
		};
	}

	private isAllNotesVeryShort(notes: Note[]): boolean {
		return (
			notes.length > 0 &&
			notes.every((n) => (n.body ?? '').trim().length < VERY_SHORT_BODY_CHARS)
		);
	}

	private toRenderedEdge(edge: GraphEdge): RenderedEdge {
		return { ...edge, id: `${edge.source}::${edge.target}::${edge.type}` };
	}

	/** Counts each note's connections, including notes an edge references that aren't in `notes`. */
	private computeDegreeMap(notes: Note[], edges: GraphEdge[]): Map<string, number> {
		const degreeMap = new Map<string, number>();
		for (const note of notes) {
			degreeMap.set(note.id, 0);
		}

		for (const edge of edges) {
			degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
			degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
		}

		return degreeMap;
	}

	/** Builds one node per note, truncating long titles to keep labels readable in the graph. */
	private buildNodes(
		notes: Note[],
		degreeMap: Map<string, number>,
		communities: Map<string, number>,
		sizes: Map<string, number>
	): Array<{ data: GraphNode }> {
		const nodes: Array<{ data: GraphNode }> = [];
		for (const note of notes) {
			const degree = degreeMap.get(note.id) ?? 0;
			const community = communities.get(note.id);
			const size = sizes.get(note.id);
			if (community === undefined || size === undefined) {
				console.error(
					`Note ${note.id} missing from community or size map (expected every note to be covered); defaulting to community 0, size 1.`
				);
			}

			const label = note.title || '(untitled)';
			nodes.push({
				data: {
					id: note.id,
					label: label.length > 64 ? label.substring(0, 61) + '...' : label,
					noteId: note.id,
					degree,
					community: community ?? 0,
					size: size ?? 1,
				},
			});
		}
		return nodes;
	}

	/** Drops edges referencing a note outside the current node set. */
	private filterVisibleEdges(edges: GraphEdge[], nodeIdSet: Set<string>): GraphEdge[] {
		return edges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
	}

	private logGraphStats(
		nodes: Array<{ data: GraphNode }>,
		visibleEdges: GraphEdge[],
		degreeMap: Map<string, number>,
		communities: Map<string, number>
	): void {
		const connectedIds = new Set<string>();
		for (const edge of visibleEdges) {
			connectedIds.add(edge.source);
			connectedIds.add(edge.target);
		}
		const isolatedCount = nodes.length - connectedIds.size;
		const maxDegree = Math.max(1, ...degreeMap.values());
		const communityCount = new Set(communities.values()).size;

		console.info(
			`Graph built: ${nodes.length} nodes, ${visibleEdges.length} edges ` +
				`(${isolatedCount} isolated, max degree ${maxDegree}, ${communityCount} communities)`
		);
	}
}
