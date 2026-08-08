import joplin from 'api';

export type NoteChangeType = 'created' | 'updated' | 'deleted';

export interface NoteEvent {
	noteId: string;
	type: NoteChangeType;
}

const NOTE_ITEM_TYPE = 1;

const EVENT_TYPE_BY_CODE: Record<number, NoteChangeType> = {
	1: 'created',
	2: 'updated',
	3: 'deleted',
};

interface EventItem {
	item_type: number;
	item_id: string;
	type: number;
}

interface EventsPage {
	items?: EventItem[];
	cursor?: string;
	has_more?: boolean;
}

export class EventsRepository {
	private static readonly MAX_PAGES = 50;

	public async getNoteEventsSince(
		cursor?: string
	): Promise<{ events: NoteEvent[]; cursor: string | undefined }> {
		const latestByNoteId = new Map<string, NoteChangeType>();
		let currentCursor = cursor;
		let pageCount = 0;

		while (pageCount < EventsRepository.MAX_PAGES) {
			pageCount++;
			const query = currentCursor ? { cursor: currentCursor } : {};
			const response: EventsPage = await joplin.data.get(['events'], query);

			for (const item of response.items ?? []) {
				if (item.item_type !== NOTE_ITEM_TYPE) continue;
				const type = EVENT_TYPE_BY_CODE[item.type];
				if (!type) continue;
				latestByNoteId.set(item.item_id, type);
			}

			currentCursor = response.cursor;
			if (response.has_more !== true) break;
		}

		if (pageCount >= EventsRepository.MAX_PAGES) {
			console.info(
				`Events sweep hit the ${EventsRepository.MAX_PAGES}-page safety cap; remaining events will be picked up on the next sync.`
			);
		}

		return {
			events: Array.from(latestByNoteId, ([noteId, type]) => ({ noteId, type })),
			cursor: currentCursor,
		};
	}
}
