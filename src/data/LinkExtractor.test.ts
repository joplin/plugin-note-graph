import { LinkExtractor, extractResourceUrls, isResourceUrl, parseResourceUrl } from './LinkExtractor';

describe('LinkExtractor', () => {
	let extractor: LinkExtractor;

	beforeEach(() => {
		extractor = new LinkExtractor();
	});

	it('extracts link from real Joplin inline format [title](:/id)', () => {
		const body = '[My Note](:/abcdef0123456789abcdef0123456789)';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('extracts link with anchor [title](:/id#section)', () => {
		const body = '[My Note](:/abcdef0123456789abcdef0123456789#introduction)';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('extracts multiple Joplin links from body', () => {
		const body =
			'See [Note A](:/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) and [Note B](:/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)';
		const links = extractor.extractLinks(body);
		expect(links).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		]);
	});

	it('extracts link from reference link format [title]: :/id', () => {
		const body = '[note]: :/abcdef0123456789abcdef0123456789\n';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('extracts link from html img tag', () => {
		const body = '<img src=":/abcdef0123456789abcdef0123456789">';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('extracts link from html anchor tag', () => {
		const body = '<a href=":/abcdef0123456789abcdef0123456789">click</a>';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('ignores html links with non-hex characters', () => {
		const body = '<a href=":/abcdef0123456789abcdef012345678g">click</a>';
		const links = extractor.extractLinks(body);
		expect(links).toEqual([]);
	});

	it('returns empty when no links', () => {
		expect(extractor.extractLinks('No links here')).toEqual([]);
	});

	it('handles empty body', () => {
		expect(extractor.extractLinks('')).toEqual([]);
	});

	it('ignores links with non-hex characters', () => {
		const body = '[note](:/abcdef0123456789abcdef012345678g)';
		const links = extractor.extractLinks(body);
		expect(links).toEqual([]);
	});

	it('deduplicates repeated links', () => {
		const body =
			'[a](:/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) [b](:/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
	});
});

describe('extractResourceUrls', () => {
	it('returns itemId and hash for link with anchor', () => {
		const body = '[My Note](:/abcdef0123456789abcdef0123456789#introduction)';
		const result = extractResourceUrls(body);
		expect(result).toEqual([
			{ itemId: 'abcdef0123456789abcdef0123456789', hash: 'introduction' },
		]);
	});

	it('returns empty hash when no anchor', () => {
		const body = '[My Note](:/abcdef0123456789abcdef0123456789)';
		const result = extractResourceUrls(body);
		expect(result).toEqual([
			{ itemId: 'abcdef0123456789abcdef0123456789', hash: '' },
		]);
	});

	it('returns empty array when no resource links', () => {
		expect(extractResourceUrls('No links here')).toEqual([]);
	});
});

describe('isResourceUrl', () => {
	it('returns true for :/ prefix', () => {
		expect(isResourceUrl(':/abcdef0123456789abcdef0123456789')).toBe(true);
	});

	it('returns true for joplin:// prefix', () => {
		expect(isResourceUrl('joplin://abcdef0123456789abcdef0123456789')).toBe(true);
	});

	it('returns false for https url', () => {
		expect(isResourceUrl('https://example.com')).toBe(false);
	});

	it('returns false for id with wrong length', () => {
		expect(isResourceUrl(':/abcdef')).toBe(false);
	});
});

describe('parseResourceUrl', () => {
	it('parses itemId with no hash', () => {
		expect(parseResourceUrl(':/abcdef0123456789abcdef0123456789')).toEqual({
			itemId: 'abcdef0123456789abcdef0123456789',
			hash: '',
		});
	});

	it('parses itemId and hash', () => {
		expect(parseResourceUrl(':/abcdef0123456789abcdef0123456789#section')).toEqual({
			itemId: 'abcdef0123456789abcdef0123456789',
			hash: 'section',
		});
	});

	it('returns null for invalid url', () => {
		expect(parseResourceUrl('https://example.com')).toBeNull();
	});

	it('returns null for non-hex id', () => {
		expect(parseResourceUrl(':/abcdef0123456789abcdef012345678g')).toBeNull();
	});
});
