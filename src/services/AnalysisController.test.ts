import { AnalysisController } from './AnalysisController';
import { GraphBuilder } from './graph/GraphBuilder';
import { ProviderResolver } from './embeddings/ProviderResolver';
import { EmbeddingOrchestrator } from './embeddings/Orchestrator';
import { isAiAnalysisEnabled, getSimilaritySettings } from './settings/GraphSettings';
import { Note } from '../data/Types';
import { EmbeddingProvider } from './embeddings/Types';

jest.mock('./graph/GraphBuilder');
jest.mock('./embeddings/ProviderResolver');
jest.mock('./embeddings/Orchestrator');
jest.mock('./settings/GraphSettings');
jest.mock('../data/Database/VectorRepository', () => ({
	VectorRepository: jest.fn(),
}));

const MockGraphBuilder = GraphBuilder as jest.MockedClass<typeof GraphBuilder>;
const MockProviderResolver = ProviderResolver as jest.Mocked<typeof ProviderResolver>;
const MockOrchestrator = EmbeddingOrchestrator as jest.MockedClass<typeof EmbeddingOrchestrator>;
const mockIsAiAnalysisEnabled = isAiAnalysisEnabled as jest.Mock;
const mockGetSimilaritySettings = getSimilaritySettings as jest.Mock;

function note(id: string): Note {
	return {
		id,
		parent_id: 'p1',
		title: id,
		body: '',
		created_time: 0,
		updated_time: 1,
		links: [],
		tags: [],
	};
}

const fakeProvider: EmbeddingProvider = {
	id: 'joplin-native',
	modelName: 'test-model',
	fetchVectorsByNoteIds: jest.fn(),
};

describe('AnalysisController', () => {
	let mockBuilder: jest.Mocked<GraphBuilder>;
	let controller: AnalysisController;
	let mockOrchestratorInstance: {
		setProvider: jest.Mock;
		setCache: jest.Mock;
		setOnProgress: jest.Mock;
		embedNotes: jest.Mock;
	};

	beforeEach(() => {
		jest.clearAllMocks();
		mockBuilder = new MockGraphBuilder() as jest.Mocked<GraphBuilder>;
		mockBuilder.build.mockReturnValue({ nodes: [], edges: [] });
		mockBuilder.buildWithSimilarity.mockResolvedValue({ nodes: [], edges: [] });
		mockGetSimilaritySettings.mockResolvedValue({ threshold: 0.5, topK: 5 });
		controller = new AnalysisController(mockBuilder);

		mockOrchestratorInstance = {
			setProvider: jest.fn(),
			setCache: jest.fn(),
			setOnProgress: jest.fn(),
			embedNotes: jest.fn().mockResolvedValue({ embeddedNotes: [], errors: [] }),
		};
		MockOrchestrator.mockImplementation(
			() => mockOrchestratorInstance as unknown as EmbeddingOrchestrator
		);
	});

	describe('buildStructural', () => {
		it('delegates directly to GraphBuilder.build', () => {
			const notes = [note('a')];
			controller.buildStructural(notes);
			expect(mockBuilder.build).toHaveBeenCalledWith(notes);
		});
	});

	describe('embedAndBuildSemantic', () => {
		it('falls back to the structural graph when the setting is off', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result.usedAi).toBe(false);
			expect(mockBuilder.build).toHaveBeenCalledWith(notes);
			expect(MockProviderResolver.resolveWithValidation).not.toHaveBeenCalled();
		});

		it('falls back to the structural graph when provider resolution throws', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValue(
				new Error('joplin.ai is not available')
			);
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result.usedAi).toBe(false);
			expect(mockBuilder.build).toHaveBeenCalledWith(notes);
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('falls back to the structural graph when embedding produces no vectors', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [],
				errors: [{ noteId: 'a', error: 'Note not yet indexed by Joplin AI.' }],
			});
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result.usedAi).toBe(false);
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('builds the semantic graph on success', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const embeddedNotes = [{ note: note('a'), embedding: [1, 0] }];
			mockOrchestratorInstance.embedNotes.mockResolvedValue({ embeddedNotes, errors: [] });
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result.usedAi).toBe(true);
			expect(mockOrchestratorInstance.setProvider).toHaveBeenCalledWith(fakeProvider);
			expect(mockOrchestratorInstance.setCache).toHaveBeenCalled();
			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalledWith(notes, embeddedNotes, 0.5, 5);
		});

		it('wires an onProgress callback into the orchestrator when provided', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			const onProgress = jest.fn();

			await controller.embedAndBuildSemantic([note('a')], onProgress);

			expect(mockOrchestratorInstance.setOnProgress).toHaveBeenCalledWith(onProgress);
		});
	});

	describe('recompute', () => {
		it('returns null when nothing has been embedded yet', async () => {
			const result = await controller.recompute();
			expect(result).toBeNull();
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('reuses the last embedded notes without re-embedding, using the current settings', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const notes = [note('a')];
			const embeddedNotes = [{ note: note('a'), embedding: [1, 0] }];
			mockOrchestratorInstance.embedNotes.mockResolvedValue({ embeddedNotes, errors: [] });
			await controller.embedAndBuildSemantic(notes);

			jest.clearAllMocks();
			mockGetSimilaritySettings.mockResolvedValue({ threshold: 0.7, topK: 3 });
			await controller.recompute();

			expect(mockOrchestratorInstance.embedNotes).not.toHaveBeenCalled();
			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalledWith(
				notes,
				embeddedNotes,
				0.7,
				3
			);
		});
	});
});
