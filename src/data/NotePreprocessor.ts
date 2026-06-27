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
		const { map: noteTagsMap } = await this.tagRepository.getNoteTagsMap();

		return notes.map((note) => ({
			...note,
			links: this.linkExtractor.extractLinks(note.body ?? ''),
			tags: noteTagsMap[note.id] ?? [],
		}));
	}
}
