import { EmbeddingOrchestrator } from './Orchestrator';
import { BatchProgress } from './Types';
import { Note } from '../../data/Types';

function makeNote(id: string, title: string, body: string, updatedTime = 0): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body,
		created_time: 0,
		updated_time: updatedTime,
	};
}

describe('EmbeddingOrchestrator', () => {
	let orchestrator: EmbeddingOrchestrator;

	beforeEach(() => {
		orchestrator = new EmbeddingOrchestrator();
	});

	describe('embedNotes', () => {
		it('returns empty result for empty notes array', async () => {
			const result = await orchestrator.embedNotes([]);
			expect(result.embeddedNotes).toEqual([]);
			expect(result.errors).toEqual([]);
		});

		it('returns error when no provider is set', async () => {
			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'Body')]);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].error).toContain('No provider');
		});

		it('maps fetched vectors to embedded notes', async () => {
			const mockVectors = new Map<string, number[]>();
			mockVectors.set('n1', [0.1, 0.2, 0.3]);
			mockVectors.set('n2', [0.4, 0.5, 0.6]);

			orchestrator.setProvider({
				id: 'joplin-native',
				modelName: 'test-model',
				fetchVectorsByNoteIds: jest.fn().mockResolvedValue(mockVectors),
			});

			const notes = [makeNote('n1', 'Title 1', 'Body 1'), makeNote('n2', 'Title 2', 'Body 2')];
			const result = await orchestrator.embedNotes(notes);

			expect(result.embeddedNotes).toHaveLength(2);
			expect(result.errors).toHaveLength(0);
			expect(result.embeddedNotes[0].embedding).toEqual([0.1, 0.2, 0.3]);
			expect(result.embeddedNotes[1].embedding).toEqual([0.4, 0.5, 0.6]);
		});

		it('reports errors for notes not found in index', async () => {
			const mockVectors = new Map<string, number[]>();
			mockVectors.set('n1', [0.1, 0.2, 0.3]);

			orchestrator.setProvider({
				id: 'joplin-native',
				modelName: 'test-model',
				fetchVectorsByNoteIds: jest.fn().mockResolvedValue(mockVectors),
			});

			const result = await orchestrator.embedNotes([
				makeNote('n1', 'T1', 'B1'),
				makeNote('n2', 'T2', 'B2'),
			]);

			expect(result.embeddedNotes).toHaveLength(1);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].noteId).toBe('n2');
		});

		it('emits progress updates while embedding', async () => {
			const progressUpdates: BatchProgress[] = [];
			orchestrator.setOnProgress((progress) => {
				progressUpdates.push(progress);
			});

			const mockVectors = new Map<string, number[]>();
			mockVectors.set('n1', [0.1, 0.2, 0.3]);
			mockVectors.set('n2', [0.4, 0.5, 0.6]);

			orchestrator.setProvider({
				id: 'joplin-native',
				modelName: 'test-model',
				fetchVectorsByNoteIds: jest.fn().mockResolvedValue(mockVectors),
			});

			await orchestrator.embedNotes([
				makeNote('n1', 'T1', 'B1'),
				makeNote('n2', 'T2', 'B2'),
			]);

			expect(progressUpdates).toEqual([
				{ current: 0, total: 2 },
				{ current: 1, total: 2 },
				{ current: 2, total: 2 },
			]);
		});

		it('returns empty when cancelled', async () => {
			orchestrator.setProvider({
				id: 'joplin-native',
				modelName: 'test-model',
				fetchVectorsByNoteIds: jest.fn().mockImplementation(async () => {
					orchestrator.cancel();
					return new Map();
				}),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1')]);
			expect(result.embeddedNotes).toEqual([]);
		});

		it('catches provider errors and marks all notes', async () => {
			orchestrator.setProvider({
				id: 'joplin-native',
				modelName: 'test-model',
				fetchVectorsByNoteIds: jest.fn().mockRejectedValue(new Error('API failure')),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1')]);
			expect(result.embeddedNotes).toHaveLength(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].error).toBe('API failure');
		});
	});

	describe('vector caching', () => {
		it('serves an unchanged, same-model note from the cache without calling the provider', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map());
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(
					new Map([['n1', { vector: [0.1, 0.2], modelId: 'm1', updatedTime: 50 }]]),
				),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 50)]);

			expect(fetchVectorsByNoteIds).not.toHaveBeenCalled();
			expect(result.embeddedNotes).toHaveLength(1);
			expect(result.embeddedNotes[0].embedding).toEqual([0.1, 0.2]);
		});

		it('re-fetches a note whose updated_time no longer matches the cached entry', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.9, 0.9]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(
					new Map([['n1', { vector: [0.1, 0.2], modelId: 'm1', updatedTime: 50 }]]),
				),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 999)]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n1']);
			expect(result.embeddedNotes[0].embedding).toEqual([0.9, 0.9]);
		});

		it('does not fall back to a stale cached vector when the re-fetch omits the note', async () => {
			// The note changed (updated_time no longer matches), so it's correctly
			// queued for re-fetch — but Joplin's AI index hasn't caught up yet and
			// returns nothing for it. The stale pre-edit vector must not be used.
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map());
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(
					new Map([['n1', { vector: [0.1, 0.2], modelId: 'm1', updatedTime: 50 }]]),
				),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 999)]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n1']);
			expect(result.embeddedNotes).toHaveLength(0);
			expect(result.errors).toEqual([{ noteId: 'n1', error: 'Note not yet indexed by Joplin AI.' }]);
		});

		it('re-fetches a note whose cached entry belongs to a different embedding model', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.9, 0.9]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm2', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(
					new Map([['n1', { vector: [0.1, 0.2], modelId: 'm1', updatedTime: 50 }]]),
				),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 50)]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n1']);
			expect(result.embeddedNotes[0].embedding).toEqual([0.9, 0.9]);
		});

		it('only asks the provider for stale/missing notes, mixing in cache hits', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n2', [0.4, 0.5]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(
					new Map([['n1', { vector: [0.1, 0.2], modelId: 'm1', updatedTime: 10 }]]),
				),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([
				makeNote('n1', 'T1', 'B1', 10),
				makeNote('n2', 'T2', 'B2', 20),
			]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n2']);
			expect(result.embeddedNotes).toHaveLength(2);
			expect(result.errors).toHaveLength(0);
		});

		it('saves freshly fetched vectors back to the cache with the note updated_time and model', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.4, 0.5]]]));
			const saveMany = jest.fn().mockResolvedValue(undefined);
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({ getMany: jest.fn().mockResolvedValue(new Map()), saveMany });

			await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 42)]);

			expect(saveMany).toHaveBeenCalledWith([
				{ noteId: 'n1', vector: [0.4, 0.5], modelId: 'm1', updatedTime: 42 },
			]);
		});

		it('does not save notes the provider failed to return', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map());
			const saveMany = jest.fn().mockResolvedValue(undefined);
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({ getMany: jest.fn().mockResolvedValue(new Map()), saveMany });

			await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 42)]);

			expect(saveMany).not.toHaveBeenCalled();
		});

		it('falls back to a full fetch when the cache read throws', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.4, 0.5]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockRejectedValue(new Error('disk error')),
				saveMany: jest.fn().mockResolvedValue(undefined),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 42)]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n1']);
			expect(result.embeddedNotes[0].embedding).toEqual([0.4, 0.5]);
		});

		it('still returns results when the cache write throws', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.4, 0.5]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });
			orchestrator.setCache({
				getMany: jest.fn().mockResolvedValue(new Map()),
				saveMany: jest.fn().mockRejectedValue(new Error('disk full')),
			});

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 42)]);

			expect(result.embeddedNotes[0].embedding).toEqual([0.4, 0.5]);
			expect(result.errors).toHaveLength(0);
		});

		it('behaves exactly as before when no cache is set', async () => {
			const fetchVectorsByNoteIds = jest.fn().mockResolvedValue(new Map([['n1', [0.4, 0.5]]]));
			orchestrator.setProvider({ id: 'joplin-native', modelName: 'm1', fetchVectorsByNoteIds });

			const result = await orchestrator.embedNotes([makeNote('n1', 'T1', 'B1', 42)]);

			expect(fetchVectorsByNoteIds).toHaveBeenCalledWith(['n1']);
			expect(result.embeddedNotes[0].embedding).toEqual([0.4, 0.5]);
		});
	});
});
