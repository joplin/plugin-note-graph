const joplinAi = {
	getIndexStatus: jest.fn(),
	getEmbeddings: jest.fn(),
	search: jest.fn(),
	chat: jest.fn(),
};

const joplin = {
	data: {
		get: jest.fn(),
	},
	ai: joplinAi,
};

export default joplin;
