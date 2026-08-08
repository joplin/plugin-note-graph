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

const joplin = {
	data: {
		get: jest.fn(),
	},
	ai: joplinAi,
	settings: joplinSettings,
};

export default joplin;
