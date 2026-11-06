import { Note } from './Types';
import { LinkExtractor } from './LinkExtractor';
import { TagRepository } from './TagRepository';
import { Logger, consoleLogger } from '../utils/Logger';

/** Bodies are only needed in full to extract links, so anything after this is dropped to keep every note in memory and in the cache small. */
export const BODY_EXCERPT_LENGTH = 600;

export class NotePreprocessor {
	private readonly linkExtractor: LinkExtractor;
	private readonly tagRepository: TagRepository;

	public constructor(
		linkExtractor = new LinkExtractor(),
		tagRepository = new TagRepository(),
		private readonly logger: Logger = consoleLogger
	) {
		this.linkExtractor = linkExtractor;
		this.tagRepository = tagRepository;
	}

	/**
	 * Enriches notes with their extracted links and tags.
	 * @param notes - raw notes fetched from the Joplin API.
	 * @param onTagProgress - told how many notes have had their tags read so far.
	 * @returns the same notes with `links` and `tags` populated and `body` cut to an excerpt, and whether the tag data was complete.
	 */
	public async process(
		notes: Note[],
		onTagProgress?: (done: number, total: number) => void
	): Promise<{ notes: Note[]; tagsComplete: boolean }> {
		const { map: noteTagsMap, truncated } = await this.tagRepository.getTagsForNotes(
			notes.map((note) => note.id),
			onTagProgress
		);
		if (truncated) {
			this.logger.error('Tag data is incomplete for this reload - some tag connections may be missing.');
		}

		return {
			notes: notes.map((note) => this.enrich(note, noteTagsMap[note.id] ?? [])),
			tagsComplete: !truncated,
		};
	}

	public async processOne(note: Note): Promise<Note> {
		const { titles, truncated } = await this.tagRepository.getTagsForNote(note.id);
		if (truncated) {
			throw new Error(`Could not fetch the complete tag list for note ${note.id}.`);
		}
		return this.enrich(note, titles);
	}

	private enrich(note: Note, tags: string[]): Note {
		const body = note.body ?? '';
		return {
			...note,
			body: body.slice(0, BODY_EXCERPT_LENGTH),
			links: this.linkExtractor.extractLinks(body),
			tags,
		};
	}
}
