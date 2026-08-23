import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import {
	initializeAiNoteGraphPanel,
	showAiNoteGraphPanel,
	postGraphData,
	postGraphPatch,
	postStatus,
	postProgress,
	postEnrichmentProgress,
	postFocusNote,
	isNoteGraphPanelVisible,
	ScopeState,
	NotebookOption,
} from './ui/webview';
import { NoteRepository } from './data/NoteRepository';
import { NotePreprocessor } from './data/NotePreprocessor';
import { EventsRepository } from './data/EventsRepository';
import { FolderRepository } from './data/FolderRepository';
import { GraphCacheRepository } from './data/Database/GraphCacheRepository';
import { GraphBuilder } from './services/graph/GraphBuilder';
import { Note } from './data/Types';
import { GraphData } from './services/graph/types';
import { AnalysisController } from './services/AnalysisController';
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
import { NoteScopeResolver, ResolvedScope, ScopeMode, currentScopeKey } from './services/settings/NoteScopeResolver';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';

const graphCache = new GraphCacheRepository();
const analysisController = new AnalysisController(new GraphBuilder(), graphCache);
const noteScopeResolver = new NoteScopeResolver();

let currentScope: ResolvedScope = { folderIds: null, scopeKey: 'all' };
let currentScopeMode: ScopeMode = 'all';

/**
 * Loads all notes from the Joplin API and enriches them with links and tags.
 * @returns enriched notes ready for graph building.
 */
export const loadNotes = async (): Promise<{ notes: Note[]; scopeKey: string }> => {
	const noteRepository = new NoteRepository();
	const { notes } = await noteRepository.getAllNotes();
	const preprocessor = new NotePreprocessor();
	const enrichedNotes = await preprocessor.process(notes);

	const scopeSettings = await getScopeSettings();
	const resolvedScope = await noteScopeResolver.resolve(scopeSettings);
	currentScope = resolvedScope;
	currentScopeMode = scopeSettings.mode;
	const { folderIds, scopeKey } = resolvedScope;
	const scopedNotes = folderIds
		? enrichedNotes.filter((n) => folderIds.has(n.parent_id))
		: enrichedNotes;

	console.info(
		`Enriched ${enrichedNotes.length} notes` +
			(folderIds ? `, scoped to ${scopedNotes.length} (${scopeKey}).` : '.')
	);
	return { notes: scopedNotes, scopeKey };
};

const logPanelPostFailure = (e: unknown): void => {
	console.error('Failed to push update to panel:', e);
};

/**
 * Runs LLM enrichment (Pass B) against whichever graph is currently
 * committed and pushes a patch if it changed anything. Deliberately separate
 * from `runSemanticAnalysis`/`recomputeAndPost` so Pass A's graph reaches the
 * panel immediately instead of waiting on the much slower LLM pass — this
 * also means cancelling Pass B can never discard an already-good Pass A
 * graph, since it was already posted.
 */
const runEnrichmentFollowUp = async (): Promise<void> => {
	const enriched = await analysisController.enrichCurrentGraph((progress) => {
		postEnrichmentProgress(progress.current, progress.total).catch(logPanelPostFailure);
	});
	if (!enriched) return;

	const diff = analysisController.getLastDiff();
	if (diff) {
		await postGraphPatch(diff, enriched);
	}
};

/**
 * Embeds notes (if AI analysis is on and ready) and pushes whichever graph results.
 * A `null` result means a newer call started before this one finished — its
 * data is stale, so it's dropped instead of overwriting the newer graph.
 */
const runSemanticAnalysis = async (notes: Note[]): Promise<void> => {
	const result = await analysisController.embedAndBuildSemantic(notes, (progress) => {
		postProgress(progress.current, progress.total).catch(logPanelPostFailure);
	});
	if (!result) {
		return;
	}

	const { graphData, usedAi, fallbackReason } = result;
	await postGraphData(graphData);
	if (!usedAi && (await isAiAnalysisEnabled())) {
		await postStatus(fallbackReason ?? 'AI analysis unavailable - showing structural graph.');
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
		console.info(
			`LLM enrichment: cached graph already has labels for all ${total} semantic edge(s).`
		);
		return;
	}

	console.info(
		`LLM enrichment: cached graph is missing labels for ${unlabeled}/${total} semantic edge(s); backfilling in the background.`
	);
	await runEnrichmentFollowUp();
};

const runPostCacheLoadFollowUps = async (cached: GraphData): Promise<void> => {
	try {
		await incrementalUpdater.handleSyncComplete();
	} catch (e) {
		console.error('Post-cache-load sync sweep failed:', e);
	}

	try {
		const currentGraph = analysisController.getLastGraphData() ?? cached;
		await reportAndBackfillEnrichment(currentGraph);
	} catch (e) {
		console.error('Post-cache-load enrichment backfill failed:', e);
	}
};

let fullReloadInFlight: Promise<void> | null = null;
let fullReloadQueued = false;

const performFullReload = (): Promise<void> => {
	if (fullReloadInFlight) {
		fullReloadQueued = true;
		return fullReloadInFlight;
	}

	fullReloadInFlight = (async () => {
		do {
			fullReloadQueued = false;
			await analysisController.seedEnrichmentFromStore();
			const { notes: enrichedNotes, scopeKey } = await loadNotes();
			analysisController.setScopeKey(scopeKey);
			await postGraphData(analysisController.buildStructural(enrichedNotes));
			await runSemanticAnalysis(enrichedNotes);
		} while (fullReloadQueued);
	})().finally(() => {
		fullReloadInFlight = null;
	});

	return fullReloadInFlight;
};

let scopeReloadTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleScopeReload = (): void => {
	if (scopeReloadTimer) clearTimeout(scopeReloadTimer);
	scopeReloadTimer = setTimeout(() => {
		scopeReloadTimer = null;
		performFullReload().catch((e) => {
			console.error('Failed to reload after a scope change:', e);
		});
	}, 200);
};

const incrementalUpdater = new IncrementalUpdater(
	analysisController,
	(diff, graphData) => {
		postGraphPatch(diff, graphData).catch((e) => {
			console.error('Failed to push graph patch to panel:', e);
		});
	},
	performFullReload,
	new NoteRepository(),
	new NotePreprocessor(),
	new EventsRepository(),
	graphCache,
	undefined,
	undefined,
	() => {
		postStatus(
			'Note graph update paused after repeated failures; will retry on your next edit.'
		).catch(logPanelPostFailure);
	},
	Date.now,
	() => currentScope,
	(progress) => {
		postEnrichmentProgress(progress.current, progress.total).catch(logPanelPostFailure);
	}
);
const workspaceListener = new WorkspaceListener(incrementalUpdater);

let inFlightLoad: Promise<void> | null = null;
let lastLoadFailureTime = 0;
const LOAD_RETRY_COOLDOWN_MS = 30_000;

const syncScopeWithCache = async (): Promise<void> => {
	try {
		const scopeSettings = await getScopeSettings();
		const resolvedScope = await noteScopeResolver.resolve(scopeSettings);
		currentScope = resolvedScope;
		currentScopeMode = scopeSettings.mode;
		const { scopeKey } = resolvedScope;
		analysisController.setScopeKey(scopeKey);

		await analysisController.migrateCachedEnrichment();

		const cachedScopeKey = await graphCache.loadScopeKey();
		if (cachedScopeKey !== null && cachedScopeKey !== scopeKey) {
			console.info(
				`Note Graph scope changed (${cachedScopeKey} -> ${scopeKey}); discarding the cached graph.`
			);
			await graphCache.clearGraph();
		}
	} catch (e) {
		console.error(
			'Failed to check the note graph scope against the cache; proceeding with the cache as-is.',
			e
		);
	}
};

const ensureGraphLoaded = (): Promise<void> => {
	if (analysisController.hasNotes()) {
		return Promise.resolve();
	}
	if (inFlightLoad) {
		return inFlightLoad;
	}

	inFlightLoad = (async () => {
		try {
			await syncScopeWithCache();
			const cached = await analysisController.loadFromCache();
			if (cached) {
				console.info(
					`Loaded graph from cache: ${cached.nodes.length} notes, no recompute.`
				);
				await postGraphData(cached);
				await postStatus(
					'Loaded from local cache - not recomputed. Refreshes as you edit or sync.'
				);
				void runPostCacheLoadFollowUps(cached);
				return;
			}

			await performFullReload();
		} catch (error) {
			console.error('Failed to load note graph:', error);
			lastLoadFailureTime = Date.now();
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
		console.error('Failed to focus the note graph on the open note:', error);
	}
};

const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		try {
			await showAiNoteGraphPanel();
			await focusOnOpenNote();
			await ensureGraphLoaded();
		} catch (error) {
			console.error('Failed to load note graph:', error);
		}
	},
};

const focusPanelOnNoteSelectionChange = async (noteIds: string[]): Promise<void> => {
	try {
		if (!(await isNoteGraphPanelVisible())) return;
		await postFocusNote(noteIds[0] ?? null);
	} catch (error) {
		console.error('Failed to sync note graph focus to the note selection change:', error);
	}
};

const refreshCurrentNotebookScope = async (): Promise<void> => {
	if (currentScopeMode !== 'current') return;
	try {
		if (!analysisController.hasNotes()) return;
		if (!(await isNoteGraphPanelVisible())) return;

		const selectedFolder = await joplin.workspace.selectedFolder().catch(() => null);
		const scopeKey = currentScopeKey(selectedFolder?.id ?? null);
		if (scopeKey === currentScope.scopeKey) return;

		await performFullReload();
	} catch (error) {
		console.error('Failed to refresh current-notebook scope:', error);
	}
};

const recomputeAndPost = async (): Promise<void> => {
	const graphData = await analysisController.recompute();
	if (!graphData) return;

	await postGraphData(graphData);
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
			scheduleScopeReload();
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
		console.error('Failed to handle note graph settings change:', error);
	}
};

const retryEmbedding = async (): Promise<void> => {
	try {
		await runSemanticAnalysis(analysisController.getCurrentNotes());
	} catch (error) {
		console.error('Failed to retry AI embedding:', error);
	}
};

const retryEnrichment = async (): Promise<void> => {
	try {
		analysisController.clearCancellation();
		await runEnrichmentFollowUp();
	} catch (error) {
		console.error('Failed to retry AI enrichment:', error);
	}
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
	const { folders } = await new FolderRepository().getAllFolders();
	return folders.map((folder) => ({ id: folder.id, title: folder.title }));
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

const registerMenuItems = async (): Promise<void> => {
	await joplin.views.menuItems.create(
		SHOW_NOTE_GRAPH_MENU_ITEM,
		SHOW_NOTE_GRAPH_COMMAND,
		MenuItemLocation.Tools
	);
};

joplin.plugins.register({
	onStart: async function () {
		console.info('Note Graph plugin started.');
		await registerGraphSettings();
		await joplin.settings.onChange(handleSettingsChange);
		await initializeAiNoteGraphPanel(
			() => {
				if (Date.now() - lastLoadFailureTime < LOAD_RETRY_COOLDOWN_MS) return;
				void ensureGraphLoaded();
			},
			() => {
				analysisController.cancelCurrentRun();
				postStatus('Analysis cancelled.').catch(logPanelPostFailure);
			},
			onRequestFolders,
			onGetScopeState,
			onSetScope
		);
		await registerCommands();
		await registerMenuItems();
		await workspaceListener.register();
		await joplin.workspace.onNoteSelectionChange((event) => {
			void focusPanelOnNoteSelectionChange(event.value);
			void refreshCurrentNotebookScope();
		});
	},
});
