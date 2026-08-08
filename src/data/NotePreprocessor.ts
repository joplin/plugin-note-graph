import { Note } from './Types';
import { LinkExtractor } from './LinkExtractor';
import { TagRepository } from './TagRepository';

export class NotePreprocessor {
	private readonly linkExtractor: LinkExtractor;
	private readonly tagRepository: TagRepository;

	public constructor(linkExtractor = new LinkExtractor(), tagRepository = new TagRepository()) {
		this.linkExtractor = linkExtractor;
		this.tagRepository = tagRepository;
	}

	/**
	 * Enriches notes with their extracted links and tags.
	 * @param notes - raw notes fetched from the Joplin API.
	 * @returns the same notes with `links` and `tags` populated.
	 */
	public async process(notes: Note[]): Promise<Note[]> {
		const { map: noteTagsMap, truncated } = await this.tagRepository.getNoteTagsMap();
		if (truncated) {
			console.error('Tag data is incomplete for this reload - some tag connections may be missing.');
		}

		return notes.map((note) => ({
			...note,
			links: this.linkExtractor.extractLinks(note.body ?? ''),
			tags: noteTagsMap[note.id] ?? [],
		}));
	}

	public async processOne(note: Note): Promise<Note> {
		const { titles, truncated } = await this.tagRepository.getTagsForNote(note.id);
		if (truncated) {
			throw new Error(`Could not fetch the complete tag list for note ${note.id}.`);
		}
		return {
			...note,
			links: this.linkExtractor.extractLinks(note.body ?? ''),
			tags: titles,
		};
	}
}
