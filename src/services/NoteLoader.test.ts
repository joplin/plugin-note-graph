import joplin from 'api';
import { NoteLoader } from './NoteLoader';
import { NoteRepository } from '../data/NoteRepository';
import { NotePreprocessor } from '../data/NotePreprocessor';
import { LinkExtractor } from '../data/LinkExtractor';
import { TagRepository } from '../data/TagRepository';
import { Note } from '../data/Types';

function note(id: string, parentId = 'folder-a'): Note {
	return {
		id,
		parent_id: parentId,
		title: id,
		body: '',
		created_time: 0,
		updated_time: 1,
	};
}

describe('NoteLoader', () => {
	let getAllNotes: jest.Mock;
	let process: jest.Mock;
	let loader: NoteLoader;

	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);

		getAllNotes = jest.fn().mockResolvedValue({ notes: [note('n1')], truncated: false });
		process = jest.fn(async (notes: Note[]) => ({ notes, tagsComplete: true }));

		loader = new NoteLoader(
			{ getAllNotes } as unknown as NoteRepository,
			{ process } as unknown as NotePreprocessor
		);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('returns every note and reports the load complete when nothing failed', async () => {
		const loaded = await loader.load();

		expect(loaded.notes.map((n) => n.id)).toEqual(['n1']);
		expect(loaded.complete).toBe(true);
	});

	it('reports progress: first reading notes, then tags', async () => {
		process.mockImplementation(
			async (notes: Note[], onTagProgress: (d: number, t: number) => void) => {
				onTagProgress(500, 1000);
				return { notes, tagsComplete: true };
			}
		);
		const onProgress = jest.fn();

		await loader.load(onProgress);

		expect(onProgress.mock.calls).toEqual([
			[{ stage: 'notes' }],
			[{ stage: 'tags', done: 500, total: 1000 }],
		]);
	});

	it('reports the load incomplete when a note page failed', async () => {
		getAllNotes.mockResolvedValue({ notes: [note('n1')], truncated: true });

		const loaded = await loader.load();

		expect(loaded.notes).toHaveLength(1);
		expect(loaded.complete).toBe(false);
	});

	it('reports the load incomplete when the tag data was partial', async () => {
		process.mockImplementation(async (notes: Note[]) => ({ notes, tagsComplete: false }));

		const loaded = await loader.load();

		expect(loaded.complete).toBe(false);
	});

	it('throws when no notes could be read, rather than returning an empty graph', async () => {
		getAllNotes.mockResolvedValue({ notes: [], truncated: true });

		await expect(loader.load()).rejects.toThrow('No notes could be loaded');
		expect(process).not.toHaveBeenCalled();
	});

	it('treats an empty vault that loaded cleanly as complete', async () => {
		getAllNotes.mockResolvedValue({ notes: [], truncated: false });

		const loaded = await loader.load();

		expect(loaded.notes).toEqual([]);
		expect(loaded.complete).toBe(true);
	});
});

describe('NoteLoader with the real repositories', () => {
	const mockGet = joplin.data.get as jest.Mock;
	const linkedId = 'abcdef0123456789abcdef0123456789';

	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		mockGet.mockReset();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	const buildLoader = (): NoteLoader => {
		const noRetryDelay = { maxAttempts: 3, baseDelayMs: 0 };
		return new NoteLoader(
			new NoteRepository(noRetryDelay),
			new NotePreprocessor(new LinkExtractor(), new TagRepository(noRetryDelay))
		);
	};

	it('loads a vault containing a malformed link anchor and a note repeated across pages', async () => {
		mockGet.mockImplementation(async (path: string[], query: { page: number }) => {
			if (path[0] === 'tags') return { items: [], has_more: false };
			return query.page === 1
				? {
						items: [{ ...note('n1'), body: `[bad](:/${linkedId}#100%)` }, note('n2')],
						has_more: true,
				  }
				: { items: [note('n2'), note('n3')], has_more: false };
		});

		const loaded = await buildLoader().load();

		expect(loaded.complete).toBe(true);
		expect(loaded.notes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
		expect(loaded.notes[0].links).toEqual([linkedId]);
	});

	it('reports an incomplete load when the tag fetch keeps failing, but still returns the notes', async () => {
		mockGet.mockImplementation(async (path: string[]) => {
			if (path[0] === 'tags') throw new Error('network error');
			return { items: [note('n1')], has_more: false };
		});

		const loaded = await buildLoader().load();

		expect(loaded.notes.map((n) => n.id)).toEqual(['n1']);
		expect(loaded.complete).toBe(false);
	});
});
