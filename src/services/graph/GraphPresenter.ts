import { LayoutStore, NodePositions } from '../../data/Database/GraphCacheRepository';
import { GraphDiff, GraphDiffer } from './GraphDiffer';
import { GraphLayoutEngine, LayoutName } from './GraphLayoutEngine';
import {
	GraphView,
	GraphViewBuilder,
	GraphViewRequest,
	NoteSearchResult,
} from './GraphViewBuilder';
import { ResolvedScope, WHOLE_VAULT_SCOPE } from '../settings/NoteScopeResolver';
import { GraphData } from './types';
import { Logger, consoleLogger } from '../../utils/Logger';

/** A change that adds this share of a view's edges reshapes the graph, so it gets a fresh layout. */
const RELAYOUT_EDGE_SHARE = 0.3;
/** Connections views come and go, so only the last few keep their layout, in memory. */
const MAX_REMEMBERED_LAYOUTS = 20;

export interface PositionedNode {
	data: GraphData['nodes'][number]['data'];
	position: { x: number; y: number };
}

export interface GraphViewPayload extends GraphData {
	nodes: PositionedNode[];
	view: Omit<GraphView, 'data'>;
	/** Changes whenever positions were computed from scratch, so the panel knows to redraw rather than patch. */
	layoutRevision: number;
}

export interface PresentedView {
	payload: GraphViewPayload;
	/** What changed since the last view, when the panel can apply it as a patch. */
	patch: GraphDiff | null;
}

/**
 * Decides what the panel shows: which view of the graph, at which positions, and
 * whether a change can be sent as a patch. All work is queued, so overlapping
 * updates can't finish out of order.
 */
export class GraphPresenter {
	private graph: GraphData | null = null;
	private request: GraphViewRequest = { kind: 'auto' };
	private layout: LayoutName = 'fcose';
	private grouped = false;
	private tag: string | null = null;
	private scope: ResolvedScope = WHOLE_VAULT_SCOPE;
	private current: GraphViewPayload | null = null;
	private positions: NodePositions = {};
	private layoutRevision = 0;
	private readonly rememberedLayouts = new Map<string, NodePositions>();
	private queue: Promise<unknown> = Promise.resolve();

	public constructor(
		private readonly viewBuilder: GraphViewBuilder,
		private readonly layoutEngine: Pick<GraphLayoutEngine, 'compute' | 'placeNewNodes'>,
		private readonly layoutStore: LayoutStore,
		private readonly resolveScope: (isLargeVault: boolean) => Promise<ResolvedScope>,
		private readonly differ: GraphDiffer = new GraphDiffer(),
		private readonly logger: Logger = consoleLogger
	) {}

	/** Shows a new version of the graph, keeping the view the user is on. */
	public setGraph(graph: GraphData): Promise<PresentedView> {
		return this.enqueue(async () => {
			this.graph = graph;
			return this.present();
		});
	}

	public openView(request: GraphViewRequest): Promise<PresentedView | null> {
		return this.enqueue(async () => {
			if (!this.graph) return null;
			this.request = request;
			return this.present();
		});
	}

	public setLayout(layout: LayoutName, grouped: boolean): Promise<PresentedView | null> {
		return this.enqueue(async () => {
			if (!this.graph) return null;
			this.layout = layout;
			this.grouped = grouped;
			this.current = null;
			return this.present();
		});
	}

	public setTagFilter(tag: string | null): Promise<PresentedView | null> {
		return this.enqueue(async () => {
			if (!this.graph) return null;
			this.tag = tag;
			return this.present();
		});
	}

	/** Works out the scope again and shows what it now means. */
	public refresh(): Promise<PresentedView | null> {
		return this.enqueue(async () => (this.graph ? this.present() : null));
	}

	/** Goes back to the main view with no filter, for when the user picks a different scope. */
	public resetView(): void {
		this.request = { kind: 'auto' };
		this.tag = null;
	}

	public currentScope(): ResolvedScope {
		return this.scope;
	}

	public search(query: string): NoteSearchResult[] {
		return this.graph ? this.viewBuilder.search(this.graph, query) : [];
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async present(): Promise<PresentedView> {
		const graph = this.graph as GraphData;
		await this.updateScope(graph);
		const view = this.viewBuilder.build(graph, this.request, {
			scope: this.scope,
			tag: this.tag,
		});
		const previous = this.current?.view.key === view.key ? this.current : null;

		if (!previous) return this.presentWithFreshPositions(view, true);

		if (!this.reshapesGraph(previous, view.data)) {
			const reused = this.layoutEngine.placeNewNodes(view.data, this.positions);
			if (reused) return this.presentReusingPositions(view, previous, reused);
		}
		return this.presentWithFreshPositions(view, false);
	}

	/** A failure here leaves the last known scope in place rather than losing the graph. */
	private async updateScope(graph: GraphData): Promise<void> {
		try {
			this.scope = await this.resolveScope(this.viewBuilder.isLarge(graph));
		} catch (e) {
			this.logger.error('Failed to work out the note graph scope; keeping the last one:', e);
		}
	}

	private reshapesGraph(previous: GraphViewPayload, data: GraphData): boolean {
		const previousIds = new Set(previous.edges.map((edge) => edge.data.id));
		const added = data.edges.filter((edge) => !previousIds.has(edge.data.id)).length;
		return added > Math.max(previous.edges.length * RELAYOUT_EDGE_SHARE, 10);
	}

	private presentReusingPositions(
		view: GraphView,
		previous: GraphViewPayload,
		positions: NodePositions
	): PresentedView {
		this.positions = positions;
		this.saveLayout(view, positions);
		const payload = this.buildPayload(view, positions);
		const diff = this.differ.computeDiff(previous, view.data);
		this.current = payload;
		return { payload, patch: this.withPositions(diff, positions) };
	}

	/** @param maySaveTime - false when the graph itself changed shape, because a saved layout would ignore that change. */
	private async presentWithFreshPositions(
		view: GraphView,
		maySaveTime: boolean
	): Promise<PresentedView> {
		const saved = maySaveTime ? await this.loadSavedLayout(view) : null;
		const reused = saved ? this.layoutEngine.placeNewNodes(view.data, saved) : null;
		const positions = reused ?? (await this.computePositions(view));
		this.positions = positions;
		this.layoutRevision++;
		const payload = this.buildPayload(view, positions);
		this.current = payload;
		return { payload, patch: null };
	}

	private async computePositions(view: GraphView): Promise<NodePositions> {
		if (view.data.nodes.length === 0) return {};

		const started = Date.now();
		const positions = await this.layoutEngine.compute({
			data: view.data,
			layout: this.layout,
			grouped: this.grouped,
		});
		this.logger.info(
			`Layout computed for ${view.data.nodes.length} nodes in ${Date.now() - started} ms.`
		);
		this.saveLayout(view, positions);
		return positions;
	}

	/** Only the main view of a scope is worth keeping on disk: there's one per scope, and it's what reopening shows. */
	private isKeptOnDisk(view: GraphView): boolean {
		return (view.kind === 'full' || view.kind === 'notebook') && !view.activeTag;
	}

	private async loadSavedLayout(view: GraphView): Promise<NodePositions | null> {
		if (!this.isKeptOnDisk(view))
			return this.rememberedLayouts.get(this.layoutKey(view)) ?? null;

		try {
			return await this.layoutStore.loadLayout(this.layoutKey(view));
		} catch (e) {
			this.logger.error('Failed to load a saved layout; computing a new one:', e);
			return null;
		}
	}

	private saveLayout(view: GraphView, positions: NodePositions): void {
		if (!this.isKeptOnDisk(view)) {
			this.rememberLayout(this.layoutKey(view), positions);
			return;
		}
		this.layoutStore.saveLayout(this.layoutKey(view), positions).catch((e) => {
			this.logger.error('Failed to save the layout:', e);
		});
	}

	private rememberLayout(key: string, positions: NodePositions): void {
		this.rememberedLayouts.delete(key);
		this.rememberedLayouts.set(key, positions);
		if (this.rememberedLayouts.size > MAX_REMEMBERED_LAYOUTS) {
			const oldest = this.rememberedLayouts.keys().next().value as string;
			this.rememberedLayouts.delete(oldest);
		}
	}

	private layoutKey(view: GraphView): string {
		const grouping = this.grouped ? 'grouped' : 'plain';
		return [view.key, this.layout, grouping].join('|');
	}

	private buildPayload(view: GraphView, positions: NodePositions): GraphViewPayload {
		const { data, ...viewDetails } = view;
		return {
			nodes: data.nodes.map((node) => ({
				data: node.data,
				position: positions[node.data.id] ?? { x: 0, y: 0 },
			})),
			edges: data.edges,
			allNotesVeryShort: data.allNotesVeryShort,
			view: viewDetails,
			layoutRevision: this.layoutRevision,
		};
	}

	private withPositions(diff: GraphDiff, positions: NodePositions): GraphDiff {
		return {
			...diff,
			upsertedNodes: diff.upsertedNodes.map((node) => ({
				...node,
				position: positions[node.data.id],
			})),
		};
	}
}
