import joplin from 'api';
import { EmbeddingChangeDetector, EmbeddingSweepState } from './EmbeddingChangeDetector';

function fakeState(initial: { cursor?: string | null; model?: string | null } = {}) {
	let cursor = initial.cursor ?? null;
	let model = initial.model ?? null;
	const state: jest.Mocked<EmbeddingSweepState> = {
		loadEmbeddingsCursor: jest.fn(async () => cursor),
		saveEmbeddingsCursor: jest.fn(async (value: string) => {
			cursor = value;
		}),
		clearEmbeddingsCursor: jest.fn(async () => {
			cursor = null;
		}),
		loadEmbeddingsModel: jest.fn(async () => model),
		saveEmbeddingsModel: jest.fn(async (value: string) => {
			model = value;
		}),
	};
	return state;
}

const page = (noteIds: string[], nextCursor?: string) => ({
	modelId: 'm1',
	dimension: 2,
	chunks: noteIds.map((noteId, chunkIndex) => ({
		noteId,
		chunkIndex,
		chunkText: '',
		vector: [1, 0],
	})),
	nextCursor,
});

describe('EmbeddingChangeDetector', () => {
	let ai: { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };

	beforeEach(() => {
		ai = joplin.ai as unknown as typeof ai;
		ai.getIndexStatus.mockReset();
		ai.getEmbeddings.mockReset();
		ai.getIndexStatus.mockResolvedValue({ state: 'ready', modelId: 'm1' });
	});

	it('reports the notes in the stream after the saved cursor, and saves the new position', async () => {
		ai.getEmbeddings
			.mockResolvedValueOnce(page(['a', 'b'], 'c2'))
			.mockResolvedValueOnce(page(['b', 'c']));
		const state = fakeState({ cursor: 'c1', model: 'm1' });

		const changes = await new EmbeddingChangeDetector(state).detect();

		expect(changes).toEqual({
			noteIds: ['a', 'b', 'c'],
			modelChanged: false,
			isBaseline: false,
		});
		expect(ai.getEmbeddings).toHaveBeenNthCalledWith(1, { cursor: 'c1', limit: 200 });
		expect(ai.getEmbeddings).toHaveBeenNthCalledWith(2, { cursor: 'c2', limit: 200 });
		expect(state.saveEmbeddingsCursor).toHaveBeenLastCalledWith('c2');
	});

	it('treats the first sweep over a large index as a baseline, not as every note changing', async () => {
		ai.getEmbeddings
			.mockResolvedValueOnce(page(['a'], 'c1'))
			.mockResolvedValueOnce(page(['b']));
		const state = fakeState();

		const changes = await new EmbeddingChangeDetector(state).detect();

		expect(changes).toEqual({ noteIds: ['a', 'b'], modelChanged: false, isBaseline: true });
		expect(state.saveEmbeddingsCursor).toHaveBeenCalledWith('c1');
	});

	it('reports notes when the index is so small that no cursor exists yet, so it never misses a change', async () => {
		ai.getEmbeddings.mockResolvedValueOnce(page(['a']));
		const state = fakeState();

		const changes = await new EmbeddingChangeDetector(state).detect();

		expect(changes.noteIds).toEqual(['a']);
		expect(changes.isBaseline).toBe(false);
		expect(state.saveEmbeddingsCursor).not.toHaveBeenCalled();
	});

	it('restarts from the beginning and reports a model change', async () => {
		ai.getIndexStatus.mockResolvedValue({ state: 'ready', modelId: 'm2' });
		ai.getEmbeddings.mockResolvedValueOnce(page(['a']));
		const state = fakeState({ cursor: 'old', model: 'm1' });

		const changes = await new EmbeddingChangeDetector(state).detect();

		expect(changes).toEqual({ noteIds: [], modelChanged: true, isBaseline: false });
		expect(state.clearEmbeddingsCursor).toHaveBeenCalled();
		expect(ai.getEmbeddings).toHaveBeenCalledWith({ cursor: undefined, limit: 200 });
		expect(state.saveEmbeddingsModel).toHaveBeenCalledWith('m2');
	});

	it('does not count the first recorded model as a change', async () => {
		ai.getEmbeddings.mockResolvedValueOnce(page([]));
		const state = fakeState({ cursor: 'c1' });

		const changes = await new EmbeddingChangeDetector(state).detect();

		expect(changes.modelChanged).toBe(false);
		expect(state.saveEmbeddingsModel).toHaveBeenCalledWith('m1');
	});

	it('throws, and saves nothing, when a page fails, so the next sweep covers the same range', async () => {
		ai.getEmbeddings
			.mockResolvedValueOnce(page(['a'], 'c2'))
			.mockRejectedValueOnce(new Error('network error'));
		const state = fakeState({ cursor: 'c1', model: 'm1' });

		await expect(new EmbeddingChangeDetector(state).detect()).rejects.toThrow('network error');

		expect(state.saveEmbeddingsCursor).not.toHaveBeenCalled();
	});

	it('throws when the index is not usable yet', async () => {
		ai.getIndexStatus.mockResolvedValue({ state: 'preparing', modelId: null });

		await expect(new EmbeddingChangeDetector(fakeState()).detect()).rejects.toThrow(
			'not usable'
		);

		expect(ai.getEmbeddings).not.toHaveBeenCalled();
	});
});
