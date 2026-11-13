import { AnalysisController } from './AnalysisController';
import { GraphBuilder } from './graph/GraphBuilder';
import { GraphCacheRepository } from '../data/Database/GraphCacheRepository';
import { VectorRepository } from '../data/Database/VectorRepository';
import { ProviderResolver } from './embeddings/ProviderResolver';
import { EmbeddingOrchestrator } from './embeddings/Orchestrator';
import { LLMEnricher } from './llm/LLMEnricher';
import {
	isAiAnalysisEnabled,
	isLlmEnrichmentEnabled,
	getSimilaritySettings,
} from './settings/GraphSettings';
import { Note } from '../data/Types';
import { EmbeddingProvider } from './embeddings/Types';

jest.mock('./graph/GraphBuilder');
jest.mock('./embeddings/ProviderResolver');
jest.mock('./embeddings/Orchestrator');
jest.mock('./llm/LLMEnricher');
jest.mock('./settings/GraphSettings');
jest.mock('../data/Database/VectorRepository', () => ({
	VectorRepository: jest.fn(() => ({
		getMany: jest.fn().mockResolvedValue(new Map()),
		saveMany: jest.fn().mockResolvedValue(undefined),
		removeMany: jest.fn().mockResolvedValue(undefined),
		pruneExcept: jest.fn().mockResolvedValue(undefined),
	})),
}));
jest.mock('../data/Database/GraphCacheRepository');

const MockGraphBuilder = GraphBuilder as jest.MockedClass<typeof GraphBuilder>;
const MockGraphCacheRepository = GraphCacheRepository as jest.MockedClass<
	typeof GraphCacheRepository
>;
const MockProviderResolver = ProviderResolver as jest.Mocked<typeof ProviderResolver>;
const MockOrchestrator = EmbeddingOrchestrator as jest.MockedClass<typeof EmbeddingOrchestrator>;
const MockLLMEnricher = LLMEnricher as jest.MockedClass<typeof LLMEnricher>;
const mockIsAiAnalysisEnabled = isAiAnalysisEnabled as jest.Mock;
const mockIsLlmEnrichmentEnabled = isLlmEnrichmentEnabled as jest.Mock;
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
	let mockEnricher: jest.Mocked<LLMEnricher>;
	let mockVectorStore: {
		getMany: jest.Mock;
		saveMany: jest.Mock;
		removeMany: jest.Mock;
		pruneExcept: jest.Mock;
	};
	let controller: AnalysisController;
	let mockOrchestratorInstance: {
		setProvider: jest.Mock;
		setCache: jest.Mock;
		setOnProgress: jest.Mock;
		embedNotes: jest.Mock;
		cancel: jest.Mock;
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
		mockGraphCache.saveEnrichments.mockResolvedValue(undefined);
		mockGraphCache.loadEnrichments.mockResolvedValue([]);
		mockEnricher = new MockLLMEnricher() as jest.Mocked<LLMEnricher>;
		mockEnricher.replayCached.mockReturnValue({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });
		mockEnricher.takeNewEnrichments.mockReturnValue({ nodes: [], edges: [] });
		mockIsLlmEnrichmentEnabled.mockResolvedValue(false);
		mockBuilder.rebuildStructure.mockReturnValue({ nodes: [], edges: [] });
		mockGraphCache.pruneEnrichments.mockResolvedValue(undefined);
		mockVectorStore = {
			getMany: jest.fn().mockResolvedValue(new Map()),
			saveMany: jest.fn().mockResolvedValue(undefined),
			removeMany: jest.fn().mockResolvedValue(undefined),
			pruneExcept: jest.fn().mockResolvedValue(undefined),
		};
		controller = new AnalysisController(
			mockBuilder,
			mockGraphCache,
			mockEnricher,
			mockVectorStore as unknown as VectorRepository
		);

		mockOrchestratorInstance = {
			setProvider: jest.fn(),
			setCache: jest.fn(),
			setOnProgress: jest.fn(),
			embedNotes: jest.fn().mockResolvedValue({ embeddedNotes: [], errors: [] }),
			cancel: jest.fn(),
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

		it('remembers the community numbers of the graph it commits, so later builds stay on them', () => {
			const graphData = { nodes: [], edges: [] };
			mockBuilder.build.mockReturnValue(graphData);

			controller.buildStructural([note('a')]);

			expect(mockBuilder.rememberCommunities).toHaveBeenCalledWith(graphData);
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
				5,
				expect.any(Function)
			);
		});

		it('keeps a cached semantic graph instead of downgrading it when a later call fails transiently (e.g. AI-toggle settings churn)', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [],
				edges: [
					{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' } },
				],
			});
			const notes = [note('a')];
			await controller.embedAndBuildSemantic(notes);
			jest.clearAllMocks();

			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockRejectedValue(
				new Error('index not ready')
			);

			const result = await controller.embedAndBuildSemantic(notes);

			expect(result).toBeNull();
			expect(mockBuilder.build).not.toHaveBeenCalled();
			expect(controller.getLastGraphData()?.edges).toHaveLength(1);
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
				3,
				expect.any(Function)
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

			MockProviderResolver.resolveWithValidation.mockRejectedValue(
				new Error('index not ready')
			);
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
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [embeddedA],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a')]);
			jest.clearAllMocks();
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockGetSimilaritySettings.mockResolvedValue({ threshold: 0.5, topK: 5 });

			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValueOnce(deferred.promise);

			const inFlight = controller.embedAndBuildSemantic([note('a'), note('b')]);
			const recomputeResult = await controller.recompute();

			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalledWith([note('a')], [embeddedA], 0.5, 5, expect.any(Function));
			expect(recomputeResult).not.toBeNull();

			deferred.resolve({
				embeddedNotes: [embeddedA, { note: note('b'), embedding: [0, 1] }],
				errors: [],
			});
			expect(await inFlight).toBeNull();
		});
	});

	describe('LLM enrichment', () => {
		const semanticGraphData = {
			nodes: [
				{ data: { id: 'a', label: 'a', noteId: 'a', degree: 1, community: 0, size: 5 } },
				{ data: { id: 'b', label: 'b', noteId: 'b', degree: 1, community: 0, size: 5 } },
			],
			edges: [
				{
					data: {
						id: 'a::b::semantic',
						source: 'a',
						target: 'b',
						type: 'semantic' as const,
					},
				},
			],
		};

		beforeEach(() => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue(semanticGraphData);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map(),
				edgeEnrichments: new Map(),
			});
		});

		it('does not call the enrichment service when the setting is off', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(false);
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			expect(mockEnricher.enrich).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});

		it('removes category and relationship labels on recompute() after the setting is turned off', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { category: 'Gardening' }]]),
				edgeEnrichments: new Map([
					['a::b::semantic', { relationshipLabel: 'inspired by' }],
				]),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);
			await controller.enrichCurrentGraph();

			mockIsLlmEnrichmentEnabled.mockResolvedValue(false);
			const result = await controller.recompute();

			expect(result?.nodes.find((n) => n.data.id === 'a')?.data.category).toBeUndefined();
			expect(result?.edges[0].data.relationshipLabel).toBeUndefined();
		});

		it('merges category, relationship label and a clamped size adjustment into the graph', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([
					['a', { category: 'Gardening', centralityAdjustment: 2 }],
				]),
				edgeEnrichments: new Map([
					['a::b::semantic', { relationshipLabel: 'inspired by' }],
				]),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			const nodeA = result?.nodes.find((n) => n.data.id === 'a');
			expect(nodeA?.data.category).toBe('Gardening');
			expect(nodeA?.data.size).toBe(7);
			expect(result?.edges[0].data.relationshipLabel).toBe('inspired by');
		});

		it('does not add a category key when the enrichment only carries a centrality adjustment', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { centralityAdjustment: 2 }]]),
				edgeEnrichments: new Map(),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			const nodeA = result?.nodes.find((n) => n.data.id === 'a');
			expect(nodeA?.data.size).toBe(7);
			expect('category' in (nodeA?.data ?? {})).toBe(false);
		});

		it('clamps an adjusted size to the 1-10 range on the upper bound', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { centralityAdjustment: 20 }]]),
				edgeEnrichments: new Map(),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			expect(result?.nodes.find((n) => n.data.id === 'a')?.data.size).toBe(10);
		});

		it('clamps an adjusted size to the 1-10 range on the lower bound', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { centralityAdjustment: -20 }]]),
				edgeEnrichments: new Map(),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			expect(result?.nodes.find((n) => n.data.id === 'a')?.data.size).toBe(1);
		});

		it('never throws when the enrichment service itself fails, leaving the Pass A graph committed', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.enrich.mockRejectedValue(new Error('unexpected enrichment failure'));
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.enrichCurrentGraph();

			expect(result).toBeNull();
			expect(controller.getLastGraphData()).toEqual(semanticGraphData);
		});

		it('skips a semantic edge whose endpoint note is missing from the current note set, without throwing', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: semanticGraphData.nodes,
				edges: [
					{
						data: {
							id: 'a::c::semantic',
							source: 'a',
							target: 'c',
							type: 'semantic' as const,
						},
					},
				],
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			await controller.enrichCurrentGraph();

			expect(mockEnricher.enrich).toHaveBeenCalledWith(
				{ nodes: new Map(), edges: [] },
				expect.any(Function),
				undefined
			);
			expect(controller.getLastGraphData()?.edges[0].data.id).toBe('a::c::semantic');
		});

		it('sends the full note title and body, not the graph node label or a pre-truncated body', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			const longTitle = 'A '.repeat(50);
			const longBody = 'x'.repeat(400);
			const notes = [
				{ ...note('a'), title: longTitle, body: longBody },
				{ ...note('b'), title: 'b', body: '' },
			];
			await controller.embedAndBuildSemantic(notes);

			await controller.enrichCurrentGraph();

			const input = mockEnricher.enrich.mock.calls[0][0];
			expect(input.nodes.get('a')).toEqual({
				title: longTitle,
				body: longBody,
				updatedTime: notes[0].updated_time,
			});
		});

		it('coerces a non-string note body to an empty string, since the raw Joplin API does not guarantee its declared type', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			const notes = [
				{ ...note('a'), body: null as unknown as string },
				{ ...note('b'), body: '' },
			];
			await controller.embedAndBuildSemantic(notes);

			await controller.enrichCurrentGraph();

			const input = mockEnricher.enrich.mock.calls[0][0];
			expect(input.nodes.get('a')?.body).toBe('');
		});

		it('only sends semantic edges to the enrichment service, not link/tag edges', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: semanticGraphData.nodes,
				edges: [
					...semanticGraphData.edges,
					{ data: { id: 'a::b::link', source: 'a', target: 'b', type: 'link' as const } },
				],
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			await controller.enrichCurrentGraph();

			const input = mockEnricher.enrich.mock.calls[0][0];
			expect(input.edges).toEqual([
				{
					id: 'a::b::semantic',
					source: 'a',
					target: 'b',
					updatedTime: note('a').updated_time,
				},
			]);
		});

		it('keys an edge enrichment cache entry on the newer of its two endpoints, not the source alone', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			const notes = [
				{ ...note('a'), updated_time: 100 },
				{ ...note('b'), updated_time: 200 },
			];
			await controller.embedAndBuildSemantic(notes);

			await controller.enrichCurrentGraph();

			const input = mockEnricher.enrich.mock.calls[0][0];
			expect(input.edges).toEqual([
				{ id: 'a::b::semantic', source: 'a', target: 'b', updatedTime: 200 },
			]);
		});

		it('passes an isStale predicate that reflects a newer run superseding this one', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			await controller.enrichCurrentGraph();

			const isStale = mockEnricher.enrich.mock.calls[0][1];
			expect(isStale()).toBe(false);
			controller.buildStructural([note('a')]);
			expect(isStale()).toBe(true);
		});

		it('runs enrichment again on recompute(), not just on the initial embed', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			await controller.embedAndBuildSemantic([note('a'), note('b')]);
			await controller.enrichCurrentGraph();
			mockEnricher.enrich.mockClear();
			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { category: 'Gardening' }]]),
				edgeEnrichments: new Map(),
			});

			await controller.recompute();
			const result = await controller.enrichCurrentGraph();

			expect(mockEnricher.enrich).toHaveBeenCalledTimes(1);
			expect(result?.nodes.find((n) => n.data.id === 'a')?.data.category).toBe('Gardening');
		});

		it('re-applies cached categories and labels on recompute(), so labels are never stripped by a rebuild', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			mockEnricher.replayCached.mockReturnValue({
				nodeEnrichments: new Map([['a', { category: 'Gardening' }]]),
				edgeEnrichments: new Map([['a::b::semantic', { relationshipLabel: 'links to' }]]),
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			const result = await controller.recompute();

			expect(result?.nodes.find((n) => n.data.id === 'a')?.data.category).toBe('Gardening');
			expect(result?.edges[0].data.relationshipLabel).toBe('links to');
		});

		it('forwards an onProgress callback from enrichCurrentGraph through to the enrichment service', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			const onEnrichmentProgress = jest.fn();
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			await controller.enrichCurrentGraph(onEnrichmentProgress);

			const forwarded = mockEnricher.enrich.mock.calls[0][2]!;
			forwarded({ current: 1, total: 3 });
			expect(onEnrichmentProgress).toHaveBeenCalledWith({ current: 1, total: 3 });
		});

		it('stops forwarding enrichment progress once a newer run supersedes it', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			const onEnrichmentProgress = jest.fn();
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			await controller.enrichCurrentGraph(onEnrichmentProgress);
			const forwarded = mockEnricher.enrich.mock.calls[0][2]!;

			controller.buildStructural([note('a')]);
			forwarded({ current: 1, total: 1 });

			expect(onEnrichmentProgress).not.toHaveBeenCalled();
		});

		it('is a no-op when there is no graph yet', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);

			const result = await controller.enrichCurrentGraph();

			expect(mockEnricher.enrich).not.toHaveBeenCalled();
			expect(result).toBeNull();
		});

		it('waits for an in-flight enrichment to finish, then runs against the latest graph', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			await controller.embedAndBuildSemantic([note('a'), note('b')]);

			let resolveFirst!: (result: Awaited<ReturnType<typeof mockEnricher.enrich>>) => void;
			mockEnricher.enrich
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveFirst = resolve;
						})
				)
				.mockResolvedValueOnce({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });

			const first = controller.enrichCurrentGraph();
			await new Promise((resolve) => setImmediate(resolve));

			const secondPromise = controller.enrichCurrentGraph();

			resolveFirst({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });
			await first;

			const second = await secondPromise;
			expect(second).toBeNull();
			expect(mockEnricher.enrich).toHaveBeenCalledTimes(2);
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

	describe('hasEmbeddedNotes', () => {
		it('is false before anything is built or loaded', () => {
			expect(controller.hasEmbeddedNotes()).toBe(false);
		});

		it('stays false after loadFromCache, since the cached blob carries no embeddings', async () => {
			const notes = [note('a')];
			const graphData = { nodes: [], edges: [] };
			mockGraphCache.loadGraph.mockResolvedValue({ notes, graphData });

			await controller.loadFromCache();

			expect(controller.hasEmbeddedNotes()).toBe(false);
		});

		it('stays false after buildStructural, since no embedding ran', () => {
			controller.buildStructural([note('a')]);

			expect(controller.hasEmbeddedNotes()).toBe(false);
		});

		it('becomes true after embedAndBuildSemantic embeds successfully', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});

			await controller.embedAndBuildSemantic([note('a')]);

			expect(controller.hasEmbeddedNotes()).toBe(true);
		});
	});

	describe('cancelCurrentRun', () => {
		it('is a no-op when nothing is in flight', () => {
			const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			expect(() => controller.cancelCurrentRun()).not.toThrow();

			expect(infoSpy).not.toHaveBeenCalled();
			infoSpy.mockRestore();
		});

		it('cancels the orchestrator driving an in-flight Pass A embedding fetch, logging under "AI analysis"', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			const inFlight = controller.embedAndBuildSemantic([note('a')]);
			// Let the pending isAiAnalysisEnabled()/resolveWithValidation() microtasks
			// resolve so tryEmbed reaches orchestrator.embedNotes() and sets
			// currentOrchestrator before cancelCurrentRun() is called.
			await new Promise((resolve) => setImmediate(resolve));
			controller.cancelCurrentRun();

			expect(mockOrchestratorInstance.cancel).toHaveBeenCalledTimes(1);
			expect(infoSpy).toHaveBeenCalledWith('AI analysis: cancelled by user.');

			deferred.resolve({ embeddedNotes: [], errors: [] });
			await inFlight;
			infoSpy.mockRestore();
		});

		it('no longer reaches the orchestrator once the run has finished', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);

			await controller.embedAndBuildSemantic([note('a')]);
			controller.cancelCurrentRun();

			expect(mockOrchestratorInstance.cancel).not.toHaveBeenCalled();
		});

		it('stops an in-flight Pass B LLM enrichment run, discarding its result, logging under "LLM enrichment"', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [
					{
						data: {
							id: 'a',
							label: 'a',
							noteId: 'a',
							degree: 0,
							community: 0,
							size: 5,
						},
					},
				],
				edges: [],
			});
			// Pass A completes and commits first, same as production: Pass B only
			// starts against an already-committed graph.
			await controller.embedAndBuildSemantic([note('a')]);

			let capturedIsStale: (() => boolean) | undefined;
			let resolveEnrich!: (result: Awaited<ReturnType<typeof mockEnricher.enrich>>) => void;
			mockEnricher.enrich.mockImplementation((_input, isStale) => {
				capturedIsStale = isStale;
				return new Promise((resolve) => {
					resolveEnrich = resolve;
				});
			});
			const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

			const inFlight = controller.enrichCurrentGraph();
			await new Promise((resolve) => setImmediate(resolve));
			expect(capturedIsStale).toBeDefined();
			expect(capturedIsStale!()).toBe(false);

			controller.cancelCurrentRun();
			expect(capturedIsStale!()).toBe(true);
			expect(infoSpy).toHaveBeenCalledWith('LLM enrichment: cancelled by user.');

			resolveEnrich({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });
			const result = await inFlight;

			expect(result).toBeNull();
			infoSpy.mockRestore();
		});

		it('honors a cancel that lands between Pass A committing and Pass B starting', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [
					{
						data: {
							id: 'a',
							label: 'a',
							noteId: 'a',
							degree: 0,
							community: 0,
							size: 5,
						},
					},
				],
				edges: [],
			});
			await controller.embedAndBuildSemantic([note('a')]);

			controller.cancelCurrentRun();
			const result = await controller.enrichCurrentGraph();

			expect(result).toBeNull();
			expect(mockEnricher.enrich).not.toHaveBeenCalled();
		});

		it('allows enrichment to proceed again once clearCancellation() clears a prior cancel', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockResolvedValue({
				nodes: [{ data: { id: 'a', label: 'a', noteId: 'a', degree: 0, community: 0, size: 5 } }],
				edges: [],
			});
			mockEnricher.enrich.mockResolvedValue({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });
			await controller.embedAndBuildSemantic([note('a')]);

			controller.cancelCurrentRun();
			controller.clearCancellation();
			await controller.enrichCurrentGraph();

			expect(mockEnricher.enrich).toHaveBeenCalled();
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

		it('does not save the graph while persistence is disabled', () => {
			controller.setCachePersistenceEnabled(false);

			controller.buildStructural([note('a')]);

			expect(mockGraphCache.saveGraph).not.toHaveBeenCalled();
		});

		it('still commits the graph in memory while persistence is disabled', () => {
			const graphData = { nodes: [], edges: [] };
			mockBuilder.build.mockReturnValue(graphData);
			controller.setCachePersistenceEnabled(false);

			controller.buildStructural([note('a')]);

			expect(controller.getLastGraphData()).toBe(graphData);
		});

		it('saves again once persistence is re-enabled', () => {
			const notes = [note('a')];
			const graphData = { nodes: [], edges: [] };
			mockBuilder.build.mockReturnValue(graphData);
			controller.setCachePersistenceEnabled(false);
			controller.buildStructural([note('old')]);

			controller.setCachePersistenceEnabled(true);
			controller.buildStructural(notes);

			expect(mockGraphCache.saveGraph).toHaveBeenCalledTimes(1);
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

		it('seeds the enrichment cache from labels already sitting in the cached graph', async () => {
			const notes = [note('a'), note('b')];
			const graphData = {
				nodes: [
					{
						data: {
							id: 'a',
							label: 'a',
							noteId: 'a',
							degree: 1,
							community: 0,
							size: 1,
							category: 'Cat A',
						},
					},
					{
						data: {
							id: 'b',
							label: 'b',
							noteId: 'b',
							degree: 1,
							community: 0,
							size: 1,
						},
					},
				],
				edges: [
					{
						data: {
							id: 'a::b::semantic',
							source: 'a',
							target: 'b',
							type: 'semantic' as const,
							relationshipLabel: 'links to',
						},
					},
				],
			};
			mockGraphCache.loadGraph.mockResolvedValue({ notes, graphData });

			await controller.loadFromCache();

			expect(mockEnricher.seedCache).toHaveBeenCalledWith(
				[{ id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } }],
				[
					{
						id: 'a::b::semantic',
						updatedTime: 1,
						enrichment: { relationshipLabel: 'links to' },
					},
				]
			);
		});

		it('does not seed an edge that is not semantic or is missing a relationship label', async () => {
			const notes = [note('a'), note('b')];
			const graphData = {
				nodes: [],
				edges: [
					{
						data: {
							id: 'a::b::link',
							source: 'a',
							target: 'b',
							type: 'link' as const,
							relationshipLabel: 'ignored',
						},
					},
					{
						data: {
							id: 'a::b::semantic',
							source: 'a',
							target: 'b',
							type: 'semantic' as const,
						},
					},
				],
			};
			mockGraphCache.loadGraph.mockResolvedValue({ notes, graphData });

			await controller.loadFromCache();

			expect(mockEnricher.seedCache).toHaveBeenCalledWith([], []);
		});
	});

	describe('seedEnrichmentFromStore', () => {
		it('seeds node and edge enrichment from the persisted table', async () => {
			mockGraphCache.loadEnrichments.mockResolvedValue([
				{ kind: 'node', id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } },
				{
					kind: 'edge',
					id: 'a::b::semantic',
					updatedTime: 2,
					enrichment: { relationshipLabel: 'links' },
				},
			]);

			await controller.seedEnrichmentFromStore();

			expect(mockEnricher.seedCache).toHaveBeenCalledWith(
				[{ id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } }],
				[
					{
						id: 'a::b::semantic',
						updatedTime: 2,
						enrichment: { relationshipLabel: 'links' },
					},
				]
			);
		});

		it('swallows a read failure instead of throwing', async () => {
			mockGraphCache.loadEnrichments.mockRejectedValue(new Error('disk error'));

			await expect(controller.seedEnrichmentFromStore()).resolves.toBeUndefined();
		});
	});

	describe('enrichment persistence', () => {
		it('does not re-persist enrichment already on a committed graph', () => {
			mockBuilder.build.mockReturnValue({
				nodes: [
					{
						data: {
							id: 'a',
							label: 'a',
							noteId: 'a',
							degree: 1,
							community: 0,
							size: 1,
							category: 'Cat A',
						},
					},
				],
				edges: [
					{
						data: {
							id: 'a::b::semantic',
							source: 'a',
							target: 'b',
							type: 'semantic' as const,
							relationshipLabel: 'links',
						},
					},
				],
			});

			controller.buildStructural([note('a'), note('b')]);

			expect(mockGraphCache.saveEnrichments).not.toHaveBeenCalled();
		});

		it('persists only the enrichments newly produced by the LLM pass', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			controller.buildStructural([note('a'), note('b')]);

			mockEnricher.enrich.mockResolvedValue({
				nodeEnrichments: new Map([['a', { category: 'Cat A' }]]),
				edgeEnrichments: new Map([['a::b::semantic', { relationshipLabel: 'links' }]]),
			});
			mockEnricher.takeNewEnrichments.mockReturnValue({
				nodes: [{ id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } }],
				edges: [
					{
						id: 'a::b::semantic',
						updatedTime: 1,
						enrichment: { relationshipLabel: 'links' },
					},
				],
			});

			await controller.enrichCurrentGraph();

			expect(mockGraphCache.saveEnrichments).toHaveBeenCalledWith([
				{ kind: 'node', id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } },
				{
					kind: 'edge',
					id: 'a::b::semantic',
					updatedTime: 1,
					enrichment: { relationshipLabel: 'links' },
				},
			]);
		});

		it('does not write the enrichment table when the LLM pass produced nothing new', async () => {
			mockIsLlmEnrichmentEnabled.mockResolvedValue(true);
			controller.buildStructural([note('a'), note('b')]);

			mockEnricher.enrich.mockResolvedValue({ nodeEnrichments: new Map(), edgeEnrichments: new Map() });
			mockEnricher.takeNewEnrichments.mockReturnValue({ nodes: [], edges: [] });

			await controller.enrichCurrentGraph();

			expect(mockGraphCache.saveEnrichments).not.toHaveBeenCalled();
		});
	});

	describe('migrateCachedEnrichment', () => {
		it('persists enrichment already on the cached graph before it is discarded', async () => {
			const notes = [note('a'), note('b')];
			const graphData = {
				nodes: [
					{
						data: {
							id: 'a',
							label: 'a',
							noteId: 'a',
							degree: 1,
							community: 0,
							size: 1,
							category: 'Cat A',
						},
					},
				],
				edges: [
					{
						data: {
							id: 'a::b::semantic',
							source: 'a',
							target: 'b',
							type: 'semantic' as const,
							relationshipLabel: 'links',
						},
					},
				],
			};
			mockGraphCache.loadGraph.mockResolvedValue({ notes, graphData });

			await controller.migrateCachedEnrichment();

			expect(mockGraphCache.saveEnrichments).toHaveBeenCalledWith([
				{ kind: 'node', id: 'a', updatedTime: 1, enrichment: { category: 'Cat A' } },
				{
					kind: 'edge',
					id: 'a::b::semantic',
					updatedTime: 1,
					enrichment: { relationshipLabel: 'links' },
				},
			]);
		});

		it('does nothing when nothing has been cached', async () => {
			mockGraphCache.loadGraph.mockResolvedValue(null);

			await controller.migrateCachedEnrichment();

			expect(mockGraphCache.saveEnrichments).not.toHaveBeenCalled();
		});
	});


	describe('applyDelta', () => {
		const edited = (id: string, overrides: Partial<Note>): Note => ({ ...note(id), ...overrides });

		it('returns null when nothing has been loaded yet', async () => {
			expect(await controller.applyDelta([note('a')], [])).toBeNull();
			expect(mockBuilder.rebuildStructure).not.toHaveBeenCalled();
		});

		it('returns null and rebuilds nothing when the note is unchanged', async () => {
			controller.buildStructural([note('a')]);

			expect(await controller.applyDelta([note('a')], [])).toBeNull();
			expect(mockBuilder.rebuildStructure).not.toHaveBeenCalled();
		});

		it('does not rebuild for a text-only edit, but remembers the note', async () => {
			controller.buildStructural([note('a')]);
			mockGraphCache.saveGraph.mockClear();

			const result = await controller.applyDelta([edited('a', { updated_time: 2, body: 'new' })], []);

			expect(result).toBeNull();
			expect(mockBuilder.rebuildStructure).not.toHaveBeenCalled();
			expect(mockGraphCache.saveGraph).not.toHaveBeenCalled();
			expect(controller.getCurrentNotes()[0].updated_time).toBe(2);
		});

		it.each([
			['title', { title: 'new title' }],
			['notebook', { parent_id: 'other' }],
			['tags', { tags: ['new'] }],
			['links', { links: ['b'] }],
		])('rebuilds when the %s changes', async (_name, overrides) => {
			const graphData = { nodes: [], edges: [] };
			mockBuilder.rebuildStructure.mockReturnValue(graphData);
			controller.buildStructural([note('a')]);

			const result = await controller.applyDelta([edited('a', overrides)], []);

			expect(result).toBe(graphData);
			expect(controller.getLastGraphData()).toBe(graphData);
		});

		it('treats tags in a different order as unchanged', async () => {
			controller.buildStructural([edited('a', { tags: ['x', 'y'] })]);

			const result = await controller.applyDelta([edited('a', { tags: ['y', 'x'] })], []);

			expect(result).toBeNull();
		});

		it('rebuilds when a note is added or removed', async () => {
			controller.buildStructural([note('a'), note('b')]);

			await controller.applyDelta([note('c')], ['a']);

			expect(mockBuilder.rebuildStructure).toHaveBeenCalledTimes(1);
			expect(controller.getCurrentNotes().map((n) => n.id)).toEqual(['b', 'c']);
		});

		it('never fetches embeddings or calls the AI provider, however large the change', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			controller.buildStructural([note('a')]);

			await controller.applyDelta([edited('a', { title: 'new' }), note('b')], []);

			expect(MockProviderResolver.resolveWithValidation).not.toHaveBeenCalled();
			expect(mockOrchestratorInstance.embedNotes).not.toHaveBeenCalled();
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('passes the current graph along, so its semantic edges survive', async () => {
			const graph = {
				nodes: [],
				edges: [{ data: { id: 'a::b::semantic', source: 'a', target: 'b', type: 'semantic' as const } }],
			};
			mockBuilder.build.mockReturnValue(graph);
			controller.buildStructural([note('a'), note('b')]);

			await controller.applyDelta([note('c')], []);

			expect(mockBuilder.rebuildStructure).toHaveBeenCalledWith(expect.anything(), graph);
		});

		it('forgets the stored vector of a removed note', async () => {
			controller.buildStructural([note('a'), note('b')]);

			await controller.applyDelta([], ['a']);

			expect(mockVectorStore.removeMany).toHaveBeenCalledWith(['a']);
		});

		it('is not lost when it lands during a long semantic run', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			const notes = [note('a')];
			controller.buildStructural(notes);

			const run = controller.embedAndBuildSemantic(notes);
			await new Promise((resolve) => setImmediate(resolve));
			await controller.applyDelta([note('b')], []);
			deferred.resolve({ embeddedNotes: [{ note: note('a'), embedding: [1, 0] }], errors: [] });
			const result = await run;

			expect(result?.usedAi).toBe(true);
			const builtWith = mockBuilder.buildWithSimilarity.mock.calls[0][0] as Note[];
			expect(builtWith.map((n) => n.id)).toEqual(['a', 'b']);
			expect(controller.getCurrentNotes().map((n) => n.id)).toEqual(['a', 'b']);
		});

		it('does not cancel a semantic run that is in flight', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			const notes = [note('a')];
			controller.buildStructural(notes);

			const run = controller.embedAndBuildSemantic(notes);
			await new Promise((resolve) => setImmediate(resolve));
			await controller.applyDelta([edited('a', { title: 'new' })], []);
			deferred.resolve({ embeddedNotes: [{ note: note('a'), embedding: [1, 0] }], errors: [] });

			await expect(run).resolves.not.toBeNull();
		});

		it('keeps an edit that lands while similarity is being computed', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			let finishSimilarity: (graph: { nodes: never[]; edges: never[] }) => void = () => undefined;
			mockBuilder.buildWithSimilarity.mockReturnValue(
				new Promise((resolve) => {
					finishSimilarity = resolve;
				})
			);
			const notes = [note('a')];
			controller.buildStructural(notes);

			const run = controller.embedAndBuildSemantic(notes);
			await new Promise((resolve) => setImmediate(resolve));
			await controller.applyDelta([note('b')], []);
			mockBuilder.rebuildStructure.mockClear();
			finishSimilarity({ nodes: [], edges: [] });
			await run;

			const rebuiltWith = mockBuilder.rebuildStructure.mock.calls[0][0] as Note[];
			expect(rebuiltWith.map((n) => n.id)).toEqual(['a', 'b']);
		});
	});

	describe('after loading from the cache', () => {
		it('carries on the community numbers of the cached graph', async () => {
			const graphData = { nodes: [], edges: [] };
			mockGraphCache.loadGraph.mockResolvedValue({ notes: [note('a')], graphData });

			await controller.loadFromCache();

			expect(mockBuilder.rememberCommunities).toHaveBeenCalledWith(graphData);
		});
	});

	describe('recompute during an edit', () => {
		it('keeps an edit that lands while similarity is being computed', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a')]);

			let finishSimilarity: (graph: { nodes: never[]; edges: never[] }) => void = () => undefined;
			mockBuilder.buildWithSimilarity.mockReturnValue(
				new Promise((resolve) => {
					finishSimilarity = resolve;
				})
			);
			const merged = { nodes: [], edges: [] };
			const run = controller.recompute();
			await new Promise((resolve) => setImmediate(resolve));
			await controller.applyDelta([note('b')], []);
			mockBuilder.rebuildStructure.mockClear();
			mockBuilder.rebuildStructure.mockReturnValue(merged);
			finishSimilarity({ nodes: [], edges: [] });

			await expect(run).resolves.toBe(merged);

			const rebuiltWith = mockBuilder.rebuildStructure.mock.calls[0][0] as Note[];
			expect(rebuiltWith.map((n) => n.id)).toEqual(['a', 'b']);
			expect(controller.getLastGraphData()).toBe(merged);
		});
	});

	describe('markOutdatedVectorsStale', () => {
		async function startWithVectorFor(id: string, notes: Note[]): Promise<void> {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note(id), embedding: [1, 0] }],
				errors: [],
			});
			await controller.embedAndBuildSemantic(notes);
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockReset();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map());
		}

		it('marks an in-scope note with no vector, and nothing else', async () => {
			await startWithVectorFor('a', [note('a'), note('b')]);

			await controller.markOutdatedVectorsStale(['a', 'b', 'out-of-scope']);
			await controller.refreshStaleVectors();

			expect(fakeProvider.fetchVectorsByNoteIds).toHaveBeenCalledWith(['b']);
		});

		it('also marks a note whose stored vector is older than the note', async () => {
			await startWithVectorFor('a', [note('a'), { ...note('b'), updated_time: 5 }]);
			mockVectorStore.getMany.mockResolvedValue(
				new Map([['a', { vector: [1, 0], modelId: 'test-model', updatedTime: 1 }]])
			);
			mockBuilder.buildWithSimilarity.mockClear();
			await controller.applyDelta([{ ...note('a'), updated_time: 9 }], []);

			await controller.markOutdatedVectorsStale(['a']);
			await controller.refreshStaleVectors();

			expect(fakeProvider.fetchVectorsByNoteIds).toHaveBeenCalledWith(['a']);
		});

		it('leaves a note alone when its stored vector is as new as the note', async () => {
			await startWithVectorFor('a', [note('a')]);
			mockVectorStore.getMany.mockResolvedValue(
				new Map([['a', { vector: [1, 0], modelId: 'test-model', updatedTime: 1 }]])
			);

			await controller.markOutdatedVectorsStale(['a']);
			await controller.refreshStaleVectors();

			expect(fakeProvider.fetchVectorsByNoteIds).not.toHaveBeenCalled();
		});

		it('builds the semantic graph when the graph is structural because the index was not ready', async () => {
			controller.buildStructural([note('a'), note('b')]);
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockClear();
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [{ note: note('a'), embedding: [1, 0] }],
				errors: [],
			});
			mockBuilder.buildWithSimilarity.mockClear();

			await controller.markOutdatedVectorsStale(['a', 'out-of-scope']);

			await expect(controller.refreshStaleVectors()).resolves.not.toBeNull();
			expect(fakeProvider.fetchVectorsByNoteIds).toHaveBeenCalledWith(['a']);
			expect(mockBuilder.buildWithSimilarity).toHaveBeenCalled();
		});
	});

	describe('refreshStaleVectors', () => {
		const embed = (id: string, vector: number[]) => ({ note: note(id), embedding: vector });

		async function startWithVectors(): Promise<void> {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [embed('a', [1, 0]), embed('b', [0, 1])],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);
			mockBuilder.buildWithSimilarity.mockClear();
			mockOrchestratorInstance.embedNotes.mockClear();
		}

		beforeEach(() => {
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockReset();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map());
		});

		it('does nothing when no vectors are stale', async () => {
			await startWithVectors();

			await expect(controller.refreshStaleVectors()).resolves.toBeNull();

			expect(fakeProvider.fetchVectorsByNoteIds).not.toHaveBeenCalled();
		});

		it('stays stopped after the user cancels embedding, until they start it again', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			const inFlight = controller.embedAndBuildSemantic([note('a'), note('b')]);
			await new Promise((resolve) => setImmediate(resolve));
			controller.cancelCurrentRun();
			deferred.resolve({ embeddedNotes: [], errors: [] });
			await expect(inFlight).resolves.toBeNull();

			controller.markVectorsStale(['a']);
			await expect(controller.refreshStaleVectors()).resolves.toBeNull();
			expect(fakeProvider.fetchVectorsByNoteIds).not.toHaveBeenCalled();

			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [embed('a', [1, 0]), embed('b', [0, 1])],
				errors: [],
			});
			await controller.embedAndBuildSemantic([note('a'), note('b')]);
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));
			await expect(controller.refreshStaleVectors()).resolves.not.toBeNull();
		});

		it('fetches only the stale notes, then rebuilds from the updated vectors', async () => {
			await startWithVectors();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));

			controller.markVectorsStale(['a']);
			const result = await controller.refreshStaleVectors();

			expect(result).not.toBeNull();
			expect(fakeProvider.fetchVectorsByNoteIds).toHaveBeenCalledWith(['a']);
			expect(mockOrchestratorInstance.embedNotes).not.toHaveBeenCalled();
			const embedded = mockBuilder.buildWithSimilarity.mock.calls[0][1] as Array<{
				note: Note;
				embedding: number[];
			}>;
			expect(embedded.find((en) => en.note.id === 'a')?.embedding).toEqual([0.6, 0.8]);
			expect(embedded.find((en) => en.note.id === 'b')?.embedding).toEqual([0, 1]);
		});

		it('saves the new vector, stamped with the model and the note time', async () => {
			await startWithVectors();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));

			controller.markVectorsStale(['a']);
			await controller.refreshStaleVectors();

			expect(mockVectorStore.saveMany).toHaveBeenCalledWith([
				{ noteId: 'a', vector: [0.6, 0.8], modelId: 'test-model', updatedTime: 1 },
			]);
		});

		it('does not rebuild when the fetched vector is the same as the one in use', async () => {
			await startWithVectors();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [1, 0]]]));

			controller.markVectorsStale(['a']);

			await expect(controller.refreshStaleVectors()).resolves.toBeNull();
			expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
		});

		it('adds a vector for a note that had none yet', async () => {
			await startWithVectors();
			await controller.applyDelta([note('c')], []);
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['c', [1, 1]]]));

			controller.markVectorsStale(['c']);
			await controller.refreshStaleVectors();

			const embedded = mockBuilder.buildWithSimilarity.mock.calls[0][1] as Array<{ note: Note }>;
			expect(embedded.map((en) => en.note.id)).toEqual(['a', 'b', 'c']);
		});

		it('removes the stored vector when Joplin no longer has one for that note', async () => {
			await startWithVectors();

			controller.markVectorsStale(['a']);
			await controller.refreshStaleVectors();

			expect(mockVectorStore.removeMany).toHaveBeenCalledWith(['a']);
		});

		it('keeps notes marked when the fetch fails, so the next attempt retries them', async () => {
			await startWithVectors();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockRejectedValueOnce(new Error('network'));

			controller.markVectorsStale(['a']);
			await expect(controller.refreshStaleVectors()).rejects.toThrow('network');

			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));
			await expect(controller.refreshStaleVectors()).resolves.not.toBeNull();
		});

		it('waits while a semantic run is in flight, then picks the notes up', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			const notes = [note('a')];
			controller.buildStructural(notes);
			const run = controller.embedAndBuildSemantic(notes);
			await new Promise((resolve) => setImmediate(resolve));

			controller.markVectorsStale(['a']);
			await expect(controller.refreshStaleVectors()).resolves.toBeNull();
			expect(fakeProvider.fetchVectorsByNoteIds).not.toHaveBeenCalled();

			deferred.resolve({ embeddedNotes: [embed('a', [1, 0])], errors: [] });
			await run;
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));

			await expect(controller.refreshStaleVectors()).resolves.not.toBeNull();
		});

		it('does not cancel a run that started while the new vectors were being fetched', async () => {
			await startWithVectors();
			const deferred = deferredEmbedResult();
			mockOrchestratorInstance.embedNotes.mockReturnValue(deferred.promise);
			let finishFetch: (vectors: Map<string, number[]>) => void = () => undefined;
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockReturnValueOnce(
				new Promise((resolve) => {
					finishFetch = resolve;
				})
			);

			controller.markVectorsStale(['a']);
			const refresh = controller.refreshStaleVectors();
			await new Promise((resolve) => setImmediate(resolve));
			const run = controller.embedAndBuildSemantic([note('a'), note('b')]);
			await new Promise((resolve) => setImmediate(resolve));
			finishFetch(new Map([['a', [0.6, 0.8]]]));

			await expect(refresh).resolves.toBeNull();
			deferred.resolve({ embeddedNotes: [embed('a', [0.6, 0.8])], errors: [] });
			await expect(run).resolves.not.toBeNull();

			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));
			mockBuilder.buildWithSimilarity.mockClear();
			await controller.refreshStaleVectors();
			expect(fakeProvider.fetchVectorsByNoteIds).toHaveBeenLastCalledWith(['a']);
		});

		it('clears the marks when AI analysis has been turned off', async () => {
			await startWithVectors();
			controller.markVectorsStale(['a']);
			mockIsAiAnalysisEnabled.mockResolvedValue(false);

			await expect(controller.refreshStaleVectors()).resolves.toBeNull();

			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			await controller.refreshStaleVectors();
			expect(fakeProvider.fetchVectorsByNoteIds).not.toHaveBeenCalled();
		});

		describe('after a cache load', () => {
			const stored = (vector: number[], modelId = 'test-model') => ({
				vector,
				modelId,
				updatedTime: 1,
			});

			async function loadCachedGraphWithStoredVectors(
				vectors: Map<string, ReturnType<typeof stored>>
			): Promise<void> {
				mockIsAiAnalysisEnabled.mockResolvedValue(true);
				MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
				mockGraphCache.loadGraph.mockResolvedValue({
					notes: [note('a'), note('b')],
					graphData: { nodes: [], edges: [] },
				});
				mockVectorStore.getMany.mockResolvedValue(vectors);
				await controller.loadFromCache();
			}

			it('uses the stored vectors, and does not rebuild when the re-read vector is unchanged', async () => {
				await loadCachedGraphWithStoredVectors(
					new Map([
						['a', stored([1, 0])],
						['b', stored([0, 1])],
					])
				);
				(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [1, 0]]]));

				controller.markVectorsStale(['a']);

				await expect(controller.refreshStaleVectors()).resolves.toBeNull();
				expect(mockOrchestratorInstance.embedNotes).not.toHaveBeenCalled();
				expect(mockBuilder.buildWithSimilarity).not.toHaveBeenCalled();
				expect(controller.hasEmbeddedNotes()).toBe(true);
			});

			it('rebuilds from the stored vectors when one really changed, without a full embed', async () => {
				await loadCachedGraphWithStoredVectors(
					new Map([
						['a', stored([1, 0])],
						['b', stored([0, 1])],
					])
				);
				(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));

				controller.markVectorsStale(['a']);

				await expect(controller.refreshStaleVectors()).resolves.not.toBeNull();
				expect(mockOrchestratorInstance.embedNotes).not.toHaveBeenCalled();
				const embedded = mockBuilder.buildWithSimilarity.mock.calls[0][1] as Array<{
					note: Note;
					embedding: number[];
				}>;
				expect(embedded.find((en) => en.note.id === 'a')?.embedding).toEqual([0.6, 0.8]);
				expect(embedded.find((en) => en.note.id === 'b')?.embedding).toEqual([0, 1]);
			});

			it('ignores stored vectors from another model', async () => {
				await loadCachedGraphWithStoredVectors(new Map([['a', stored([1, 0], 'old-model')]]));
				(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [1, 0]]]));
				mockOrchestratorInstance.embedNotes.mockResolvedValue({
					embeddedNotes: [embed('a', [1, 0])],
					errors: [],
				});

				controller.markVectorsStale(['a']);
				await controller.refreshStaleVectors();

				expect(mockOrchestratorInstance.embedNotes).toHaveBeenCalledTimes(1);
			});
		});

		it('does a full embed when the graph came from the cache and has no vectors in memory', async () => {
			mockIsAiAnalysisEnabled.mockResolvedValue(true);
			MockProviderResolver.resolveWithValidation.mockResolvedValue(fakeProvider);
			mockGraphCache.loadGraph.mockResolvedValue({
				notes: [note('a')],
				graphData: { nodes: [], edges: [] },
			});
			await controller.loadFromCache();
			(fakeProvider.fetchVectorsByNoteIds as jest.Mock).mockResolvedValue(new Map([['a', [0.6, 0.8]]]));
			mockOrchestratorInstance.embedNotes.mockResolvedValue({
				embeddedNotes: [embed('a', [0.6, 0.8])],
				errors: [],
			});

			controller.markVectorsStale(['a']);
			await controller.refreshStaleVectors();

			expect(mockOrchestratorInstance.embedNotes).toHaveBeenCalledTimes(1);
			expect(controller.hasEmbeddedNotes()).toBe(true);
		});
	});

	describe('cache writes', () => {
		it('waits, then writes only the latest graph, for a burst of changes', () => {
			jest.useFakeTimers();
			try {
				const delayed = new AnalysisController(
					mockBuilder,
					mockGraphCache,
					mockEnricher,
					mockVectorStore as unknown as VectorRepository,
					3000
				);
				const latest = { nodes: [], edges: [] };
				delayed.buildStructural([note('a')]);
				mockBuilder.build.mockReturnValue(latest);
				delayed.buildStructural([note('b')]);
				expect(mockGraphCache.saveGraph).not.toHaveBeenCalled();

				jest.advanceTimersByTime(3000);

				expect(mockGraphCache.saveGraph).toHaveBeenCalledTimes(1);
				expect(mockGraphCache.saveGraph).toHaveBeenCalledWith([note('b')], latest);
			} finally {
				jest.useRealTimers();
			}
		});

		it('skips a delayed write if the load turned out incomplete in the meantime', () => {
			jest.useFakeTimers();
			try {
				const delayed = new AnalysisController(
					mockBuilder,
					mockGraphCache,
					mockEnricher,
					mockVectorStore as unknown as VectorRepository,
					3000
				);
				delayed.buildStructural([note('a')]);
				delayed.setCachePersistenceEnabled(false);

				jest.advanceTimersByTime(3000);

				expect(mockGraphCache.saveGraph).not.toHaveBeenCalled();
			} finally {
				jest.useRealTimers();
			}
		});

		it('writes a text-only edit to the cache, but only after a long wait', async () => {
			jest.useFakeTimers();
			try {
				controller.buildStructural([note('a')]);
				mockGraphCache.saveGraph.mockClear();

				await controller.applyDelta([{ ...note('a'), updated_time: 2, body: 'new' }], []);
				jest.advanceTimersByTime(3000);
				expect(mockGraphCache.saveGraph).not.toHaveBeenCalled();

				jest.advanceTimersByTime(60_000);
				expect(mockGraphCache.saveGraph).toHaveBeenCalledTimes(1);
				expect(mockGraphCache.saveGraph.mock.calls[0][0][0].updated_time).toBe(2);
			} finally {
				jest.useRealTimers();
			}
		});

		it('does not hold back a structural change behind a pending text-only write', async () => {
			jest.useFakeTimers();
			try {
				const delayed = new AnalysisController(
					mockBuilder,
					mockGraphCache,
					mockEnricher,
					mockVectorStore as unknown as VectorRepository,
					3000
				);
				delayed.buildStructural([note('a')]);
				jest.advanceTimersByTime(3000);
				mockGraphCache.saveGraph.mockClear();

				await delayed.applyDelta([{ ...note('a'), updated_time: 2, body: 'new' }], []);
				await delayed.applyDelta([note('b')], []);
				jest.advanceTimersByTime(3000);

				expect(mockGraphCache.saveGraph).toHaveBeenCalledTimes(1);
				jest.advanceTimersByTime(60_000);
				expect(mockGraphCache.saveGraph).toHaveBeenCalledTimes(1);
			} finally {
				jest.useRealTimers();
			}
		});

		it('trims full bodies from a cache written by an older version', async () => {
			const longBody = 'x'.repeat(5000);
			mockGraphCache.loadGraph.mockResolvedValue({
				notes: [{ ...note('a'), body: longBody }],
				graphData: { nodes: [], edges: [] },
			});

			await controller.loadFromCache();

			expect(controller.getCurrentNotes()[0].body.length).toBeLessThan(1000);
		});

		it('does not read the whole cached graph to migrate labels once labels are stored', async () => {
			mockGraphCache.hasEnrichments.mockResolvedValue(true);

			await controller.migrateCachedEnrichment();

			expect(mockGraphCache.loadGraph).not.toHaveBeenCalled();
		});
	});

	describe('pruneDeletedNotes', () => {
		it('prunes both the vector and the label caches', () => {
			const keep = new Set(['a']);

			controller.pruneDeletedNotes(keep);

			expect(mockVectorStore.pruneExcept).toHaveBeenCalledWith(keep);
			expect(mockGraphCache.pruneEnrichments).toHaveBeenCalledWith(keep);
		});
	});
});
