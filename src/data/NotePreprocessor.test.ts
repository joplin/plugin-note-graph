import { NotePreprocessor } from './NotePreprocessor';
import { LinkExtractor } from './LinkExtractor';
import { TagRepository } from './TagRepository';

jest.mock('./LinkExtractor');
jest.mock('./TagRepository');

const MockLinkExtractor = LinkExtractor as jest.MockedClass<typeof LinkExtractor>;

const MockTagRepository = TagRepository as jest.MockedClass<typeof TagRepository>;

describe('NotePreprocessor', () => {
	let preprocessor: NotePreprocessor;
	let mockLinkExtractorInstance: jest.Mocked<LinkExtractor>;
	let mockTagRepositoryInstance: jest.Mocked<TagRepository>;

	beforeEach(() => {
		jest.clearAllMocks();

		mockLinkExtractorInstance = new MockLinkExtractor() as jest.Mocked<LinkExtractor>;

		mockTagRepositoryInstance = new MockTagRepository() as jest.Mocked<TagRepository>;

		preprocessor = new NotePreprocessor(mockLinkExtractorInstance, mockTagRepositoryInstance);
	});

	it('enriches notes with links and tags', async () => {
		mockLinkExtractorInstance.extractLinks.mockReturnValue(['abc']);

		mockTagRepositoryInstance.getNoteTagsMap.mockResolvedValue({
			map: {
				note1: ['tag1'],
			},
			truncated: false,
		});

		const notes = [
			{
				id: 'note1',
				parent_id: 'p1',
				title: 'Test',
				body: 'body :/abc',
				created_time: 0,
				updated_time: 1,
			},
		];

		const result = await preprocessor.process(notes);

		expect(result).toHaveLength(1);

		expect(result[0]).toMatchObject({
			id: 'note1',
			links: ['abc'],
			tags: ['tag1'],
		});

		expect(mockLinkExtractorInstance.extractLinks).toHaveBeenCalledWith('body :/abc');

		expect(mockTagRepositoryInstance.getNoteTagsMap).toHaveBeenCalled();
	});

	it('logs, but still returns notes, when the bulk tag fetch was truncated', async () => {
		const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		mockLinkExtractorInstance.extractLinks.mockReturnValue([]);
		mockTagRepositoryInstance.getNoteTagsMap.mockResolvedValue({ map: {}, truncated: true });

		const notes = [
			{
				id: 'n1',
				parent_id: 'p1',
				title: 'Test',
				body: '',
				created_time: 0,
				updated_time: 1,
			},
		];

		const result = await preprocessor.process(notes);

		expect(result).toHaveLength(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Tag data is incomplete')
		);
		consoleErrorSpy.mockRestore();
	});

	it('handles notes with no links and no tags', async () => {
		mockLinkExtractorInstance.extractLinks.mockReturnValue([]);

		mockTagRepositoryInstance.getNoteTagsMap.mockResolvedValue({ map: {}, truncated: false });

		const notes = [
			{
				id: 'n1',
				parent_id: 'p1',
				title: 'No links',
				body: 'Hello',
				created_time: 0,
				updated_time: 1,
			},
		];

		const result = await preprocessor.process(notes);

		expect(result[0]).toMatchObject({
			id: 'n1',
			links: [],
			tags: [],
		});
	});

	it('handles undefined body', async () => {
		mockLinkExtractorInstance.extractLinks.mockReturnValue([]);

		mockTagRepositoryInstance.getNoteTagsMap.mockResolvedValue({ map: {}, truncated: false });

		const notes = [
			{
				id: 'n1',
				parent_id: 'p1',
				title: 'No body',
				body: undefined,
				created_time: 0,
				updated_time: 1,
			} as any,
		];

		const result = await preprocessor.process(notes);

		expect(result[0].links).toEqual([]);

		expect(mockLinkExtractorInstance.extractLinks).toHaveBeenCalledWith('');
	});

	describe('processOne', () => {
		it('enriches a single note using a scoped tag lookup, not the full map', async () => {
			mockLinkExtractorInstance.extractLinks.mockReturnValue(['abc']);
			mockTagRepositoryInstance.getTagsForNote.mockResolvedValue({
				titles: ['tag1'],
				truncated: false,
			});

			const note = {
				id: 'note1',
				parent_id: 'p1',
				title: 'Test',
				body: 'body :/abc',
				created_time: 0,
				updated_time: 1,
			};

			const result = await preprocessor.processOne(note);

			expect(result).toMatchObject({ id: 'note1', links: ['abc'], tags: ['tag1'] });
			expect(mockTagRepositoryInstance.getTagsForNote).toHaveBeenCalledWith('note1');
			expect(mockTagRepositoryInstance.getNoteTagsMap).not.toHaveBeenCalled();
		});

		it('throws instead of silently committing a truncated tag list', async () => {
			mockLinkExtractorInstance.extractLinks.mockReturnValue([]);
			mockTagRepositoryInstance.getTagsForNote.mockResolvedValue({
				titles: ['tag1'],
				truncated: true,
			});

			const note = {
				id: 'note1',
				parent_id: 'p1',
				title: 'Test',
				body: '',
				created_time: 0,
				updated_time: 1,
			};

			await expect(preprocessor.processOne(note)).rejects.toThrow(/note1/);
		});
	});
});
