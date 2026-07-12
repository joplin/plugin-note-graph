import { EmbeddingOrchestrator } from './Orchestrator';
import { BatchProgress } from './Types';
import { Note } from '../../data/Types';

function makeNote(id: string, title: string, body: string): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body,
		created_time: 0,
		updated_time: 0,
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
});
