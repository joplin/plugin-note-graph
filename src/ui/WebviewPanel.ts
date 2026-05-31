import joplin from 'api';
import { ViewHandle } from 'api/types';

const PANEL_ID = 'aiNoteGraphPanel';
const PANEL_HTML = `
<div class="graph-panel">
	<button id="graph-close" class="graph-panel_close" type="button" aria-label="Close Note Graph">x</button>
	<div id="graph-root"></div>
</div>
`;
const PANEL_SCRIPTS = [
	'./ui/styles/panel.css',
	'./ui/panel.js',
];

let panelHandle: ViewHandle;

const createPanel = async (): Promise<ViewHandle> => {
	const handle = await joplin.views.panels.create(PANEL_ID);
	await joplin.views.panels.setHtml(handle, PANEL_HTML);
	await joplin.views.panels.onMessage(handle, async (message: { type?: string }) => {
		if (message?.type === 'close-note-graph') {
			await joplin.views.panels.hide(handle);
			return { done: true };
		}
	});

	for (const scriptPath of PANEL_SCRIPTS) {
		await joplin.views.panels.addScript(handle, scriptPath);
	}

	return handle;
};

const getPanel = (): ViewHandle => {
	if (!panelHandle) {
		throw new Error('Note Graph panel not initialized');
	}

	return panelHandle;
};

export const initializeAiNoteGraphPanel = async (): Promise<void> => {
	if (panelHandle) return;
	panelHandle = await createPanel();
};

export const showAiNoteGraphPanel = async (): Promise<void> => {
	const handle = getPanel();
	await joplin.views.panels.show(handle);
};