import joplin from 'api';
import { JoplinNativeProvider } from './JoplinNativeProvider';

describe('JoplinNativeProvider', () => {
	it('returns an empty map without touching AI when no note ids are requested', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, state: 'ready', modelId: 'test-model' });
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

		ai.getIndexStatus.mockResolvedValue({
			ready: true,
			state: 'ready',
			modelId: 'fresh-model',
		});
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'fresh-model',
			dimension: 2,
			chunks: [{ noteId: 'n1', vector: [1, 0] }],
			nextCursor: undefined,
		});

		await provider.fetchVectorsByNoteIds(['n1']);
		expect(provider.modelName).toBe('fresh-model');

		jest.useFakeTimers();
		ai.getEmbeddings.mockRejectedValue(new Error('network error'));
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const rejection = expect(provider.fetchVectorsByNoteIds(['n2'])).rejects.toThrow(
			'network error'
		);
		await jest.advanceTimersByTimeAsync(3000);
		await rejection;

		errorSpy.mockRestore();
		jest.useRealTimers();
	});

	describe('retry on failure', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('retries a failed page fetch and succeeds without losing pagination state', async () => {
			const provider = new JoplinNativeProvider();
			const ai = joplin.ai as unknown as {
				getIndexStatus: jest.Mock;
				getEmbeddings: jest.Mock;
			};

			ai.getIndexStatus.mockResolvedValue({
				ready: true,
				state: 'ready',
				modelId: 'test-model',
			});
			let calls = 0;
			ai.getEmbeddings.mockImplementation(async () => {
				calls++;
				if (calls === 1) throw new Error('network blip');
				return {
					modelId: 'test-model',
					dimension: 2,
					chunks: [{ noteId: 'n1', vector: [1, 0] }],
					nextCursor: undefined,
				};
			});
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = provider.fetchVectorsByNoteIds(['n1']);
			await jest.advanceTimersByTimeAsync(1000);
			const vectors = await resultPromise;

			expect(ai.getEmbeddings).toHaveBeenCalledTimes(2);
			expect(vectors.get('n1')).toEqual([1, 0]);
			errorSpy.mockRestore();
		});

		it('gives up after exhausting every attempt for one page', async () => {
			const provider = new JoplinNativeProvider();
			const ai = joplin.ai as unknown as {
				getIndexStatus: jest.Mock;
				getEmbeddings: jest.Mock;
			};

			ai.getIndexStatus.mockResolvedValue({
				ready: true,
				state: 'ready',
				modelId: 'test-model',
			});
			ai.getEmbeddings.mockRejectedValue(new Error('network blip'));
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = provider.fetchVectorsByNoteIds(['n1']);
			const rejection = expect(resultPromise).rejects.toThrow('network blip');
			await jest.advanceTimersByTimeAsync(3000);
			await rejection;

			expect(ai.getEmbeddings).toHaveBeenCalledTimes(3);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('giving up'),
				expect.anything()
			);
			errorSpy.mockRestore();
		});

		it('backs off exponentially between page-fetch retries instead of a fixed delay', async () => {
			const provider = new JoplinNativeProvider();
			const ai = joplin.ai as unknown as {
				getIndexStatus: jest.Mock;
				getEmbeddings: jest.Mock;
			};

			ai.getIndexStatus.mockResolvedValue({
				ready: true,
				state: 'ready',
				modelId: 'test-model',
			});
			ai.getEmbeddings.mockRejectedValue(new Error('network blip'));
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = provider.fetchVectorsByNoteIds(['n1']);
			const rejection = expect(resultPromise).rejects.toThrow('network blip');

			await jest.advanceTimersByTimeAsync(999);
			expect(ai.getEmbeddings).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(1);
			expect(ai.getEmbeddings).toHaveBeenCalledTimes(2);

			await jest.advanceTimersByTimeAsync(1999);
			expect(ai.getEmbeddings).toHaveBeenCalledTimes(2);

			await jest.advanceTimersByTimeAsync(1);
			expect(ai.getEmbeddings).toHaveBeenCalledTimes(3);

			await rejection;
			errorSpy.mockRestore();
		});

		it('retries a transient getIndexStatus() failure before giving up on the page fetch', async () => {
			const provider = new JoplinNativeProvider();
			const ai = joplin.ai as unknown as {
				getIndexStatus: jest.Mock;
				getEmbeddings: jest.Mock;
			};

			let statusCalls = 0;
			ai.getIndexStatus.mockImplementation(async () => {
				statusCalls++;
				if (statusCalls === 1) throw new Error('rpc hiccup');
				return { ready: true, state: 'ready', modelId: 'test-model' };
			});
			ai.getEmbeddings.mockResolvedValue({
				modelId: 'test-model',
				dimension: 2,
				chunks: [{ noteId: 'n1', vector: [1, 0] }],
				nextCursor: undefined,
			});
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = provider.fetchVectorsByNoteIds(['n1']);
			await jest.advanceTimersByTimeAsync(1000);
			const vectors = await resultPromise;

			expect(ai.getIndexStatus).toHaveBeenCalledTimes(2);
			expect(vectors.get('n1')).toEqual([1, 0]);
			errorSpy.mockRestore();
		});

		it('gives up after exhausting every attempt for getIndexStatus()', async () => {
			const provider = new JoplinNativeProvider();
			const ai = joplin.ai as unknown as {
				getIndexStatus: jest.Mock;
				getEmbeddings: jest.Mock;
			};

			ai.getIndexStatus.mockRejectedValue(new Error('rpc down'));
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = provider.fetchVectorsByNoteIds(['n1']);
			const rejection = expect(resultPromise).rejects.toThrow('rpc down');
			await jest.advanceTimersByTimeAsync(3000);
			await rejection;

			expect(ai.getIndexStatus).toHaveBeenCalledTimes(3);
			errorSpy.mockRestore();
		});
	});

	it('pools vectors across pages and normalizes the result', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, state: 'ready', modelId: 'test-model' });
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
	});

	it('restarts pagination when the model changes mid-fetch', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: true, state: 'ready', modelId: 'model-a' });
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
		expect(provider.modelName).toBe('model-b');
	});

	it('fetches vectors while the index is still indexing, since results are just partial', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({
			ready: false,
			state: 'indexing',
			modelId: 'test-model',
		});
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'test-model',
			dimension: 2,
			chunks: [{ noteId: 'n1', vector: [1, 0] }],
			nextCursor: undefined,
		});

		const vectors = await provider.fetchVectorsByNoteIds(['n1']);

		expect(vectors.get('n1')).toEqual([1, 0]);
	});

	it('throws when the index is disabled', async () => {
		const provider = new JoplinNativeProvider();
		const ai = joplin.ai as unknown as {
			getIndexStatus: jest.Mock;
			getEmbeddings: jest.Mock;
		};

		ai.getIndexStatus.mockResolvedValue({ ready: false, state: 'disabled', modelId: null });

		await expect(provider.fetchVectorsByNoteIds(['n1'])).rejects.toThrow(
			'Joplin AI index is not usable yet (state: disabled)'
		);
	});

	describe('batching', () => {
		const ids = (count: number) => Array.from({ length: count }, (_, i) => `n${i}`);
		const ai = joplin.ai as unknown as { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };

		beforeEach(() => {
			ai.getIndexStatus.mockResolvedValue({ state: 'ready', modelId: 'm1' });
			ai.getEmbeddings.mockReset();
			ai.getEmbeddings.mockImplementation(async (options: { noteIds: string[] }) => ({
				modelId: 'm1',
				dimension: 2,
				chunks: options.noteIds.map((noteId) => ({ noteId, chunkIndex: 0, vector: [1, 0] })),
				nextCursor: undefined,
			}));
		});

		it('splits a large request so no call sends more than 200 note IDs', async () => {
			const vectors = await new JoplinNativeProvider('m1').fetchVectorsByNoteIds(ids(450));

			expect(vectors.size).toBe(450);
			expect(ai.getEmbeddings).toHaveBeenCalledTimes(3);
			for (const [options] of ai.getEmbeddings.mock.calls) {
				expect(options.noteIds.length).toBeLessThanOrEqual(200);
			}
		});

		it('reports progress after each batch', async () => {
			const onProgress = jest.fn();

			await new JoplinNativeProvider('m1').fetchVectorsByNoteIds(ids(450), () => false, onProgress);

			expect(onProgress.mock.calls).toEqual([
				[200, 450],
				[400, 450],
				[450, 450],
			]);
		});

		it('stops between batches when cancelled', async () => {
			let cancelled = false;
			ai.getEmbeddings.mockImplementation(async () => {
				cancelled = true;
				return { modelId: 'm1', dimension: 2, chunks: [], nextCursor: undefined };
			});

			await new JoplinNativeProvider('m1').fetchVectorsByNoteIds(ids(450), () => cancelled);

			expect(ai.getEmbeddings).toHaveBeenCalledTimes(1);
		});

		it('starts over if the model changes between batches, so vectors never mix models', async () => {
			let call = 0;
			ai.getEmbeddings.mockImplementation(async (options: { noteIds: string[] }) => {
				call++;
				return {
					modelId: call === 1 ? 'm1' : 'm2',
					dimension: 2,
					chunks: options.noteIds.map((noteId) => ({ noteId, chunkIndex: 0, vector: [1, 0] })),
					nextCursor: undefined,
				};
			});

			const provider = new JoplinNativeProvider('m1');
			ai.getIndexStatus.mockResolvedValueOnce({ state: 'ready', modelId: 'm1' });
			ai.getIndexStatus.mockResolvedValue({ state: 'ready', modelId: 'm2' });
			const vectors = await provider.fetchVectorsByNoteIds(ids(300));

			expect(vectors.size).toBe(300);
			expect(provider.modelName).toBe('m2');
			expect(call).toBe(4);
		});
	});
});
