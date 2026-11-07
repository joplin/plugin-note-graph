import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import {
	PanelStatusAction,
	initializeAiNoteGraphPanel,
	showAiNoteGraphPanel,
	postGraphData,
	postGraphPatch,
	postStatus,
	postProgress,
	postEnrichmentProgress,
	postFocusNote,
	setGraphNotice,
	isNoteGraphPanelVisible,
	ScopeState,
	NotebookOption,
} from './ui/webview';
import { NoteRepository } from './data/NoteRepository';
import { TagRepository } from './data/TagRepository';
import { LinkExtractor } from './data/LinkExtractor';
import { DATA_API_RETRY } from './utils/retryWithBackoff';
import { NotePreprocessor } from './data/NotePreprocessor';
import { EventsRepository } from './data/EventsRepository';
import { FolderRepository } from './data/FolderRepository';
import { GraphCacheRepository } from './data/Database/GraphCacheRepository';
import { VectorRepository } from './data/Database/VectorRepository';
import { GraphBuilder } from './services/graph/GraphBuilder';
import { GraphLayoutEngine, LayoutName } from './services/graph/GraphLayoutEngine';
import { GraphPresenter, PresentedView } from './services/graph/GraphPresenter';
import { GraphDiffer } from './services/graph/GraphDiffer';
import { GraphViewBuilder, GraphViewRequest } from './services/graph/GraphViewBuilder';
import { LLMEnricher } from './services/llm/LLMEnricher';
import { Note } from './data/Types';
import { GraphData } from './services/graph/types';
import { AnalysisController } from './services/AnalysisController';
import { LoadedNotes, LoadProgress, NoteLoader } from './services/NoteLoader';
import { IncrementalUpdater } from './services/sync/IncrementalUpdater';
import { WorkspaceListener } from './services/sync/WorkspaceListener';
import {
	registerGraphSettings,
	isAiAnalysisEnabled,
	isLlmEnrichmentEnabled,
	getScopeSettings,
	AI_ANALYSIS_ENABLED_KEY,
	RETRY_EMBEDDING_KEY,
	RETRY_ENRICHMENT_KEY,
	NOTE_GRAPH_SETTING_KEYS,
	SCOPE_SETTING_KEYS,
	SCOPE_MODE_KEY,
	SCOPE_SELECTED_NOTEBOOKS_KEY,
} from './services/settings/GraphSettings';
import { NoteScopeResolver, ResolvedScope } from './services/settings/NoteScopeResolver';
import { ScopeFollower, WorkspaceSelection } from './services/settings/ScopeFollower';
import { RecordingLogger } from './services/status/RecordingLogger';
import { StatusTracker } from './services/status/StatusTracker';
import { buildStatusReport, StatusReport } from './services/status/StatusReport';
import { JoplinAiApi, AiIndexStatus } from './services/embeddings/providers/JoplinNativeProvider';
import { EdgeFactory } from './services/similarity/EdgeFactory';
import {
	DEFAULT_NEIGHBORS_PER_NOTE,
	KnnIndex,
	WORK_SLICE_MS,
} from './services/similarity/KnnIndex';
import { LouvainDetector } from './services/graph/LouvainDetector';
import { CentralityScorer } from './services/graph/CentralityScorer';
import { CommunityIdStabilizer } from './services/graph/CommunityIdStabilizer';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';

/** Joplin picks up re-embedded edits on a three-minute tick. */
const EMBEDDING_SWEEP_INTERVAL_MS = 3 * 60 * 1000;
const GRAPH_CACHE_WRITE_DELAY_MS = 3000;

const logger = new RecordingLogger();
const statusTracker = new StatusTracker();

const graphCache = new GraphCacheRepository();
const analysisController = new AnalysisController(
	new GraphBuilder(
		new EdgeFactory(),
		new LouvainDetector(logger),
		new CentralityScorer(),
		new KnnIndex(DEFAULT_NEIGHBORS_PER_NOTE, WORK_SLICE_MS, logger),
		new CommunityIdStabilizer(),
		logger
	),
	graphCache,
	new LLMEnricher({ logger }),
	new VectorRepository(),
	GRAPH_CACHE_WRITE_DELAY_MS,
	logger,
	() => graphPresenter.drawnNoteIds()
);
const noteScopeResolver = new NoteScopeResolver(
	new FolderRepository(DATA_API_RETRY, logger),
	logger
);

const createNotePreprocessor = (): NotePreprocessor =>
	new NotePreprocessor(new LinkExtractor(), new TagRepository(DATA_API_RETRY, logger), logger);

const noteLoader = new NoteLoader(
	new NoteRepository(DATA_API_RETRY, logger),
	createNotePreprocessor(),
	logger
);

const resolveViewScope = async (isLargeVault: boolean): Promise<ResolvedScope> =>
	noteScopeResolver.resolve(await getScopeSettings(), { wholeVaultAllowed: !isLargeVault });

const graphPresenter = new GraphPresenter(
	new GraphViewBuilder(),
	new GraphLayoutEngine(logger),
	graphCache,
	resolveViewScope,
	new GraphDiffer(),
	logger
);

const deliverView = ({ payload, patch }: PresentedView): Promise<void> =>
	patch ? postGraphPatch(patch, payload) : postGraphData(payload);

const readWorkspaceSelection = async (): Promise<WorkspaceSelection> => {
	const folder = await joplin.workspace.selectedFolder().catch(() => null);
	const note = await joplin.workspace.selectedNote().catch(() => null);
	return { folderId: folder?.id ?? null, noteId: note?.id ?? null };
};

const scopeFollower = new ScopeFollower(graphPresenter, readWorkspaceSelection, deliverView);

/** Sends a new version of the graph to the panel, as whichever view the user is on. */
const showGraph = async (graphData: GraphData): Promise<void> => {
	await deliverView(await graphPresenter.setGraph(graphData));
	statusTracker.graphShown();
};

let lastLoadIncomplete = false;

const INCOMPLETE_LOAD_NOTICE =
	'Some notes or tags could not be loaded, so this graph is incomplete. Run Show Note Graph again to retry.';
const FAILED_LOAD_NOTICE = 'Could not load your notes. Retrying shortly.';

const applyLoadedNotes = (loaded: LoadedNotes): void => {
	lastLoadIncomplete = !loaded.complete;
	statusTracker.notesLoaded(loaded.complete, false);
	analysisController.setCachePersistenceEnabled(loaded.complete);
	setGraphNotice(loaded.complete ? null : INCOMPLETE_LOAD_NOTICE);
	if (loaded.complete) {
		analysisController.pruneDeletedNotes(new Set(loaded.notes.map((note) => note.id)));
	}
};

const logPanelPostFailure = (e: unknown): void => {
	logger.error('Failed to push update to panel:', e);
};

/**
 * Runs LLM enrichment (Pass B) against whichever graph is currently
 * committed and pushes a patch if it changed anything. Deliberately separate
 * from `runSemanticAnalysis`/`recomputeAndPost` so Pass A's graph reaches the
 * panel immediately instead of waiting on the much slower LLM pass — this
 * also means cancelling Pass B can never discard an already-good Pass A
 * graph, since it was already posted.
 */
const reportEnrichmentProgress = (progress: { current: number; total: number }): void => {
	statusTracker.labelsProgressed(progress);
	postEnrichmentProgress(progress.current, progress.total).catch(logPanelPostFailure);
};

const runEnrichmentFollowUp = async (): Promise<void> => {
	const enriched = await analysisController.enrichCurrentGraph(reportEnrichmentProgress);
	if (enriched) await showGraph(enriched);
};

/**
 * Embeds notes (if AI analysis is on and ready) and pushes whichever graph results.
 * A `null` result means a newer call started before this one finished — its
 * data is stale, so it's dropped instead of overwriting the newer graph.
 */
const runSemanticAnalysis = async (notes: Note[]): Promise<void> => {
	statusTracker.aiStarted();
	const result = await analysisController.embedAndBuildSemantic(notes, (progress) => {
		statusTracker.aiProgressed(progress);
		postProgress(progress.current, progress.total).catch(logPanelPostFailure);
	});
	if (!result) {
		return;
	}

	const { graphData, usedAi, fallbackReason } = result;
	statusTracker.aiFinished(usedAi ? null : fallbackReason ?? null);
	await showGraph(graphData);
	if (!usedAi && (await isAiAnalysisEnabled())) {
		await postStatus(fallbackReason ?? 'AI analysis unavailable - showing structural graph.');
	}

	if (usedAi) {
		void incrementalUpdater.handleEmbeddingTick();
	}
	await runEnrichmentFollowUp();
};

const countUnlabeledSemanticEdges = (
	graphData: GraphData
): { total: number; unlabeled: number } => {
	const semanticEdges = graphData.edges.filter((edge) => edge.data.type === 'semantic');
	const unlabeled = semanticEdges.filter(
		(edge) => edge.data.relationshipLabel === undefined
	).length;
	return { total: semanticEdges.length, unlabeled };
};

const reportAndBackfillEnrichment = async (graphData: GraphData): Promise<void> => {
	if (!(await isLlmEnrichmentEnabled())) return;
	const { total, unlabeled } = countUnlabeledSemanticEdges(graphData);
	if (total === 0) return;

	if (unlabeled === 0) {
		logger.info(
			`LLM enrichment: cached graph already has labels for all ${total} semantic edge(s).`
		);
		return;
	}

	logger.info(
		`LLM enrichment: cached graph is missing labels for ${unlabeled}/${total} semantic edge(s); backfilling in the background.`
	);
	await runEnrichmentFollowUp();
};

const runPostCacheLoadFollowUps = async (cached: GraphData): Promise<void> => {
	try {
		await incrementalUpdater.handleSyncComplete();
	} catch (e) {
		logger.error('Post-cache-load sync sweep failed:', e);
	}

	try {
		await incrementalUpdater.reconcileWithVault();
	} catch (e) {
		logger.error('Could not check the cached graph against the vault:', e);
	}

	try {
		const currentGraph = analysisController.getLastGraphData() ?? cached;
		await reportAndBackfillEnrichment(currentGraph);
	} catch (e) {
		logger.error('Post-cache-load enrichment backfill failed:', e);
	}
};

let fullReloadInFlight: Promise<void> | null = null;
let fullReloadQueued = false;

const describeLoadProgress = (progress: LoadProgress): string =>
	progress.stage === 'notes'
		? 'Loading your notes...'
		: `Reading tags: ${progress.done} of ${progress.total} notes...`;

const showLoadProgress = (progress: LoadProgress): void => {
	const description = describeLoadProgress(progress);
	statusTracker.noteLoadProgressed(description);
	setGraphNotice(description);
};

const loadNotesShowingProgress = async (): Promise<LoadedNotes> => {
	statusTracker.noteLoadStarted();
	try {
		return await noteLoader.load(showLoadProgress);
	} catch (e) {
		statusTracker.noteLoadFailed();
		setGraphNotice(null);
		throw e;
	}
};

const performFullReload = (): Promise<void> => {
	if (fullReloadInFlight) {
		fullReloadQueued = true;
		return fullReloadInFlight;
	}

	fullReloadInFlight = (async () => {
		do {
			fullReloadQueued = false;
			await analysisController.seedEnrichmentFromStore();
			const loaded = await loadNotesShowingProgress();
			applyLoadedNotes(loaded);
			await showGraph(analysisController.buildStructural(loaded.notes));
			await runSemanticAnalysis(loaded.notes);
		} while (fullReloadQueued);
	})().finally(() => {
		fullReloadInFlight = null;
	});

	return fullReloadInFlight;
};

const showCurrentView = async (): Promise<void> => {
	const presented = await graphPresenter.refresh();
	if (presented) await deliverView(presented);
};

let scopeChangeTimer: ReturnType<typeof setTimeout> | null = null;

/** The mode and the notebook list are saved as two settings, so this waits for both. */
const scheduleScopeChange = (): void => {
	if (scopeChangeTimer) clearTimeout(scopeChangeTimer);
	scopeChangeTimer = setTimeout(() => {
		scopeChangeTimer = null;
		graphPresenter.resetView();
		showCurrentView().catch((e) => {
			logger.error('Failed to show the graph after a scope change:', e);
		});
	}, 200);
};

const incrementalUpdater = new IncrementalUpdater({
	analysisController,
	onGraphChanged: (graphData) => {
		showGraph(graphData).catch((e) => {
			logger.error('Failed to push graph update to panel:', e);
		});
	},
	onFullReloadNeeded: performFullReload,
	noteRepository: new NoteRepository(DATA_API_RETRY, logger),
	preprocessor: createNotePreprocessor(),
	eventsRepository: new EventsRepository(logger),
	graphCache,
	onEnrichmentProgress: reportEnrichmentProgress,
	logger,
});
const workspaceListener = new WorkspaceListener(incrementalUpdater, logger);

let inFlightLoad: Promise<void> | null = null;
let lastLoadFailureTime = 0;
const LOAD_RETRY_COOLDOWN_MS = 30_000;

const migrateCachedEnrichment = async (): Promise<void> => {
	try {
		await analysisController.migrateCachedEnrichment();
	} catch (e) {
		logger.error('Failed to migrate cached labels; proceeding with the cache as-is.', e);
	}
};

const ensureGraphLoaded = (): Promise<void> => {
	if (analysisController.hasNotes() && !lastLoadIncomplete) {
		return Promise.resolve();
	}
	if (inFlightLoad) {
		return inFlightLoad;
	}

	inFlightLoad = (async () => {
		try {
			if (lastLoadIncomplete) {
				await performFullReload();
				return;
			}

			await migrateCachedEnrichment();
			const cached = await analysisController.loadFromCache();
			if (cached) {
				logger.info(
					`Loaded graph from cache: ${cached.nodes.length} notes, no recompute.`
				);
				setGraphNotice(null);
				statusTracker.notesLoaded(true, true);
				await showGraph(cached);
				void runPostCacheLoadFollowUps(cached);
				return;
			}

			await performFullReload();
		} catch (error) {
			logger.error('Failed to load note graph:', error);
			statusTracker.noteLoadFailed();
			lastLoadFailureTime = Date.now();
			if (!analysisController.hasNotes()) setGraphNotice(FAILED_LOAD_NOTICE);
		} finally {
			inFlightLoad = null;
		}
	})();

	return inFlightLoad;
};

const focusOnOpenNote = async (): Promise<void> => {
	try {
		const openNote = await joplin.workspace.selectedNote();
		await postFocusNote(openNote?.id ?? null);
	} catch (error) {
		logger.error('Failed to focus the note graph on the open note:', error);
	}
};

const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		try {
			await showAiNoteGraphPanel();
			await focusOnOpenNote();
			if (analysisController.hasNotes()) await showCurrentView();
			await ensureGraphLoaded();
		} catch (error) {
			logger.error('Failed to load note graph:', error);
		}
	},
};

const focusPanelOnNoteSelectionChange = async (noteIds: string[]): Promise<void> => {
	try {
		if (!(await isNoteGraphPanelVisible())) return;
		await postFocusNote(noteIds[0] ?? null);
	} catch (error) {
		logger.error('Failed to sync note graph focus to the note selection change:', error);
	}
};

const followSelection = async (): Promise<void> => {
	try {
		if (!analysisController.hasNotes()) return;
		if (!(await isNoteGraphPanelVisible())) return;
		await scopeFollower.onSelectionChanged();
	} catch (error) {
		logger.error('Failed to follow the selected notebook:', error);
	}
};

const recomputeAndPost = async (): Promise<void> => {
	const graphData = await analysisController.recompute();
	if (!graphData) return;

	await showGraph(graphData);
	await runEnrichmentFollowUp();
};

const handleSettingsChange = async (event: { keys: string[] }): Promise<void> => {
	if (
		!analysisController.hasNotes() ||
		!event.keys.some((key) => NOTE_GRAPH_SETTING_KEYS.includes(key))
	) {
		return;
	}

	try {
		if (event.keys.includes(RETRY_EMBEDDING_KEY)) {
			if (await joplin.settings.value(RETRY_EMBEDDING_KEY)) {
				await joplin.settings.setValue(RETRY_EMBEDDING_KEY, false);
				await retryEmbedding();
			}
			return;
		}

		if (event.keys.includes(RETRY_ENRICHMENT_KEY)) {
			if (await joplin.settings.value(RETRY_ENRICHMENT_KEY)) {
				await joplin.settings.setValue(RETRY_ENRICHMENT_KEY, false);
				await retryEnrichment();
			}
			return;
		}

		if (event.keys.some((key) => SCOPE_SETTING_KEYS.includes(key))) {
			scheduleScopeChange();
			return;
		}

		if (event.keys.includes(AI_ANALYSIS_ENABLED_KEY)) {
			await runSemanticAnalysis(analysisController.getCurrentNotes());
			return;
		}

		if (!(await isAiAnalysisEnabled())) {
			return;
		}

		await recomputeGraph();
	} catch (error) {
		logger.error('Failed to handle note graph settings change:', error);
	}
};

const retryEmbedding = async (): Promise<void> => {
	try {
		await runSemanticAnalysis(analysisController.getCurrentNotes());
	} catch (error) {
		logger.error('Failed to retry AI embedding:', error);
	}
};

const retryEnrichment = async (): Promise<void> => {
	try {
		analysisController.clearCancellation();
		analysisController.allowMoreEnrichment();
		await runEnrichmentFollowUp();
	} catch (error) {
		logger.error('Failed to retry AI enrichment:', error);
	}
};

/** How long a read of Joplin AI's index state is reused, since the open status panel asks every few seconds. */
const AI_INDEX_STATUS_REUSE_MS = 5000;
let lastAiIndexRead: { at: number; index: AiIndexStatus | null } | null = null;

/** Reads `joplin.ai` and calls it here, without returning it: an async function returning the proxy would make Joplin look up `then` on it. */
const readAiIndexStatus = async (): Promise<{
	index: AiIndexStatus | null;
	unavailableReason: string | null;
}> => {
	const api = joplin.ai as unknown as JoplinAiApi | undefined;
	if (!api) return { index: null, unavailableReason: 'joplin.ai is not available.' };

	if (!lastAiIndexRead || Date.now() - lastAiIndexRead.at > AI_INDEX_STATUS_REUSE_MS) {
		const index = await api.getIndexStatus().catch((): null => null);
		lastAiIndexRead = { at: Date.now(), index };
	}
	return { index: lastAiIndexRead.index, unavailableReason: null };
};

const getStatusReport = async (): Promise<StatusReport> => {
	const aiEnabled = await isAiAnalysisEnabled();
	const labelsEnabled = await isLlmEnrichmentEnabled();
	const aiIndex = aiEnabled
		? await readAiIndexStatus()
		: { index: null, unavailableReason: null };
	const graph = analysisController.getLastGraphData();
	const semantic = graph ? countUnlabeledSemanticEdges(graph) : { total: 0, unlabeled: 0 };
	const budget = analysisController.getLabelBudget();

	return buildStatusReport({
		tracked: statusTracker.snapshot(),
		noteCount: analysisController.getCurrentNotes().length,
		ai: {
			enabled: aiEnabled,
			...aiIndex,
			embeddedNotes: analysisController.getEmbeddedNoteCount(),
			running: analysisController.isEmbeddingRunning(),
		},
		labels: {
			enabled: labelsEnabled,
			semanticEdges: semantic.total,
			labeledEdges: semantic.total - semantic.unlabeled,
			budgetUsed: budget.used,
			budgetLimit: budget.limit,
			running: analysisController.isEnrichmentRunning(),
		},
		problems: logger.recentProblems(),
	});
};

const reloadNotes = async (): Promise<void> => {
	if (!analysisController.hasNotes()) {
		await ensureGraphLoaded();
		return;
	}
	try {
		await performFullReload();
	} catch (error) {
		logger.error('Failed to reload notes:', error);
	}
};

/** Starts the action and returns at once, since the panel waits for the reply and these can take minutes. */
const onStatusAction = async (action: PanelStatusAction): Promise<void> => {
	switch (action) {
		case 'reload-notes':
			void reloadNotes();
			return;
		case 'retry-ai':
			void retryEmbedding();
			return;
		case 'retry-labels':
			void retryEnrichment();
			return;
		case 'clear-problems':
			logger.clearProblems();
			return;
	}
};

const cancelAnalysis = (): void => {
	statusTracker.cancelled(analysisController.isEnrichmentRunning() ? 'labels' : 'ai');
	analysisController.cancelCurrentRun();
	postStatus('Analysis cancelled.').catch(logPanelPostFailure);
};

const recomputeGraph = async (): Promise<void> => {
	if (!analysisController.hasEmbeddedNotes()) {
		await runSemanticAnalysis(analysisController.getCurrentNotes());
		return;
	}
	await recomputeAndPost();
};

const registerCommands = async (): Promise<void> => {
	await joplin.commands.register(noteGraphCommand);
};

const onRequestFolders = async (): Promise<NotebookOption[]> => {
	const { folders } = await new FolderRepository(DATA_API_RETRY, logger).getAllFolders();
	return folders.map((folder) => ({
		id: folder.id,
		title: folder.title,
		parentId: folder.parent_id,
	}));
};

const onGetScopeState = async (): Promise<ScopeState> => {
	return await getScopeSettings();
};

const onSetScope = async (
	mode: ScopeState['mode'],
	selectedNotebookIds: string[]
): Promise<void> => {
	await joplin.settings.setValue(SCOPE_MODE_KEY, mode);
	await joplin.settings.setValue(
		SCOPE_SELECTED_NOTEBOOKS_KEY,
		JSON.stringify(selectedNotebookIds)
	);
};

const onOpenView = async (request: GraphViewRequest): Promise<void> => {
	const presented = await graphPresenter.openView(request);
	if (presented) await deliverView(presented);
};

const onSetLayout = async (layout: LayoutName, grouped: boolean): Promise<void> => {
	const presented = await graphPresenter.setLayout(layout, grouped);
	if (presented) await deliverView(presented);
};

const onSetTagFilter = async (tag: string | null): Promise<void> => {
	const presented = await graphPresenter.setTagFilter(tag);
	if (presented) await deliverView(presented);
};

const sweepEmbeddingsWhileVisible = async (): Promise<void> => {
	if (await isNoteGraphPanelVisible()) await incrementalUpdater.handleEmbeddingTick();
};

const registerMenuItems = async (): Promise<void> => {
	await joplin.views.menuItems.create(
		SHOW_NOTE_GRAPH_MENU_ITEM,
		SHOW_NOTE_GRAPH_COMMAND,
		MenuItemLocation.Tools
	);
};

joplin.plugins.register({
	onStart: async function () {
		logger.info('Note Graph plugin started.');
		await registerGraphSettings();
		await joplin.settings.onChange(handleSettingsChange);
		await initializeAiNoteGraphPanel({
			onNoData: () => {
				if (Date.now() - lastLoadFailureTime < LOAD_RETRY_COOLDOWN_MS) return;
				void ensureGraphLoaded();
			},
			onCancel: cancelAnalysis,
			onRequestFolders,
			onGetScopeState,
			onSetScope,
			onOpenView,
			onSetLayout,
			onSetTagFilter,
			onSearchNotes: (query) => graphPresenter.search(query),
			onGetStatus: getStatusReport,
			onStatusAction,
		});
		await registerCommands();
		await registerMenuItems();
		await workspaceListener.register();
		setInterval(() => {
			sweepEmbeddingsWhileVisible().catch((e) => {
				logger.error('Scheduled embeddings sweep failed:', e);
			});
		}, EMBEDDING_SWEEP_INTERVAL_MS);
		await joplin.workspace.onNoteSelectionChange((event) => {
			void focusPanelOnNoteSelectionChange(event.value);
			void followSelection();
		});
	},
});
