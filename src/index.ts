import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import {
	initializeAiNoteGraphPanel,
	showAiNoteGraphPanel,
	postGraphData,
	postStatus,
	postProgress,
} from './ui/webview';
import { NoteRepository } from './data/NoteRepository';
import { NotePreprocessor } from './data/NotePreprocessor';
import { Note } from './data/Types';
import { AnalysisController } from './services/AnalysisController';
import { registerGraphSettings, isAiAnalysisEnabled } from './services/settings/GraphSettings';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';
const NOTE_GRAPH_SETTING_KEYS = [
	'noteGraph.aiAnalysisEnabled',
	'noteGraph.similarityThreshold',
	'noteGraph.maxEdgesPerNote',
];

const analysisController = new AnalysisController();
let lastLoadedNotes: Note[] | null = null;

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

/** Embeds notes (if AI analysis is on and ready) and pushes whichever graph results. */
const runSemanticAnalysis = async (notes: Note[]): Promise<void> => {
	const { graphData, usedAi } = await analysisController.embedAndBuildSemantic(notes, (progress) => {
		void postProgress(progress.current, progress.total);
	});

	await postGraphData(graphData);
	if (!usedAi && (await isAiAnalysisEnabled())) {
		await postStatus('AI analysis unavailable - showing structural graph.');
	}
};

const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		try {
			const enrichedNotes = await loadNotes();
			console.info(`Loaded ${enrichedNotes.length} notes.`);
			lastLoadedNotes = enrichedNotes;

			await postGraphData(analysisController.buildStructural(enrichedNotes));
			await showAiNoteGraphPanel();

			await runSemanticAnalysis(enrichedNotes);
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
	if (!lastLoadedNotes || !event.keys.some((key) => NOTE_GRAPH_SETTING_KEYS.includes(key))) {
		return;
	}

	if (event.keys.includes('noteGraph.aiAnalysisEnabled')) {
		await runSemanticAnalysis(lastLoadedNotes);
		return;
	}

	const graphData = await analysisController.recompute();
	if (graphData) {
		await postGraphData(graphData);
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
	},
});
