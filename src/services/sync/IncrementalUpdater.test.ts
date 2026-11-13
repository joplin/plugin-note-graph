import joplin from 'api';
import { IncrementalUpdater } from './IncrementalUpdater';
import { AnalysisController } from '../AnalysisController';
import { NoteRepository } from '../../data/NoteRepository';
import { NotePreprocessor } from '../../data/NotePreprocessor';
import { EventsRepository } from '../../data/EventsRepository';
import { GraphCacheRepository } from '../../data/Database/GraphCacheRepository';
import { Note } from '../../data/Types';
import { GraphData } from '../graph/types';

jest.mock('../AnalysisController');
jest.mock('../../data/NoteRepository');
jest.mock('../../data/NotePreprocessor');
jest.mock('../../data/EventsRepository');
jest.mock('../../data/Database/GraphCacheRepository');

const MockAnalysisController = AnalysisController as jest.MockedClass<typeof AnalysisController>;
const MockNoteRepository = NoteRepository as jest.MockedClass<typeof NoteRepository>;
const MockPreprocessor = NotePreprocessor as jest.MockedClass<typeof NotePreprocessor>;
const MockEventsRepository = EventsRepository as jest.MockedClass<typeof EventsRepository>;
const MockGraphCacheRepository = GraphCacheRepository as jest.MockedClass<
	typeof GraphCacheRepository
>;

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
	let onGraphChanged: jest.Mock;
	let onFullReloadNeeded: jest.Mock;
	let checkAiEnabled: jest.Mock<Promise<boolean>, []>;
	let changeDetector: { detect: jest.Mock };
	let ai: { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };
	let updater: IncrementalUpdater;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();

		analysisController = new MockAnalysisController() as jest.Mocked<AnalysisController>;
		analysisController.hasNotes.mockReturnValue(true);
		analysisController.applyDelta.mockResolvedValue({ nodes: [], edges: [] });
		analysisController.refreshStaleVectors.mockResolvedValue(null);

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

		onGraphChanged = jest.fn();
		onFullReloadNeeded = jest.fn().mockResolvedValue(undefined);
		checkAiEnabled = jest.fn().mockResolvedValue(false);
		changeDetector = { detect: jest.fn().mockResolvedValue({ noteIds: [], modelChanged: false }) };

		ai = joplin.ai as unknown as { getIndexStatus: jest.Mock; getEmbeddings: jest.Mock };
		ai.getIndexStatus.mockResolvedValue({ ready: true, state: 'ready', modelId: 'test-model' });
		ai.getEmbeddings.mockResolvedValue({
			modelId: 'test-model',
			dimension: 2,
			chunks: [],
			nextCursor: undefined,
		});

		updater = new IncrementalUpdater({
			analysisController,
			onGraphChanged,
			onFullReloadNeeded,
			noteRepository,
			preprocessor,
			eventsRepository,
			graphCache,
			changeDetector,
			coalesceWindowMs: COALESCE_WINDOW_MS,
			checkAiEnabled,
		});
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
			expect(onGraphChanged).toHaveBeenCalledWith({ nodes: [], edges: [] });
		});

		it('logs a summary once a new note is successfully upserted', async () => {
			const consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
			noteRepository.getNote.mockResolvedValue(note('a'));

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				'Incremental update applied: 1 upserted, 0 removed.'
			);
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

			expect(onGraphChanged).not.toHaveBeenCalled();
			expect(consoleInfoSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Incremental update applied')
			);
			consoleInfoSpy.mockRestore();
		});

		it('reloads instead of fetching each note when a very large number changed', async () => {
			jest.spyOn(console, 'info').mockImplementation(() => undefined);
			for (let i = 0; i <= 1000; i++) {
				updater.handleNoteChange({ id: `n${i}`, event: 2 });
			}
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(noteRepository.getNote).not.toHaveBeenCalled();
			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
			jest.restoreAllMocks();
		});

		it('treats a note that no longer exists by fetch time as a removal, not a dropped upsert', async () => {
			noteRepository.getNote.mockResolvedValue(null);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['a']);
		});

		it('checks the note just left, because moving a note stops it being selected', async () => {
			noteRepository.getNote.mockImplementation(async (id: string) =>
				id === 'moved' ? { ...note('moved'), parent_id: 'other-folder' } : note(id)
			);
			updater.handleSelectionChange({ value: ['moved'] });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);
			analysisController.applyDelta.mockClear();

			updater.handleSelectionChange({ value: ['next'] });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				[{ ...note('moved'), parent_id: 'other-folder' }, note('next')],
				[]
			);
		});

		it('keeps a note moved to another notebook in the graph, with its new notebook', async () => {
			noteRepository.getNote.mockResolvedValue({ ...note('a'), parent_id: 'other-folder' });

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledWith(
				[{ ...note('a'), parent_id: 'other-folder' }],
				[]
			);
		});

		it('falls back to a full reload if the debounced flush fails to fetch the changed note', async () => {
			noteRepository.getNote.mockRejectedValue(new Error('network error'));

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
			expect(analysisController.applyDelta).not.toHaveBeenCalled();
		});

		it('reports a failed update to the logger it was given', async () => {
			const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
			updater = new IncrementalUpdater({
				analysisController,
				onGraphChanged,
				onFullReloadNeeded,
				noteRepository,
				preprocessor,
				eventsRepository,
				graphCache,
				changeDetector,
				coalesceWindowMs: COALESCE_WINDOW_MS,
				checkAiEnabled,
				logger,
			});
			const error = new Error('network error');
			noteRepository.getNote.mockRejectedValue(error);

			updater.handleNoteChange({ id: 'a', event: 2 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(logger.error).toHaveBeenCalledWith(
				'Incremental flush failed, falling back to a full reload:',
				error
			);
		});

		it('logs and requeues the delta when the full-reload fallback itself also fails, instead of dropping it silently', async () => {
			const consoleErrorSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => undefined);
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
			const consoleErrorSpy = jest
				.spyOn(console, 'error')
				.mockImplementation(() => undefined);
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

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphChanged).toHaveBeenCalledTimes(2);
			expect(onGraphChanged).toHaveBeenNthCalledWith(1, { nodes: [], edges: [] });
			expect(onGraphChanged).toHaveBeenNthCalledWith(2, enrichedGraphData);
		});

		it('does not push a second patch when enrichCurrentGraph has nothing to label', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));
			analysisController.enrichCurrentGraph.mockResolvedValue(null);

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphChanged).toHaveBeenCalledTimes(1);
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
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [],
				cursor: 'baseline-1',
			});

			await updater.handleSyncComplete();

			expect(eventsRepository.getNoteEventsSince).toHaveBeenCalledWith(undefined);
			expect(graphCache.saveEventsCursor).toHaveBeenCalledWith('baseline-1');
		});

		it('resumes from the persisted cursor on subsequent calls', async () => {
			graphCache.loadEventsCursor.mockResolvedValue('cursor-1');
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [],
				cursor: 'cursor-2',
			});

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

	describe('reconcileWithVault', () => {
		beforeEach(() => {
			analysisController.getCurrentNotes.mockReturnValue([note('a', 1), note('b', 1)]);
			noteRepository.getNote.mockImplementation(async (id) => note(id, 2));
		});

		it('removes a note in memory that the vault no longer has', async () => {
			noteRepository.getNoteVersions.mockResolvedValue({
				versions: new Map([['a', 1]]),
				complete: true,
			});

			await updater.reconcileWithVault();

			expect(analysisController.applyDelta).toHaveBeenCalledWith([], ['b']);
		});

		it('adds a note the vault has and memory does not, and refreshes a changed one', async () => {
			noteRepository.getNoteVersions.mockResolvedValue({
				versions: new Map([
					['a', 1],
					['b', 2],
					['c', 2],
				]),
				complete: true,
			});

			await updater.reconcileWithVault();

			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('b', 2), note('c', 2)], []);
		});

		it('does nothing when everything already matches', async () => {
			noteRepository.getNoteVersions.mockResolvedValue({
				versions: new Map([
					['a', 1],
					['b', 1],
				]),
				complete: true,
			});

			await updater.reconcileWithVault();

			expect(analysisController.applyDelta).not.toHaveBeenCalled();
		});

		it('removes nothing when the list from Joplin is incomplete', async () => {
			jest.spyOn(console, 'info').mockImplementation(() => undefined);
			noteRepository.getNoteVersions.mockResolvedValue({ versions: new Map(), complete: false });

			await updater.reconcileWithVault();

			expect(analysisController.applyDelta).not.toHaveBeenCalled();
			jest.restoreAllMocks();
		});

		it('does nothing before a graph has been loaded', async () => {
			analysisController.hasNotes.mockReturnValue(false);

			await updater.reconcileWithVault();

			expect(noteRepository.getNoteVersions).not.toHaveBeenCalled();
		});
	});

	describe('embedding sweeps', () => {
		beforeEach(() => {
			checkAiEnabled.mockResolvedValue(true);
		});

		it('marks the notes Joplin re-embedded, then refreshes them and publishes the result', async () => {
			const refreshed = { nodes: [], edges: [] };
			changeDetector.detect.mockResolvedValue({ noteIds: ['a', 'b'], modelChanged: false });
			analysisController.refreshStaleVectors.mockResolvedValue(refreshed);

			await updater.handleEmbeddingTick();

			expect(analysisController.markVectorsStale).toHaveBeenCalledWith(['a', 'b']);
			expect(onGraphChanged).toHaveBeenCalledWith(refreshed);
		});

		it('on the first sweep, marks only notes with no vector, not everything it saw', async () => {
			changeDetector.detect.mockResolvedValue({ noteIds: ['a', 'b'], modelChanged: false, isBaseline: true });

			await updater.handleEmbeddingTick();

			expect(analysisController.markOutdatedVectorsStale).toHaveBeenCalledWith(['a', 'b']);
			expect(analysisController.markVectorsStale).not.toHaveBeenCalled();
		});

		it('publishes nothing when the refresh found no real change', async () => {
			changeDetector.detect.mockResolvedValue({ noteIds: ['a'], modelChanged: false });

			await updater.handleEmbeddingTick();

			expect(onGraphChanged).not.toHaveBeenCalled();
		});

		it('still retries notes left marked from an earlier attempt, when this sweep found none', async () => {
			await updater.handleEmbeddingTick();

			expect(analysisController.refreshStaleVectors).toHaveBeenCalledTimes(1);
		});

		it('does nothing with AI analysis off', async () => {
			checkAiEnabled.mockResolvedValue(false);

			await updater.handleEmbeddingTick();

			expect(changeDetector.detect).not.toHaveBeenCalled();
		});

		it('does nothing before a graph has been loaded', async () => {
			analysisController.hasNotes.mockReturnValue(false);

			await updater.handleEmbeddingTick();

			expect(changeDetector.detect).not.toHaveBeenCalled();
		});

		it('reloads fully when the embedding model changed', async () => {
			changeDetector.detect.mockResolvedValue({ noteIds: [], modelChanged: true });

			await updater.handleEmbeddingTick();

			expect(onFullReloadNeeded).toHaveBeenCalledTimes(1);
			expect(analysisController.refreshStaleVectors).not.toHaveBeenCalled();
		});

		it('does not sweep again within the minimum interval', async () => {
			await updater.handleEmbeddingTick();
			await updater.handleEmbeddingTick();
			expect(changeDetector.detect).toHaveBeenCalledTimes(1);

			jest.setSystemTime(Date.now() + 151 * 1000);
			await updater.handleEmbeddingTick();
			expect(changeDetector.detect).toHaveBeenCalledTimes(2);
		});

		it('does not start a second sweep while one is running', async () => {
			let finish: (value: { noteIds: string[]; modelChanged: boolean }) => void = () => undefined;
			changeDetector.detect.mockReturnValue(
				new Promise((resolve) => {
					finish = resolve;
				})
			);

			const first = updater.handleEmbeddingTick();
			await flushMicrotasks();
			await updater.handleEmbeddingTick();
			finish({ noteIds: [], modelChanged: false });
			await first;

			expect(changeDetector.detect).toHaveBeenCalledTimes(1);
		});

		it('logs a failed sweep without a full reload, and retries sooner than the interval', async () => {
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			changeDetector.detect.mockRejectedValueOnce(new Error('network'));

			await updater.handleEmbeddingTick();
			expect(onFullReloadNeeded).not.toHaveBeenCalled();

			await updater.handleEmbeddingTick();
			expect(changeDetector.detect).toHaveBeenCalledTimes(2);
			errorSpy.mockRestore();
		});

		it('a failed sweep does not stop a sync from applying /events changes', async () => {
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
			changeDetector.detect.mockRejectedValue(new Error('network'));
			noteRepository.getNote.mockResolvedValue(note('a'));
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [{ noteId: 'a', type: 'updated' }],
				cursor: 'c',
			});

			await updater.handleSyncComplete();

			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], []);
			expect(onFullReloadNeeded).not.toHaveBeenCalled();
			errorSpy.mockRestore();
		});

		it('applies /events changes on sync with AI on, since edits no longer come from the chunk stream', async () => {
			noteRepository.getNote.mockResolvedValue(note('a'));
			eventsRepository.getNoteEventsSince.mockResolvedValue({
				events: [
					{ noteId: 'a', type: 'updated' },
					{ noteId: 'gone', type: 'deleted' },
				],
				cursor: 'c',
			});

			await updater.handleSyncComplete();

			expect(analysisController.applyDelta).toHaveBeenCalledWith([note('a')], ['gone']);
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

		it("applies a second flush's Pass A patch without waiting for an earlier flush's slow Pass B enrichment", async () => {
			noteRepository.getNote.mockImplementation(async (id) => note(id));
			let resolveFirstEnrich: (value: GraphData | null) => void = () => undefined;
			let enrichCalls = 0;
			analysisController.enrichCurrentGraph.mockImplementation(() => {
				enrichCalls++;
				if (enrichCalls === 1) {
					return new Promise((resolve) => {
						resolveFirstEnrich = resolve;
					});
				}
				return Promise.resolve(null);
			});

			updater.handleNoteChange({ id: 'a', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(onGraphChanged).toHaveBeenCalledTimes(1);
			expect(enrichCalls).toBe(1);

			updater.handleNoteChange({ id: 'b', event: 1 });
			await jest.advanceTimersByTimeAsync(COALESCE_WINDOW_MS);

			expect(analysisController.applyDelta).toHaveBeenCalledTimes(2);
			expect(onGraphChanged).toHaveBeenCalledTimes(2);

			resolveFirstEnrich(null);
			await flushMicrotasks();
		});
	});
});
