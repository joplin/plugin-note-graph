import joplin from 'api';
import { AnalysisController } from './AnalysisController';
import { NoteRepository } from '../data/NoteRepository';
import { NotePreprocessor } from '../data/NotePreprocessor';
import { Note } from '../data/Types';

jest.mock('../data/Database/VectorRepository', () => ({
	VectorRepository: jest.fn().mockImplementation(() => ({
		getMany: jest.fn().mockResolvedValue(new Map()),
		saveMany: jest.fn().mockResolvedValue(undefined),
	})),
}));

jest.mock('../data/Database/GraphCacheRepository', () => ({
	GraphCacheRepository: jest.fn().mockImplementation(() => ({
		loadGraph: jest.fn().mockResolvedValue(null),
		saveGraph: jest.fn().mockResolvedValue(undefined),
		saveScopeKey: jest.fn().mockResolvedValue(undefined),
		saveEnrichments: jest.fn().mockResolvedValue(undefined),
		loadEnrichments: jest.fn().mockResolvedValue([]),
	})),
}));

const hex = (digit: string): string => digit.repeat(32);

const A = hex('1');
const B = hex('2');
const C = hex('3');
const D = hex('4');

const rawNotes = [
	{
		id: A,
		parent_id: 'p',
		title: 'Alpha Note',
		body: `See [Beta](:/${B}) and [Gamma](:/${C}).`,
		created_time: 0,
		updated_time: 1,
		deleted_time: 0,
	},
	{
		id: B,
		parent_id: 'p',
		title: 'Beta',
		body: `Related to [Gamma](:/${C}).`,
		created_time: 0,
		updated_time: 1,
		deleted_time: 0,
	},
	{
		id: C,
		parent_id: 'p',
		title: 'Gamma',
		body: `Back to [Alpha](:/${A}).`,
		created_time: 0,
		updated_time: 1,
		deleted_time: 0,
	},
	{
		id: D,
		parent_id: 'p',
		title: 'Delta',
		body: `References [Alpha](:/${A}).`,
		created_time: 0,
		updated_time: 1,
		deleted_time: 0,
	},
];

const tags = [
	{ id: 't1', title: 'project' },
	{ id: 't2', title: 'todo' },
];

const tagNoteIds: Record<string, string[]> = {
	t1: [A, B],
	t2: [A, D],
};

const embeddings = [
	{ noteId: A, chunkIndex: 0, chunkText: '', vector: [1, 0] },
	{ noteId: B, chunkIndex: 0, chunkText: '', vector: [1, 0] },
	{ noteId: C, chunkIndex: 0, chunkText: '', vector: [0, 1] },
	{ noteId: D, chunkIndex: 0, chunkText: '', vector: [0.6, 0.8] },
];

const chatResponse = JSON.stringify({
	notes: [
		{ id: A, category: 'Gardening', centralityAdjustment: 0 },
		{ id: B, category: 'Gardening', centralityAdjustment: 0 },
		{ id: C, category: 'Cooking', centralityAdjustment: 1 },
		{ id: D, category: 'Gardening', centralityAdjustment: -1 },
	],
	relationships: [
		{ from: A, to: B, label: 'both list watering schedules' },
		{ from: C, to: D, label: 'expands the retry logic' },
	],
});

type ApiMock = {
	data: { get: jest.Mock };
	ai: { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock; chat: jest.Mock };
	settings: { value: jest.Mock; values: jest.Mock };
};

function stubApi(): void {
	const api = joplin as unknown as ApiMock;

	api.data.get.mockImplementation(async (path: string[]) => {
		if (path[0] === 'notes' && path.length === 1) {
			return { items: rawNotes, has_more: false };
		}
		if (path[0] === 'tags' && path.length === 1) {
			return { items: tags, has_more: false };
		}
		if (path[0] === 'tags' && path[2] === 'notes') {
			return { items: (tagNoteIds[path[1]] ?? []).map((id) => ({ id })), has_more: false };
		}
		return { items: [], has_more: false };
	});

	api.ai.getIndexStatus.mockResolvedValue({
		state: 'ready',
		modelId: 'test-model',
		notesIndexed: rawNotes.length,
		ready: true,
		totalNotes: rawNotes.length,
	});
	api.ai.getEmbeddings.mockResolvedValue({
		chunks: embeddings,
		dimension: 2,
		modelId: 'test-model',
	});
	api.ai.chat.mockResolvedValue(chatResponse);

	api.settings.value.mockImplementation(
		(key: string) =>
			key === 'noteGraph.aiAnalysisEnabled' || key === 'noteGraph.llmEnrichmentEnabled'
	);
	api.settings.values.mockResolvedValue({
		'noteGraph.similarityThreshold': 50,
		'noteGraph.maxEdgesPerNote': 5,
	});
}

async function loadEnrichedNotes(): Promise<Note[]> {
	const { notes } = await new NoteRepository().getAllNotes();
	return new NotePreprocessor().process(notes);
}

describe('AnalysisController (full pipeline golden set)', () => {
	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		stubApi();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('renders the structural graph end-to-end from notes fetched and enriched through the Joplin API', async () => {
		const controller = new AnalysisController();
		const notes = await loadEnrichedNotes();

		expect(controller.buildStructural(notes)).toMatchSnapshot();
	});

	it('renders the enriched semantic graph end-to-end through embedding fetch and Pass B LLM labelling', async () => {
		const controller = new AnalysisController();
		const notes = await loadEnrichedNotes();

		const result = await controller.embedAndBuildSemantic(notes);
		await controller.enrichCurrentGraph();

		expect(result?.usedAi).toBe(true);
		expect(controller.getLastGraphData()).toMatchSnapshot();
	});
});
