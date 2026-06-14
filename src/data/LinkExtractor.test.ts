import { LinkExtractor } from './LinkExtractor';

describe('LinkExtractor', () => {
	let extractor: LinkExtractor;

	beforeEach(() => {
		extractor = new LinkExtractor();
	});

	it('extracts links from body', () => {
		const body = 'Some text :/abcdef0123456789abcdef0123456789 more text';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['abcdef0123456789abcdef0123456789']);
	});

	it('extracts multiple links', () => {
		const body =
			'Link1 :/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa link2 :/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
		const links = extractor.extractLinks(body);
		expect(links).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		]);
	});

	it('returns empty when no links', () => {
		expect(extractor.extractLinks('No links here')).toEqual([]);
	});

	it('handles empty body', () => {
		expect(extractor.extractLinks('')).toEqual([]);
	});

	it('handles case insensitivity for hex digits', () => {
		const body = ':/ABCDEF0123456789abcdef0123456789';
		const links = extractor.extractLinks(body);
		expect(links).toEqual(['ABCDEF0123456789abcdef0123456789']);
	});

	it('ignores links with non-hex characters', () => {
		const body = ':/abcdef0123456789abcdef012345678g';
		const links = extractor.extractLinks(body);
		expect(links).toEqual([]);
	});
});
