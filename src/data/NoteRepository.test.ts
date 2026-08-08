import { NoteRepository } from './NoteRepository';
import joplin from 'api';

const mockGet = joplin.data.get as jest.Mock;

describe('NoteRepository', () => {
	let repo: NoteRepository;

	beforeEach(() => {
		repo = new NoteRepository();
		jest.clearAllMocks();
	});

	it('fetches all notes when single page', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{
					id: '1',
					parent_id: 'p1',
					title: 'Note 1',
					body: 'Body',
					created_time: 100,
					updated_time: 200,
				},
			],
			has_more: false,
		});

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(false);
		expect(notes).toHaveLength(1);
		expect(notes[0].id).toBe('1');
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it('fetches all notes across multiple pages', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ id: '1' }, { id: '2' }],
				has_more: true,
			})
			.mockResolvedValueOnce({
				items: [{ id: '3' }],
				has_more: false,
			});

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(false);
		expect(notes).toHaveLength(3);
		expect(notes[0].id).toBe('1');
		expect(notes[2].id).toBe('3');
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it('returns empty array when no notes', async () => {
		mockGet.mockResolvedValueOnce({
			items: [],
			has_more: false,
		});

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(false);
		expect(notes).toEqual([]);
	});

	it('requests correct fields and pagination', async () => {
		mockGet.mockResolvedValueOnce({
			items: [],
			has_more: false,
		});

		await repo.getAllNotes();

		expect(mockGet).toHaveBeenCalledWith(['notes'], {
			fields: ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'deleted_time'],
			limit: 100,
			page: 1,
		});
	});

	it('filters out notes that are in the trash', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{ id: '1', deleted_time: 0 },
				{ id: '2', deleted_time: 1700000000000 },
				{ id: '3', deleted_time: 0 },
			],
			has_more: false,
		});

		const { notes } = await repo.getAllNotes();

		expect(notes.map((n) => n.id)).toEqual(['1', '3']);
	});

	it('handles missing items in response gracefully', async () => {
		mockGet.mockResolvedValueOnce({
			has_more: false,
		});

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(false);
		expect(notes).toEqual([]);
	});

	it('returns collected notes with truncated flag when a page fails', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ id: '1' }, { id: '2' }],
				has_more: true,
			})
			.mockRejectedValueOnce(new Error('network error'));

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(true);
		expect(notes).toHaveLength(2);
		expect(notes[0].id).toBe('1');
		expect(notes[1].id).toBe('2');
		expect(mockGet).toHaveBeenCalledTimes(2);
	});

	it('returns empty notes with truncated true when first page fails', async () => {
		mockGet.mockRejectedValueOnce(new Error('network error'));

		const { notes, truncated } = await repo.getAllNotes();

		expect(truncated).toBe(true);
		expect(notes).toEqual([]);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	it('stops at maxNotes and returns truncated true', async () => {
		mockGet.mockResolvedValueOnce({
			items: Array.from({ length: 50 }, (_, i) => ({ id: `${i + 1}` })),
			has_more: true,
		});

		const { notes, truncated } = await repo.getAllNotes(30);

		expect(truncated).toBe(true);
		expect(notes).toHaveLength(30);
		expect(mockGet).toHaveBeenCalledTimes(1);
		expect(mockGet).toHaveBeenCalledWith(['notes'], expect.objectContaining({ limit: 30 }));
	});

	it('does not call API if maxNotes already met from previous page', async () => {
		mockGet.mockResolvedValueOnce({
			items: [{ id: '1' }, { id: '2' }],
			has_more: true,
		});

		const { notes, truncated } = await repo.getAllNotes(2);

		expect(truncated).toBe(true);
		expect(notes).toHaveLength(2);
		expect(mockGet).toHaveBeenCalledTimes(1);
	});

	describe('getNote', () => {
		it('fetches a single note by ID with the standard fields', async () => {
			mockGet.mockResolvedValueOnce({
				id: '1',
				parent_id: 'p1',
				title: 'Note 1',
				body: 'Body',
				created_time: 100,
				updated_time: 200,
				deleted_time: 0,
			});

			const note = await repo.getNote('1');

			expect(note).toMatchObject({ id: '1', title: 'Note 1' });
			expect(mockGet).toHaveBeenCalledWith(['notes', '1'], {
				fields: ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time', 'deleted_time'],
			});
		});

		it('returns null when the note no longer exists', async () => {
			mockGet.mockRejectedValueOnce(new Error('Not Found'));

			const note = await repo.getNote('missing');

			expect(note).toBeNull();
		});

		it('returns null when the note has been moved to the trash', async () => {
			mockGet.mockResolvedValueOnce({ id: '1', deleted_time: 1700000000000 });

			const note = await repo.getNote('1');

			expect(note).toBeNull();
		});

		it('rethrows when the fetch fails for a reason other than the note being deleted', async () => {
			mockGet.mockRejectedValueOnce(new Error('network error'));

			await expect(repo.getNote('1')).rejects.toThrow('network error');
		});
	});
});
