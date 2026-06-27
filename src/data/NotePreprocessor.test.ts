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
});
