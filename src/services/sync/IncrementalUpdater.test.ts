import joplin from 'api';
import { IncrementalUpdater } from './IncrementalUpdater';
import { AnalysisController } from '../AnalysisController';
import { NoteRepository } from '../../data/NoteRepository';
import { NotePreprocessor } from '../../data/NotePreprocessor';
import { EventsRepository } from '../../data/EventsRepository';
import { GraphCacheRepository } from '../../data/Database/GraphCacheRepository';
import { Note } from '../../data/Types';

jest.mock('../AnalysisController');
jest.mock('../../data/NoteRepository');
jest.mock('../../data/NotePreprocessor');
jest.mock('../../data/EventsRepository');
jest.mock('../../data/Database/GraphCacheRepository');

const MockAnalysisController = AnalysisController as jest.MockedClass<typeof AnalysisController>;
const MockNoteRepository = NoteRepository as jest.MockedClass<typeof NoteRepository>;
const MockPreprocessor = NotePreprocessor as jest.MockedClass<typeof NotePreprocessor>;
const MockEventsRepository = EventsRepository as jest.MockedClass<typeof EventsRepository>;
const MockGraphCacheRepository = GraphCacheRepository as jest.MockedClass<typeof GraphCacheRepository>;

const COALESCE_WINDOW_MS = 1000;

async function flushMicrotasks(n = 10): Promise<void> {
	for (let i = 0; i < n; i++) {
		await Promise.resolve();
	}
}

function note(id: string, updatedTime = 1): Note {
	return {
		id,
		parent_id: 'p1',
		title: id,
		body: '',
		created_time: 0,
		updated_time: updatedTime,
	};
}

describe('IncrementalUpdater', () => {
	let analysisController: jest.Mocked<AnalysisController>;
	let noteRepository: jest.Mocked<NoteRepository>;
	let preprocessor: jest.Mocked<NotePreprocessor>;
	let eventsRepository: jest.Mocked<EventsRepository>;
	let graphCache: jest.Mocked<GraphCacheRepository>;
	let onGraphPatch: jest.Mock;
	let onFullReloadNeeded: jest.Mock;
	let checkAiEnabled: jest.Mock<Promise<boolean>, []>;
	let onRetriesExhausted: jest.Mock;
	let ai: { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };
	let updater: IncrementalUpdater;

	const fakeDiff = {
		upsertedNodes: [],
		upsertedEdges: [],
		removedNodeIds: [],
		removedEdgeIds: [],
	};

	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();

		analysisController = new MockAnalysisController() as jest.Mocked<AnalysisController>;
		analysisController.hasNotes.mockReturnValue(true);
		analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
		analysisController.getLastDiff.mockReturnValue(fakeDiff);

		noteRepository = new MockNoteRepository() as jest.Mocked<NoteRepository>;
		preprocessor = new MockPreprocessor() as jest.Mocked<NotePreprocessor>;
		preprocessor.processOne.mockImplementation(async (n) => n);

		eventsRepository = new MockEventsRepository() as jest.Mocked<EventsRepository>;
		eventsRepository.getNoteEventsSince.mockResolvedValue({ events: [], cursor: undefined });

		graphCache = new MockGraphCacheRepository() as jest.Mocked<GraphCacheRepository>;
		graphCache.loadEventsCursor.mockResolvedValue(null);
		graphCache.saveEventsCursor.mockResolvedValue(undefined);
		graphCache.loadEmbeddingsCursor.mockResolvedValue(null);
		graphCache.saveEmbeddingsCursor.mockResolvedValue(undefined);

		onGraphPatch = jest.fn();
		onFullReloadNeeded = jest.fn().mockResolvedValue(undefined);
		checkAiEnabled = jest.fn().mockResolvedValue(false);
		onRetriesExhausted = jest.fn();

		ai = joplin.ai as unknown as { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };
		ai.getIndexStatus.mockResolvedValue({ ready: true, state: 'ready', modelId: 'test-model' });
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'test-model',
			dimension: 2,
			chunks: [],
			nextCursor: undefined,
		});

		updater = new IncrementalUpdater(
			analysisController,
			onGraphPatch,
			onFullReloadNeeded,
			noteRepository,
			preprocessor,
			eventsRepository,
			graphCache,
			COALESCE_WINDOW_MS,
			checkAiEnabled,
			onRetriesExhausted
		);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	describe('handleNoteChange', () => {
		it('fetches, enriches, and applies an upsert after the coalescing window for a create/update event', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));

			updater.handleNoteChange({ id: 'a', event: 1 });
			expect(noteRepository.getNote).not.toHaveBeenCalled();

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).toHaveBeenCalledWith('a');
			expect(preprocessor.processOne).toHaveBeenCalledWith(note('a'));
			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], []);
			expect(onGraphPatch).toHaveBeenCalledWith(fakeDiff, { nodes: [], edges: [] });
		});

		it('logs a summary once a new note is successfully upserted', async () => {
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
			noteRepository.getNote.mockResolvedValue(note('a'));

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(consoleInfoSpy).toHaveBeenCalledWith('Incremental update applied: 1 upserted, 0 removed.');
			consoleInfoSpy.mockRestore();
		});

		it('applies a removal for a delete event without fetching the note', async () => {
			updater.handleNoteChange({ id: 'a', event: 3 });

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).not.toHaveBeenCalled();
			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['a']);
		});

		it('coalesces multiple events for the same note into a single fetch', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));

			updater.handleNoteChange({ id: 'a', event: 2 });
			updater.handleNoteChange({ id: 'a', event: 2 });
			updater.handleNoteChange({ id: 'a', event: 2 });

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).toHaveBeenCalledTimes(1);
			expect(analysisController.applyDelta).toHaveBeenCalledTimes(1);
		});

		it('nets a create-then-delete for the same note within the window to a removal only', async () => {
			updater.handleNoteChange({ id: 'a', event: 1 });
			updater.handleNoteChange({ id: 'a', event: 3 });

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).not.toHaveBeenCalled();
			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['a']);
		});

		it('does nothing if no note list has been loaded yet by the time the window elapses', async () => {
			analysisController.hasNotes.mockReturnValue(false);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).not.toHaveBeenCalled();
			expect(analysisController.applyDelta).not.toHaveBeenCalled();
		});

		it('does not push an update or log a summary when applyDelta reports no real change', async () => {
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
			noteRepository.getNote.mockResolvedValue(note('a'));
			analysisController.applyDelta.mockResolvedValue(null);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphPatch).not.toHaveBeenCalled();
			expect(consoleInfoSpy).not.toHaveBeenCalledWith(expect.stringContaining('Incremental update applied'));
			consoleInfoSpy.mockRestore();
		});

		it('requeues a retryable skip and automatically retries after the next coalesce window, with no new event needed', async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			analysisController.applyDelta.mockResolvedValueOnce(null);
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValueOnce(true);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphPatch).not.toHaveBeenCalled();

			analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValue(false);

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenLastCalledWith([note('a')], []);
			expect(onGraphPatch).toHaveBeenCalled();
		});

		it('gives up automatically retrying after 5 consecutive retryable skips, instead of retrying forever', async () => {
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			analysisController.applyDelta.mockResolvedValue(null);
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValue(true);

			updater.handleNoteChange({ id: 'a', event: 2 });
			for (let i = 0; i < 10; i++) {
				await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);
			}

			expect(analysisController.applyDelta).toHaveBeenCalledTimes(5);
			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('Giving up automatic retry after 5 consecutive')
			);
			expect(onRetriesExhausted).toHaveBeenCalledTimes(1);

			analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValue(false);
			updater.handleNoteChange({ id: 'b', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenLastCalledWith(
				expect.arrayContaining([note('a'), note('b')]),
				[]
			);
			consoleInfoSpy.mockRestore();
		});

		it('does not report retries exhausted when a retryable skip succeeds within the retry budget', async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			analysisController.applyDelta.mockResolvedValueOnce(null);
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValueOnce(true);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValue(false);
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onRetriesExhausted).not.toHaveBeenCalled();
		});

		it('folds a note edited again while its retryable skip is still pending into the same retry', async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			analysisController.applyDelta.mockResolvedValueOnce(null);
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValueOnce(true);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValue(false);

			updater.handleNoteChange({ id: 'c', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenLastCalledWith(
				expect.arrayContaining([note('a'), note('c')]),
				[]
			);
		});

		it('does not requeue a delta that applyDelta reports as a non-retryable null (a genuine no-op)', async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			analysisController.applyDelta.mockResolvedValueOnce(null);
			analysisController.wasLastDeltaSkippedForRetry.mockReturnValueOnce(false);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
			updater.handleNoteChange({ id: 'c', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenLastCalledWith([note('c')], []);
		});

		it('does not push a patch if applyDelta succeeds but no diff is available', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));
			analysisController.getLastDiff.mockReturnValue(null);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphPatch).not.toHaveBeenCalled();
		});

		it('treats a note that no longer exists by fetch time as a removal, not a dropped upsert', async () => {
			noteRepository.getNote.mockResolvedValue(null);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['a']);
		});

		it('falls back to a full reload if the debounced flush fails to fetch the changed note', async () => {
			noteRepository.getNote.mockRejectedValue(new Error('network error'));

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
			expect(analysisController.applyDelta).not.toHaveBeenCalled();
		});

		it('logs and requeues the delta when the full-reload fallback itself also fails, instead of dropping it silently', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			noteRepository.getNote.mockRejectedValue(new Error('network error'));
			onFullReloadNeeded.mockRejectedValueOnce(new Error('reload also failed'));

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Full-reload fallback also failed after an incremental flush error:',
				expect.any(Error)
			);

			noteRepository.getNote.mockImplementation(async (id) => note(id));
			onFullReloadNeeded.mockResolvedValue(undefined);
			updater.handleNoteChange({ id: 'b', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				expect.arrayContaining([note('a'), note('b')]),
				[]
			);
			consoleErrorSpy.mockRestore();
		});

		it('does not auto-reschedule after a double failure, but a later sync sweep still picks up the requeued id', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			noteRepository.getNote.mockRejectedValue(new Error('network error'));
			onFullReloadNeeded.mockRejectedValueOnce(new Error('reload also failed'));

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);
			jest.clearAllMocks();

			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS * 5);
			expect(analysisController.applyDelta).not.toHaveBeenCalled();

			noteRepository.getNote.mockImplementation(async (id) => note(id));
			onFullReloadNeeded.mockResolvedValue(undefined);
			await updater.handleSyncComplete();

			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], []);
			consoleErrorSpy.mockRestore();
		});

		it('pushes a second patch for Pass B enrichment after the Pass A patch, when enrichCurrentGraph finds something to label', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));
			const enrichedGraphData = { nodes: [], edges: [] };
			analysisController.enrichCurrentGraph.mockResolvedValue(enrichedGraphData);
			analysisController.getLastDiff.mockReturnValueOnce(fakeDiff).mockReturnValueOnce(fakeDiff);

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphPatch).toHaveBeenCalledTimes(2);
			expect(onGraphPatch).toHaveBeenNthCalledWith(1, fakeDiff, { nodes: [], edges: [] });
			expect(onGraphPatch).toHaveBeenNthCalledWith(2, fakeDiff, enrichedGraphData);
		});

		it('does not push a second patch when enrichCurrentGraph has nothing to label', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));
			analysisController.enrichCurrentGraph.mockResolvedValue(null);

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphPatch).toHaveBeenCalledTimes(1);
		});
	});

	describe('handleSelectionChange', () => {
		it('schedules an upsert refresh for each selected note', async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			updater.handleSelectionChange({ value: ['a', 'b'] });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).toHaveBeenCalledWith('a');
			expect(noteRepository.getNote).toHaveBeenCalledWith('b');
			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				expect.arrayContaining([note('a'), note('b')]),
				[]
			);
		});
	});

	describe('handleSyncComplete (AI off)', () => {
		it('does nothing when no note list has been loaded yet', async () => {
			analysisController.hasNotes.mockReturnValue(false);

			await updater.handleSyncComplete();

			expect(eventsRepository.getNoteEventsSince).not.toHaveBeenCalled();
		});

		it('sweeps with no cursor on the first-ever call and persists the returned baseline', async () => {
			eventsRepository.getNoteEventsSince.mockResolvedValue({ events: [], cursor: 'baseline-1' });

			await updater.handleSyncComplete();

			expect(eventsRepository.getNoteEventsSince).toHaveBeenCalledWith(undefined);
			expect(graphCache.saveEventsCursor).toHaveBeenCalledWith('baseline-1');
		});

		it('resumes from the persisted cursor on subsequent calls', async () => {
			graphCache.loadEventsCursor.mockResolvedValue('cursor-1');
			eventsRepository.getNoteEventsSince.mockResolvedValue({ events: [], cursor: 'cursor-2' });

			await updater.handleSyncComplete();

			expect(eventsRepository.getNoteEventsSince).toHaveBeenCalledWith('cursor-1');
		});

		it('applies created/updated events as upserts and deleted events as removals, then flushes immediately', async () => {
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [
					{ noteId: 'a', type: 'created' },
					{ noteId: 'b', type: 'updated' },
					{ noteId: 'c', type: 'deleted' },
				],
				cursor: 'cursor-2',
			});
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			await updater.handleSyncComplete();

			expect(noteRepository.getNote).toHaveBeenCalledWith('a');
			expect(noteRepository.getNote).toHaveBeenCalledWith('b');
			expect(noteRepository.getNote).not.toHaveBeenCalledWith('c');
			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				expect.arrayContaining([note('a'), note('b')]),
				['c']
			);
		});

		it('falls back to a full reload and does not persist a cursor when the sweep fails', async () => {
			eventsRepository.getNoteEventsSince.mockRejectedValue(new Error('network error'));

			await updater.handleSyncComplete();

			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
			expect(graphCache.saveEventsCursor).not.toHaveBeenCalled();
		});
	});

	describe('handleSyncComplete (AI on)', () => {
		beforeEach(() => {
			checkAiEnabled.mockResolvedValue(true);
		});

		it('schedules upserts from the embeddings cursor sweep, resuming from the persisted cursor', async () => {
			graphCache.loadEmbeddingsCursor.mockResolvedValue('embeddings-cursor-1');
			ai.getEmbeddings.mockResolvedValue({
				modelId: 'test-model',
				dimension: 2,
				chunks: [{ noteId: 'a', vector: [1, 0] }],
				nextCursor: undefined,
			});
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			await updater.handleSyncComplete();

			expect(ai.getEmbeddings).toHaveBeenCalledWith({ cursor: 'embeddings-cursor-1', limit: 1000 });
			expect(graphCache.saveEmbeddingsCursor).toHaveBeenCalledWith('embeddings-cursor-1');
			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], []);
		});

		it('walks multiple embeddings pages, accumulating note ids across them', async () => {
			ai.getEmbeddings
				.mockResolvedValueOnce({
					modelId: 'test-model',
					dimension: 2,
					chunks: [{ noteId: 'a', vector: [1, 0] }],
					nextCursor: 'page-2',
				})
				.mockResolvedValueOnce({
					modelId: 'test-model',
					dimension: 2,
					chunks: [{ noteId: 'b', vector: [0, 1] }],
					nextCursor: undefined,
				});
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			await updater.handleSyncComplete();

			expect(ai.getEmbeddings).toHaveBeenCalledTimes(2);
			expect(ai.getEmbeddings).toHaveBeenNthCalledWith(2, { cursor: 'page-2', limit: 1000 });
			expect(graphCache.saveEmbeddingsCursor).toHaveBeenCalledWith('page-2');
			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				expect.arrayContaining([note('a'), note('b')]),
				[]
			);
		});

		it('stops at the embeddings page safety cap, saving resumable progress instead of discarding the whole sweep', async () => {
			ai.getEmbeddings.mockImplementation(async ({ cursor }) => ({
				modelId: 'test-model',
				dimension: 2,
				chunks: [{ noteId: `note-${cursor ?? 'start'}`, vector: [1, 0] }],
				nextCursor: `next-${cursor ?? 'start'}`,
			}));
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			await updater.handleSyncComplete();

			expect(ai.getEmbeddings).toHaveBeenCalledTimes(500);
			expect(onFullReloadNeeded).not.toHaveBeenCalled();
			expect(graphCache.saveEmbeddingsCursor).toHaveBeenCalledWith(expect.any(String));
			expect(analysisController.applyDelta).toHaveBeenCalled();
		});

		it("only acts on /events' deleted entries, ignoring its created/updated entries since the embeddings sweep already covers those", async () => {
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [
					{ noteId: 'a', type: 'created' },
					{ noteId: 'b', type: 'deleted' },
				],
				cursor: 'events-cursor-2',
			});

			await updater.handleSyncComplete();

			expect(noteRepository.getNote).not.toHaveBeenCalledWith('a');
			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['b']);
		});

		it('falls back to /events upserts for this sync when the embeddings sweep fails, without a full reload', async () => {
			ai.getIndexStatus.mockResolvedValue({ ready: false, state: 'preparing', modelId: null });
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [{ noteId: 'a', type: 'updated' }],
				cursor: 'events-cursor-2',
			});
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			await updater.handleSyncComplete();

			expect(onFullReloadNeeded).not.toHaveBeenCalled();
			expect(graphCache.saveEmbeddingsCursor).not.toHaveBeenCalled();
			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], []);
		});

		it('still falls back to a full reload if the /events sweep itself also fails', async () => {
			ai.getIndexStatus.mockResolvedValue({ ready: false, state: 'preparing', modelId: null });
			eventsRepository.getNoteEventsSince.mockRejectedValue(new Error('network error'));

			await updater.handleSyncComplete();

			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
		});
	});

	describe('flush serialization', () => {
		it('never runs two applyDelta calls concurrently when a timer-driven flush overlaps a direct handleSyncComplete flush', async () => {
			let concurrentCalls = 0;
			let maxConcurrent = 0;
			let firstCallPending = true;
			let resolveFirstCall: () => void = () => undefined;

			analysisController.applyDelta.mockImplementation(() => {
				concurrentCalls++;
				maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
				if (firstCallPending) {
					firstCallPending = false;
					return new Promise((resolve) => {
						resolveFirstCall = () => {
							concurrentCalls--;
							resolve({ nodes: [], edges: [] });
						};
					});
				}
				concurrentCalls--;
				return Promise.resolve({ nodes: [], edges: [] });
			});
			noteRepository.getNote.mockImplementation(async (id) => note(id));

			updater.handleNoteChange({ id: 'a', event: 1 });
			jest.advanceTimersByTime(COALESCE_WINDOW_MS);
			await flushMicrotasks();
			expect(concurrentCalls).toBe(1);

			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [{ noteId: 'b', type: 'created' }],
				cursor: 'cursor-2',
			});
			const syncPromise = updater.handleSyncComplete();

			await flushMicrotasks();
			expect(concurrentCalls).toBe(1);

			resolveFirstCall();
			await syncPromise;

			expect(maxConcurrent).toBe(1);
			expect(analysisController.applyDelta).toHaveBeenCalledTimes(2);
		});
	});
});
