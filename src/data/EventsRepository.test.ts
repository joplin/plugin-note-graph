import { EventsRepository } from './EventsRepository';
import joplin from 'api';

const mockGet = joplin.data.get as jest.Mock;

describe('EventsRepository', () => {
	let repo: EventsRepository;

	beforeEach(() => {
		repo = new EventsRepository();
		jest.clearAllMocks();
	});

	it('returns no items and a baseline cursor on a first-ever call, without sending an undefined cursor', async () => {
		mockGet.mockResolvedValueOnce({ items: [], cursor: 'baseline-1', has_more: false });

		const { events, cursor } = await repo.getNoteEventsSince();

		expect(events).toEqual([]);
		expect(cursor).toBe('baseline-1');
		expect(mockGet).toHaveBeenCalledWith(['events'], {});
	});

	it('maps created/updated/deleted event codes to readable types', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{ item_type: 1, item_id: 'n1', type: 1 },
				{ item_type: 1, item_id: 'n2', type: 2 },
				{ item_type: 1, item_id: 'n3', type: 3 },
			],
			cursor: 'c2',
			has_more: false,
		});

		const { events } = await repo.getNoteEventsSince('c1');

		expect(events).toEqual(
			expect.arrayContaining([
				{ noteId: 'n1', type: 'created' },
				{ noteId: 'n2', type: 'updated' },
				{ noteId: 'n3', type: 'deleted' },
			])
		);
		expect(mockGet).toHaveBeenCalledWith(['events'], { cursor: 'c1' });
	});

	it('ignores events for item types other than notes', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{ item_type: 2, item_id: 'folder1', type: 2 },
				{ item_type: 1, item_id: 'n1', type: 2 },
			],
			cursor: 'c2',
			has_more: false,
		});

		const { events } = await repo.getNoteEventsSince('c1');

		expect(events).toEqual([{ noteId: 'n1', type: 'updated' }]);
	});

	it('keeps only the latest event per note across the swept window', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{ item_type: 1, item_id: 'n1', type: 1 },
				{ item_type: 1, item_id: 'n1', type: 2 },
			],
			cursor: 'c2',
			has_more: false,
		});

		const { events } = await repo.getNoteEventsSince('c1');

		expect(events).toEqual([{ noteId: 'n1', type: 'updated' }]);
	});

	it('nets a created-then-deleted note to deleted', async () => {
		mockGet.mockResolvedValueOnce({
			items: [
				{ item_type: 1, item_id: 'n1', type: 1 },
				{ item_type: 1, item_id: 'n1', type: 3 },
			],
			cursor: 'c2',
			has_more: false,
		});

		const { events } = await repo.getNoteEventsSince('c1');

		expect(events).toEqual([{ noteId: 'n1', type: 'deleted' }]);
	});

	it('pages through multiple event pages, resuming with each returned cursor', async () => {
		mockGet
			.mockResolvedValueOnce({
				items: [{ item_type: 1, item_id: 'n1', type: 2 }],
				cursor: 'c2',
				has_more: true,
			})
			.mockResolvedValueOnce({
				items: [{ item_type: 1, item_id: 'n2', type: 1 }],
				cursor: 'c3',
				has_more: false,
			});

		const { events, cursor } = await repo.getNoteEventsSince('c1');

		expect(events).toEqual(
			expect.arrayContaining([
				{ noteId: 'n1', type: 'updated' },
				{ noteId: 'n2', type: 'created' },
			])
		);
		expect(cursor).toBe('c3');
		expect(mockGet).toHaveBeenNthCalledWith(1, ['events'], { cursor: 'c1' });
		expect(mockGet).toHaveBeenNthCalledWith(2, ['events'], { cursor: 'c2' });
	});

	it('stops at the page safety cap and returns the cursor reached so far', async () => {
		mockGet.mockResolvedValue({
			items: [{ item_type: 1, item_id: 'n1', type: 2 }],
			cursor: 'still-going',
			has_more: true,
		});

		const { cursor } = await repo.getNoteEventsSince('c1');

		expect(cursor).toBe('still-going');
		expect(mockGet).toHaveBeenCalledTimes(50);
	});

	it('propagates a fetch failure instead of swallowing it', async () => {
		mockGet.mockRejectedValueOnce(new Error('network error'));

		await expect(repo.getNoteEventsSince('c1')).rejects.toThrow('network error');
	});
});
