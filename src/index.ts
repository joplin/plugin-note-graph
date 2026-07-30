import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import {
	initializeAiNoteGraphPanel,
	showAiNoteGraphPanel,
	postGraphData,
	postGraphPatch,
	postStatus,
	postProgress,
} from './ui/webview';
import { NoteRepository } from './data/NoteRepository';
import { NotePreprocessor } from './data/NotePreprocessor';
import { EventsRepository } from './data/EventsRepository';
import { GraphCacheRepository } from './data/Database/GraphCacheRepository';
import { GraphBuilder } from './services/graph/GraphBuilder';
import { Note } from './data/Types';
import { AnalysisController } from './services/AnalysisController';
import { IncrementalUpdater } from './services/sync/IncrementalUpdater';
import { WorkspaceListener } from './services/sync/WorkspaceListener';
import {
	registerGraphSettings,
	isAiAnalysisEnabled,
	AI_ANALYSIS_ENABLED_KEY,
	NOTE_GRAPH_SETTING_KEYS,
} from './services/settings/GraphSettings';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';

const graphCache = new GraphCacheRepository();
const analysisController = new AnalysisController(new GraphBuilder(), graphCache);

/**
 * Loads all notes from the Joplin API and enriches them with links and tags.
 * @returns enriched notes ready for graph building.
 */
export const loadNotes = async (): Promise<Note[]> => {
	const noteRepository = new NoteRepository();
	const { notes } = await noteRepository.getAllNotes();
	const preprocessor = new NotePreprocessor();
	const enrichedNotes = await preprocessor.process(notes);
	console.info(`Enriched ${enrichedNotes.length} notes.`);
	return enrichedNotes;
};

/**
 * Embeds notes (if AI analysis is on and ready) and pushes whichever graph results.
 * A `null` result means a newer call started before this one finished — its
 * data is stale, so it's dropped instead of overwriting the newer graph.
 */
const runSemanticAnalysis = async (notes: Note[]): Promise<void> => {
	const result = await analysisController.embedAndBuildSemantic(notes, (progress) => {
		void postProgress(progress.current, progress.total);
	});
	if (!result) {
		return;
	}

	const { graphData, usedAi, fallbackReason } = result;
	await postGraphData(graphData);
	if (!usedAi && (await isAiAnalysisEnabled())) {
		await postStatus(fallbackReason ?? 'AI analysis unavailable - showing structural graph.');
	}
};

const performFullReload = async (): Promise<void> => {
	const enrichedNotes = await loadNotes();
	console.info(`Loaded ${enrichedNotes.length} notes.`);
	await postGraphData(analysisController.buildStructural(enrichedNotes));
	await runSemanticAnalysis(enrichedNotes);
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
	graphCache
);
const workspaceListener = new WorkspaceListener(incrementalUpdater);

const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		try {
			if (analysisController.hasNotes()) {
				await showAiNoteGraphPanel();
				return;
			}

			const cached = await analysisController.loadFromCache();
			if (cached) {
				console.info(`Loaded graph from cache: ${cached.nodes.length} notes, no recompute.`);
				await postGraphData(cached);
				await showAiNoteGraphPanel();
				await postStatus('Loaded from local cache - not recomputed. Refreshes as you edit or sync.');
				incrementalUpdater.handleSyncComplete().catch((e) => {
					console.error('Post-cache-load sync sweep failed:', e);
				});
				return;
			}

			await showAiNoteGraphPanel();
			await performFullReload();
		} catch (error) {
			console.error('Failed to load note graph:', error);
		}
	},
};

/**
 * Reacts to changes made in Tools → Options → Note Graph. Toggling AI analysis
 * re-runs the full analysis; changing threshold/top-K only recomputes from the
 * already-embedded vectors. No-ops if the graph hasn't been opened yet.
 */
const handleSettingsChange = async (event: { keys: string[] }): Promise<void> => {
	if (
		!analysisController.hasNotes() ||
		!event.keys.some((key) => NOTE_GRAPH_SETTING_KEYS.includes(key))
	) {
		return;
	}

	try {
		if (event.keys.includes(AI_ANALYSIS_ENABLED_KEY)) {
			await runSemanticAnalysis(analysisController.getCurrentNotes());
			return;
		}

		// Threshold / top-K only affect semantic edges, which exist only while AI
		// analysis is enabled (matches the settings' own description). Skip the
		// recompute when it's off so a stale embedding cache can't resurrect edges.
		if (!(await isAiAnalysisEnabled())) {
			return;
		}

		const graphData = await analysisController.recompute();
		if (graphData) {
			await postGraphData(graphData);
		}
	} catch (error) {
		console.error('Failed to handle note graph settings change:', error);
	}
};

const registerCommands = async (): Promise<void> => {
	await joplin.commands.register(noteGraphCommand);
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
		await initializeAiNoteGraphPanel();
		await registerCommands();
		await registerMenuItems();
		await workspaceListener.register();
	},
});
