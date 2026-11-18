const joplinAi = {
	getIndexStatus: jest.fn(),
	getEmbeddings: jest.fn(),
	search: jest.fn(),
	chat: jest.fn(),
};

const joplinSettings = {
	registerSection: jest.fn(),
	registerSettings: jest.fn(),
	value: jest.fn(),
	values: jest.fn(),
	setValue: jest.fn(),
	onChange: jest.fn(),
};

const joplinWorkspace = {
	onNoteChange: jest.fn(),
	onNoteSelectionChange: jest.fn(),
	onSyncComplete: jest.fn(),
	selectedNote: jest.fn(),
	selectedFolder: jest.fn(),
};

const joplinViewsPanels = {
	create: jest.fn(),
	setHtml: jest.fn(),
	onMessage: jest.fn(),
	addScript: jest.fn(),
	show: jest.fn(),
	hide: jest.fn(),
	postMessage: jest.fn(),
	visible: jest.fn(),
};

const joplinViewsDialogs = {
	create: jest.fn(),
	setHtml: jest.fn(),
	setButtons: jest.fn(),
	setFitToContent: jest.fn(),
	addScript: jest.fn(),
	open: jest.fn(),
};

const joplinCommands = {
	execute: jest.fn(),
};

const joplin = {
	data: {
		get: jest.fn(),
	},
	ai: joplinAi,
	settings: joplinSettings,
	workspace: joplinWorkspace,
	views: {
		panels: joplinViewsPanels,
		dialogs: joplinViewsDialogs,
	},
	commands: joplinCommands,
	plugins: {
		installationDir: jest.fn(),
	},
	window: {
		loadChromeCssFile: jest.fn(),
	},
};

export default joplin;
