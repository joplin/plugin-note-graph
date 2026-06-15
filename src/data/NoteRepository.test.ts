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

		const notes = await repo.getAllNotes();

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

		const notes = await repo.getAllNotes();

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

		const notes = await repo.getAllNotes();

		expect(notes).toEqual([]);
	});

	it('requests correct fields and pagination', async () => {
		mockGet.mockResolvedValueOnce({
			items: [],
			has_more: false,
		});

		await repo.getAllNotes();

		expect(mockGet).toHaveBeenCalledWith(['notes'], {
			fields: ['id', 'parent_id', 'title', 'body', 'created_time', 'updated_time'],
			limit: 100,
			page: 1,
		});
	});

	it('handles missing items in response gracefully', async () => {
		mockGet.mockResolvedValueOnce({
			has_more: false,
		});

		const notes = await repo.getAllNotes();

		expect(notes).toEqual([]);
	});
});
