import { CommunityIdStabilizer } from './CommunityIdStabilizer';

const assign = (groups: string[][]): Map<string, number> => {
	const assignments = new Map<string, number>();
	groups.forEach((members, community) => {
		for (const id of members) assignments.set(id, community);
	});
	return assignments;
};

describe('CommunityIdStabilizer', () => {
	it('leaves the first assignment as it is', () => {
		const first = assign([['a', 'b'], ['c']]);

		expect(new CommunityIdStabilizer().stabilize(first)).toEqual(first);
	});

	it('continues from seeded numbers, such as those of a graph loaded from the cache', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.seed(
			assign([
				['d', 'e'],
				['a', 'b', 'c'],
			])
		);

		const next = stabilizer.stabilize(
			assign([
				['a', 'b', 'c'],
				['d', 'e'],
			])
		);

		expect(next.get('a')).toBe(1);
		expect(next.get('d')).toBe(0);
	});

	it('keeps each community on its number when two swap size order', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(
			assign([
				['a', 'b', 'c'],
				['d', 'e'],
			])
		);

		const next = stabilizer.stabilize(
			assign([
				['d', 'e', 'f', 'g'],
				['a', 'b', 'c'],
			])
		);

		expect(next.get('a')).toBe(0);
		expect(next.get('d')).toBe(1);
		expect(next.get('f')).toBe(1);
	});

	it('gives a brand new community a number nothing else is using', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(
			assign([
				['a', 'b'],
				['c', 'd'],
			])
		);

		const next = stabilizer.stabilize(
			assign([
				['a', 'b'],
				['c', 'd'],
				['new1', 'new2'],
			])
		);

		expect(next.get('new1')).toBe(2);
		expect(next.get('new2')).toBe(2);
	});

	it('reuses the number of a community that disappeared', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(
			assign([
				['a', 'b'],
				['c', 'd'],
			])
		);

		const next = stabilizer.stabilize(assign([['c', 'd'], ['new']]));

		expect(next.get('c')).toBe(1);
		expect(next.get('new')).toBe(0);
	});

	it('lets the larger half of a split keep the number, and gives the other a new one', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(assign([['a', 'b', 'c', 'd', 'e']]));

		const next = stabilizer.stabilize(
			assign([
				['a', 'b', 'c'],
				['d', 'e'],
			])
		);

		expect(next.get('a')).toBe(0);
		expect(next.get('d')).toBe(1);
	});

	it('gives two merged communities the number of the larger', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(assign([['a', 'b', 'c'], ['d']]));

		const next = stabilizer.stabilize(assign([['a', 'b', 'c', 'd']]));

		expect(next.get('d')).toBe(0);
	});

	it('never gives two different communities the same number', () => {
		const stabilizer = new CommunityIdStabilizer();
		stabilizer.stabilize(
			assign([
				['a', 'b'],
				['c', 'd'],
				['e', 'f'],
			])
		);

		const next = stabilizer.stabilize(assign([['a', 'c'], ['b', 'd'], ['e'], ['f']]));

		const numberByGroup = [next.get('a'), next.get('b'), next.get('e'), next.get('f')];
		expect(new Set(numberByGroup).size).toBe(4);
	});

	it('stays stable across a long run of small changes', () => {
		const stabilizer = new CommunityIdStabilizer();
		const groups = [
			['a', 'b', 'c'],
			['d', 'e', 'f'],
			['g', 'h', 'i'],
		];
		stabilizer.stabilize(assign(groups));

		for (let i = 0; i < 20; i++) {
			groups[i % 3].push(`n${i}`);
			const next = stabilizer.stabilize(assign([...groups].reverse()));
			expect(next.get('a')).toBe(0);
			expect(next.get('d')).toBe(1);
			expect(next.get('g')).toBe(2);
		}
	});
});
