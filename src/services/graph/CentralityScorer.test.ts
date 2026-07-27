import { CentralityScorer } from './CentralityScorer';

describe('CentralityScorer', () => {
	let scorer: CentralityScorer;

	beforeEach(() => {
		scorer = new CentralityScorer();
	});

	it('returns an empty map for an empty degree map', () => {
		expect(scorer.score(new Map())).toEqual(new Map());
	});

	it('gives every note the same mid-range size when all degrees are equal', () => {
		const result = scorer.score(
			new Map([
				['a', 3],
				['b', 3],
				['c', 3],
			])
		);
		expect(result.get('a')).toBe(5);
		expect(result.get('b')).toBe(5);
		expect(result.get('c')).toBe(5);
	});

	it('scales the least connected note to 1 and the most connected to 10', () => {
		const result = scorer.score(
			new Map([
				['a', 0],
				['b', 5],
				['c', 10],
			])
		);
		expect(result.get('a')).toBe(1);
		expect(result.get('c')).toBe(10);
	});

	it('scales a mid-degree note between min and max on a log curve', () => {
		const result = scorer.score(
			new Map([
				['a', 0],
				['b', 5],
				['c', 10],
			])
		);
		expect(result.get('b')).toBe(8);
	});

	it('spreads a right-skewed degree distribution instead of pinning most notes near the minimum', () => {
		// A realistic shape: most notes are low (3-8), one hub is far above them.
		const result = scorer.score(
			new Map([
				['a', 0],
				['b', 3],
				['c', 4],
				['d', 5],
				['e', 8],
				['hub', 24],
			])
		);
		expect(result.get('a')).toBe(1);
		expect(result.get('hub')).toBe(10);
		// Plain min-max would put all of these at size 1-2. The log curve
		// should spread them further up the scale.
		expect(result.get('b')).toBeGreaterThanOrEqual(4);
		expect(result.get('e')).toBeGreaterThanOrEqual(6);
	});
});
