import joplin from 'api';
import { JoplinNativeProvider } from './JoplinNativeProvider';

describe('JoplinNativeProvider', () => {
	it('returns an empty map without touching AI when no note ids are requested', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, modelId: 'test-model' });
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'test-model',
			dimension: 3,
			chunks: [],
		});

		const vectors = await provider.fetchVectorsByNoteIds([]);

		expect(vectors.size).toBe(0);
		expect(ai.getIndexStatus).not.toHaveBeenCalled();
		expect(ai.getEmbeddings).not.toHaveBeenCalled();
	});

	it('clears stale cached state before starting a new fetch', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, modelId: 'fresh-model' });
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'fresh-model',
			dimension: 2,
			chunks: [{ noteId: 'n1', vector: [1, 0] }],
			nextCursor: undefined,
		});

		await provider.fetchVectorsByNoteIds(['n1']);
		expect(provider.getFetchedModelId()).toBe('fresh-model');
		expect(provider.getCachedVectors()).toEqual(new Map([['n1', [1, 0]]]));

		ai.getEmbeddings.mockRejectedValue(new Error('network error'));

		await expect(provider.fetchVectorsByNoteIds(['n2'])).rejects.toThrow('network error');
		expect(provider.getFetchedModelId()).toBeNull();
		expect(provider.getCachedVectors()).toBeNull();
	});

	it('pools vectors across pages and normalizes the result', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, modelId: 'test-model' });
		ai.getEmbeddings
			.mockResolvedValueOnce({
				modelId: 'test-model',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [3, 0] }],
				nextCursor: 'cursor-1',
			})
			.mockResolvedValueOnce({
				modelId: 'test-model',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [0, 4] }],
				nextCursor: undefined,
			});

		const vectors = await provider.fetchVectorsByNoteIds(['n1']);
		const vector = vectors.get('n1');

		expect(ai.getEmbeddings).toHaveBeenCalledTimes(2);
		expect(vector).toBeDefined();
		expect(vector![0]).toBeCloseTo(0.6, 5);
		expect(vector![1]).toBeCloseTo(0.8, 5);
		expect(provider.getFetchedModelId()).toBe('test-model');
	});

	it('restarts pagination when the model changes mid-fetch', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, modelId: 'model-a' });
		ai.getEmbeddings
			.mockResolvedValueOnce({
				modelId: 'model-a',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [1, 0] }],
				nextCursor: 'cursor-1',
			})
			.mockResolvedValueOnce({
				modelId: 'model-b',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [0, 1] }],
				nextCursor: undefined,
			})
			.mockResolvedValueOnce({
				modelId: 'model-b',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [0, 1] }],
				nextCursor: undefined,
			});

		const vectors = await provider.fetchVectorsByNoteIds(['n1']);
		const vector = vectors.get('n1');

		expect(ai.getEmbeddings).toHaveBeenCalledTimes(3);
		expect(vector).toEqual([0, 1]);
		expect(provider.getFetchedModelId()).toBe('model-b');
		expect(provider.modelName).toBe('model-b');
	});
});
