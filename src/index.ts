import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { initializeAiNoteGraphPanel, showAiNoteGraphPanel, postGraphData } from './ui/webview';
import { NoteRepository } from './data/NoteRepository';
import { NotePreprocessor } from './data/NotePreprocessor';
import { Note } from './data/Types';
import { GraphBuilder } from './services/graph/GraphBuilder';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';

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

const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		try {
			const enrichedNotes = await loadNotes();
			console.info(`Loaded ${enrichedNotes.length} notes.`);
			const builder = new GraphBuilder();
			const graphData = builder.build(enrichedNotes);
			await postGraphData(graphData);
			await showAiNoteGraphPanel();
		} catch (error) {
			console.error('Failed to load note graph:', error);
		}
	},
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
		await initializeAiNoteGraphPanel();
		await registerCommands();
		await registerMenuItems();
	},
});
