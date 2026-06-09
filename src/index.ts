import joplin from 'api';
import { MenuItemLocation } from 'api/types';
import { initializeAiNoteGraphPanel, showAiNoteGraphPanel } from './ui/webview';
import { NoteRepository } from './data/NoteRepository';

const SHOW_NOTE_GRAPH_COMMAND = 'showNoteGraph';
const SHOW_NOTE_GRAPH_MENU_ITEM = 'showNoteGraphMenuItem';
const noteGraphCommand = {
	name: SHOW_NOTE_GRAPH_COMMAND,
	label: 'Show Note Graph',
	execute: async () => {
		await showAiNoteGraphPanel();
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
		await initializeAiNoteGraphPanel();
		await registerCommands();
		await registerMenuItems();

		// eslint-disable-next-line no-console
		console.info('Note Graph plugin started.');

		const noteRepository = new NoteRepository();
		const allNotes = await noteRepository.getAllNotes();
	},
});
