import { AnalysisController } from './AnalysisController';
import { GraphBuilder } from './graph/GraphBuilder';
import { GraphCacheRepository } from '../data/Database/GraphCacheRepository';
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
jest.mock('../data/Database/GraphCacheRepository');

const MockGraphBuilder = GraphBuilder as jest.MockedClass<typeof GraphBuilder>;
const MockGraphCacheRepository = GraphCacheRepository as jest.MockedClass<typeof GraphCacheRepository>;
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

type EmbedResult = { embeddedNotes: unknown[]; errors: unknown[] };

/** A promise plus its own resolve function, for tests that need to control exactly when a mocked async call settles. */
function deferredEmbedResult(): {
	promise: Promise<EmbedResult>;
	resolve: (result: EmbedResult) => void;
} {
	let resolve!: (result: EmbedResult) => void;
	const promise = new Promise<EmbedResult>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe('AnalysisController', () => {
	let mockBuilder: jest.Mocked<GraphBuilder>;
	let mockGraphCache: jest.Mocked<GraphCacheRepository>;
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
		mockGraphCache = new MockGraphCacheRepository() as jest.Mocked<GraphCacheRepository>;
		mockGraphCache.saveGraph.mockResolvedValue(undefined);
		mockGraphCache.loadGraph.mockResolvedValue(null);
		controller = new AnalysisController(mockBuilder, mockGraphCache);

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

			expect(result?.usedAi).toBe(false);
			expect(result?.fallbackReason).toBeUndefined();
			expect(mockBuilder.build).toHaveBeenCalledWith(notes);
			expect(MockProviderResolver.resolveWithValidation).not.toHaveBeenCalled();
		});

		it('falls back to the structural graph when provider resolution throws, carrying the reason', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValue(
				new Error('joplin.ai is not available')
			);
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result?.usedAi).toBe(false);
			expect(result?.fallbackReason).toBe('joplin.ai is not available');
			expect(mockBuilder.build).toHaveBeenCalledWith(notes);
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('falls back to the structural graph when embedding produces no vectors, carrying the reason', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [],
				errors: [{ noteId: 'a', error: 'Note not yet indexed by Joplin AI.' }],
			});
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result?.usedAi).toBe(false);
			expect(result?.fallbackReason).toBe('Note not yet indexed by Joplin AI.');
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('builds the semantic graph on success', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const embeddedNotes = [{ note: note('a'), embedding: [1, 0] }];
			mockOrchestratorInstance.embedNotes.mockResolvedValue({ embeddedNotes, errors: [] });
			const notes = [note('a')];

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result?.usedAi).toBe(true);
			expect(mockOrchestratorInstance.setProvider).toHaveBeenCalledWith(fakeProvider);
			expect(mockOrchestratorInstance.setCache).toHaveBeenCalled();
			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalledWith(
				notes,
				embeddedNotes,
				0.5,
				5
			);
		});

		it('discards a run that resolves after a newer run has already started', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);

			const first = deferredEmbedResult();
			const second = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);

			const firstCall = controller.embedAndBuildSemantic([note('a')]);
			const secondCall = controller.embedAndBuildSemantic([note('b')]);

			// The newer (second) run finishes first...
			second.resolve({ embeddedNotes: [{ note: note('b'), embedding: [0, 1] }], errors: [] });
			const secondResult = await secondCall;

			// ...then the stale first run finishes after it and should be discarded.
			first.resolve({ embeddedNotes: [{ note: note('a'), embedding: [1, 0] }], errors: [] });
			const firstResult = await firstCall;

			expect(secondResult?.usedAi).toBe(true);
			expect(firstResult).toBeNull();
		});

		it('skips the structural fallback build entirely for a run superseded before its embed attempt resolves', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);

			let rejectStaleProvider!: (e: Error) => void;
			const staleProviderResolution = new Promise<never>((_, reject) => {
				rejectStaleProvider = reject;
			});
			MockProviderResolver.resolveWithValidation
				.mockReturnValueOnce(staleProviderResolution)
				.mockResolvedValueOnce(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('b'), embedding: [0, 1] }],
				errors: [],
			});

			const staleCall = controller.embedAndBuildSemantic([note('a')]);
			const newerResult = await controller.embedAndBuildSemantic([note('b')]);
			expect(newerResult?.usedAi).toBe(true);

			mockBuilder.build.mockClear();
			rejectStaleProvider(new Error('index not ready'));
			const staleResult = await staleCall;

			expect(staleResult).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
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

			expect(mockOrchestratorInstance.setOnProgress).toHaveBeenCalledTimes(1);
			const wiredProgress = mockOrchestratorInstance.setOnProgress.mock.calls[0][0];
			wiredProgress({ current: 1, total: 1 });
			expect(onProgress).toHaveBeenCalledWith({ current: 1, total: 1 });
		});

		it('stops forwarding progress from a run once a newer run has started', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);

			const first = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes
				.mockReturnValueOnce(first.promise)
				.mockResolvedValueOnce({
					embeddedNotes: [{ note: note('b'), embedding: [0, 1] }],
					errors: [],
				});

			const onProgressFirst = jest.fn();
			const firstCall = controller.embedAndBuildSemantic([note('a')], onProgressFirst);
			// Let the two internal awaits (isAiAnalysisEnabled, resolveWithValidation) settle
			// so the orchestrator is constructed and wired before we grab its callback.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			// Second call has no onProgress, so this is unambiguously the first run's wired callback.
			const firstRunProgress = mockOrchestratorInstance.setOnProgress.mock.calls[0][0];

			const secondCall = controller.embedAndBuildSemantic([note('b')]);
			await secondCall;

			// The stale first run reports progress after being superseded...
			firstRunProgress({ current: 1, total: 1 });
			// ...it should not reach the original caller.
			expect(onProgressFirst).not.toHaveBeenCalled();

			first.resolve({ embeddedNotes: [{ note: note('a'), embedding: [1, 0] }], errors: [] });
			await firstCall;
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

		it('cannot pair stale embedded vectors with a newer note list after a structural rebuild', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a')]);

			controller.buildStructural([note('a'), note('b')]);
			jest.clearAllMocks();

			const result = await controller.recompute();

			expect(result).toBeNull();
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('cannot pair stale embedded vectors with a newer note list after a re-embed fails', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a')]);

			MockProviderResolver.resolveWithValidation.mockRejectedValue(new Error('index not ready'));
			await controller.embedAndBuildSemantic([note('a'), note('b')]);
			jest.clearAllMocks();

			const result = await controller.recompute();

			expect(result).toBeNull();
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('does not let a concurrent recompute() pair fresh notes with stale vectors while a re-embed is still in flight', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const embeddedA = { note: note('a'), embedding: [1, 0] };
			mockOrchestratorInstance.embedNotes.mockResolvedValue({ embeddedNotes: [embeddedA], errors: [] });
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockGetSimilaritySettings.mockResolvedValue({ threshold: 0.5, topK: 5 });

			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValueOnce(deferred.promise);

			const inFlight = controller.embedAndBuildSemantic([note('a'), note('b')]);
			const recomputeResult = await controller.recompute();

			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalledWith([note('a')], [embeddedA], 0.5, 5);
			expect(recomputeResult).not.toBeNull();

			deferred.resolve({
				embeddedNotes: [embeddedA, { note: note('b'), embedding: [0, 1] }],
				errors: [],
			});
			expect(await inFlight).toBeNull();
		});
	});

	describe('hasNotes / getCurrentNotes', () => {
		it('has no notes and an empty list before anything is built or loaded', () => {
			expect(controller.hasNotes()).toBe(false);
			expect(controller.getCurrentNotes()).toEqual([]);
		});

		it('reflects the notes from the last buildStructural call', () => {
			const notes = [note('a'), note('b')];
			controller.buildStructural(notes);

			expect(controller.hasNotes()).toBe(true);
			expect(controller.getCurrentNotes()).toEqual(notes);
		});
	});

	describe('buildStructural cache persistence', () => {
		it('persists the built graph to the cache', () => {
			const notes = [note('a')];
			const graphData = { nodes: [], edges: [] };
			mockBuilder.build.mockReturnValue(graphData);

			controller.buildStructural(notes);

			expect(mockGraphCache.saveGraph).toHaveBeenCalledWith(notes, graphData);
		});
	});

	describe('loadFromCache', () => {
		it('returns null and touches no state when nothing has been cached', async () => {
			mockGraphCache.loadGraph.mockResolvedValue(null);

			const result = await controller.loadFromCache();

			expect(result).toBeNull();
			expect(controller.hasNotes()).toBe(false);
		});

		it('seeds notes and returns the cached graph on a hit', async () => {
			const notes = [note('a')];
			const graphData = { nodes: [], edges: [] };
			mockGraphCache.loadGraph.mockResolvedValue({ notes, graphData });

			const result = await controller.loadFromCache();

			expect(result).toBe(graphData);
			expect(controller.hasNotes()).toBe(true);
			expect(controller.getCurrentNotes()).toEqual(notes);
		});

		it('returns null instead of throwing when the cache read fails', async () => {
			mockGraphCache.loadGraph.mockRejectedValue(new Error('disk error'));

			const result = await controller.loadFromCache();

			expect(result).toBeNull();
		});
	});

	describe('applyDelta', () => {
		it('returns null when nothing has been loaded yet', async () => {
			const result = await controller.applyDelta([note('a')], []);
			expect(result).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
		});

		it('adds a new note to the current list and rebuilds', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const graphData = { nodes: [], edges: [] };
			mockBuilder.build.mockReturnValue(graphData);

			const result = await controller.applyDelta([note('b')], []);

			expect(result).toBe(graphData);
			expect(mockBuilder.build).toHaveBeenCalledWith(
				expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })])
			);
			expect(controller.getCurrentNotes()).toHaveLength(2);
		});

		it('removes a note from the current list and rebuilds', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			controller.buildStructural([note('a'), note('b')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(false);

			await controller.applyDelta([], ['a']);

			expect(controller.getCurrentNotes()).toEqual([note('b')]);
		});

		it('is a no-op when the upserted note is unchanged and nothing was removed', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();

			const result = await controller.applyDelta([note('a')], []);

			expect(result).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
		});

		it('rebuilds when an upserted note has a newer updated_time even with the same ID', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const changedNote = { ...note('a'), updated_time: 999 };

			const result = await controller.applyDelta([changedNote], []);

			expect(result).not.toBeNull();
			expect(controller.getCurrentNotes()[0].updated_time).toBe(999);
		});

		it('discards an in-flight embedAndBuildSemantic result that resolves after a delta lands, instead of clobbering the merge', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);

			const staleEmbed = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes
				.mockReturnValueOnce(staleEmbed.promise)
				.mockResolvedValueOnce({
					embeddedNotes: [
						{ note: note('a'), embedding: [1, 0] },
						{ note: note('b'), embedding: [0, 1] },
					],
					errors: [],
				});

			const staleCall = controller.embedAndBuildSemantic([note('a')]);
			const deltaResult = await controller.applyDelta([note('b')], []);
			expect(deltaResult).not.toBeNull();
			expect(controller.getCurrentNotes()).toHaveLength(2);

			staleEmbed.resolve({ embeddedNotes: [{ note: note('a'), embedding: [1, 0] }], errors: [] });
			const staleResult = await staleCall;

			expect(staleResult).toBeNull();
			expect(controller.getCurrentNotes()).toHaveLength(2);
		});

		it('flags a delta as retryable when a newer run supersedes it before it resolves, instead of silently dropping the edit', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);

			const staleEmbed = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValueOnce(staleEmbed.promise);

			const deltaCall = controller.applyDelta([note('b')], []);
			controller.buildStructural([note('a')]);

			staleEmbed.resolve({
				embeddedNotes: [
					{ note: note('a'), embedding: [1, 0] },
					{ note: note('b'), embedding: [0, 1] },
				],
				errors: [],
			});
			const deltaResult = await deltaCall;

			expect(deltaResult).toBeNull();
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(true);
		});

		it('detects a tag-only change even when updated_time is unchanged', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const original = { ...note('a'), tags: ['x'] };
			controller.buildStructural([original]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const retagged = { ...original, tags: ['y'] };

			const result = await controller.applyDelta([retagged], []);

			expect(result).not.toBeNull();
			expect(controller.getCurrentNotes()[0].tags).toEqual(['y']);
		});

		it('is a no-op when the same tags arrive in a different order', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			const original = { ...note('a'), tags: ['x', 'y'] };
			controller.buildStructural([original]);
			jest.clearAllMocks();

			const reordered = { ...original, tags: ['y', 'x'] };
			const result = await controller.applyDelta([reordered], []);

			expect(result).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
		});

		it('does not downgrade an existing semantic graph to structural when a re-embed fails transiently', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [],
				edges: [{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' } }],
			});
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();

			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValue(new Error('index not ready'));

			const result = await controller.applyDelta([note('b')], []);

			expect(result).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
			expect(controller.getCurrentNotes()).toHaveLength(1);
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(true);
		});

		it('does not flag a delta as retryable when it was a genuine no-op or plain removal', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			controller.buildStructural([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(false);

			await controller.applyDelta([note('a')], []);
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(false);

			await controller.applyDelta([], ['a']);
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(false);
		});

		it('clears the retryable flag once a later delta commits successfully', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [],
				edges: [{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' } }],
			});
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();

			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValueOnce(new Error('index not ready'));
			await controller.applyDelta([note('b')], []);
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(true);

			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [
					{ note: note('a'), embedding: [1, 0] },
					{ note: note('b'), embedding: [0, 1] },
				],
				errors: [],
			});
			await controller.applyDelta([note('b')], []);

			expect(controller.wasLastDeltaSkippedForRetry()).toBe(false);
		});

		it('retries cleanly on the next delta after a skipped downgrade, once AI recovers', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [],
				edges: [{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' } }],
			});
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();

			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValueOnce(new Error('index not ready'));
			const skipped = await controller.applyDelta([note('b')], []);
			expect(skipped).toBeNull();
			expect(controller.getCurrentNotes()).toHaveLength(1);

			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [
					{ note: note('a'), embedding: [1, 0] },
					{ note: note('b'), embedding: [0, 1] },
				],
				errors: [],
			});

			const retried = await controller.applyDelta([note('b')], []);

			expect(retried).not.toBeNull();
			expect(controller.getCurrentNotes()).toHaveLength(2);
		});

		it('downgrades to structural when AI is simply off, instead of mistaking that for a failed re-embed', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [],
				edges: [{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' } }],
			});
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();

			mockIsAiAnalysisEnabled.mockResolvedValue(false);
			mockBuilder.build.mockReturnValue({ nodes: [], edges: [] });

			const result = await controller.applyDelta([note('b')], []);

			expect(result).not.toBeNull();
			expect(controller.getCurrentNotes()).toHaveLength(2);
			expect(controller.wasLastDeltaSkippedForRetry()).toBe(false);
			expect(MockProviderResolver.resolveWithValidation).not.toHaveBeenCalled();
		});
	});

	describe('getLastDiff', () => {
		it('is null before anything has been built', () => {
			expect(controller.getLastDiff()).toBeNull();
		});

		it('treats the first build as entirely new (no previous graph to diff against)', () => {
			const graphData = {
				nodes: [{ data: { id: 'a', label: 'a', noteId: 'a', degree: 0, community: 0, size: 1 } }],
				edges: [],
			};
			mockBuilder.build.mockReturnValue(graphData);

			controller.buildStructural([note('a')]);

			expect(controller.getLastDiff()).toEqual({
				upsertedNodes: graphData.nodes,
				upsertedEdges: [],
				removedNodeIds: [],
				removedEdgeIds: [],
			});
		});

		it('reports only what changed between two builds', () => {
			const nodeA = { data: { id: 'a', label: 'a', noteId: 'a', degree: 0, community: 0, size: 1 } };
			const nodeB = { data: { id: 'b', label: 'b', noteId: 'b', degree: 0, community: 0, size: 1 } };
			mockBuilder.build.mockReturnValueOnce({ nodes: [nodeA], edges: [] });
			controller.buildStructural([note('a')]);

			mockBuilder.build.mockReturnValueOnce({ nodes: [nodeA, nodeB], edges: [] });
			controller.buildStructural([note('a'), note('b')]);

			expect(controller.getLastDiff()).toEqual({
				upsertedNodes: [nodeB],
				upsertedEdges: [],
				removedNodeIds: [],
				removedEdgeIds: [],
			});
		});
	});
});
