import { KnnEntry, KnnIndex, KnnPair } from './KnnIndex';

const DIMENSION = 12;

function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function randomVector(random: () => number): number[] {
	const vector = Array.from({ length: DIMENSION }, () => random() - 0.5);
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return vector.map((value) => value / norm);
}

function randomEntries(count: number, random: () => number, prefix = 'n'): KnnEntry[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}${i}`,
		vector: randomVector(random),
	}));
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.fround(a[i]) * Math.fround(b[i]);
	return sum;
}

/** What each note's list should contain, worked out directly with no index involved. */
function bruteForceTopScores(entries: KnnEntry[], k: number): Map<string, number[]> {
	const expected = new Map<string, number[]>();
	for (const entry of entries) {
		const scores = entries
			.filter((other) => other.id !== entry.id)
			.map((other) => dot(entry.vector, other.vector))
			.sort((a, b) => b - a)
			.slice(0, k);
		expected.set(entry.id, scores);
	}
	return expected;
}

function assertMatchesBruteForce(pairs: KnnPair[], entries: KnnEntry[], k: number): void {
	const expected = bruteForceTopScores(entries, k);
	const vectorsById = new Map(entries.map((entry) => [entry.id, entry.vector]));

	const kept = new Set(pairs.map((pair) => `${pair.source}::${pair.target}`));
	for (const entry of entries) {
		const topScores = expected.get(entry.id) as number[];
		const lowestKept = topScores[topScores.length - 1];

		for (const other of entries) {
			if (other.id === entry.id) continue;
			const score = dot(entry.vector, other.vector);
			if (score >= lowestKept) {
				const key =
					entry.id < other.id ? `${entry.id}::${other.id}` : `${other.id}::${entry.id}`;
				expect(kept.has(key)).toBe(true);
			}
		}
	}

	for (const pair of pairs) {
		const exact = dot(
			vectorsById.get(pair.source) as ArrayLike<number>,
			vectorsById.get(pair.target) as ArrayLike<number>
		);
		expect(pair.score).toBeCloseTo(exact, 5);
		expect(pair.source < pair.target).toBe(true);
	}
}

describe('KnnIndex', () => {
	const K = 4;

	it('matches brute force on a full build', async () => {
		const entries = randomEntries(60, seededRandom(1));
		const index = new KnnIndex(K);

		await expect(index.sync(entries)).resolves.toBe(true);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('returns no pairs for an empty index or a single note', async () => {
		const index = new KnnIndex(K);
		await index.sync([]);
		expect(index.pairs()).toEqual([]);

		await index.sync(randomEntries(1, seededRandom(2)));
		expect(index.pairs()).toEqual([]);
	});

	it('handles fewer notes than the neighbour limit', async () => {
		const entries = randomEntries(3, seededRandom(3));
		const index = new KnnIndex(K);

		await index.sync(entries);

		expect(index.pairs()).toHaveLength(3);
	});

	it('reports each undirected pair only once', async () => {
		const index = new KnnIndex(K);
		await index.sync(randomEntries(40, seededRandom(4)));

		const keys = index.pairs().map((pair) => `${pair.source}::${pair.target}`);

		expect(new Set(keys).size).toBe(keys.length);
	});

	it('matches a fresh build after one note changes', async () => {
		const random = seededRandom(5);
		const entries = randomEntries(80, random);
		const index = new KnnIndex(K);
		await index.sync(entries);

		entries[10] = { id: entries[10].id, vector: randomVector(random) };
		await index.sync(entries);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('matches a fresh build after a note that others listed moves far away', async () => {
		const random = seededRandom(6);
		const entries = randomEntries(50, random);
		const index = new KnnIndex(K);
		await index.sync(entries);

		const popular = entries[0];
		entries[0] = { id: popular.id, vector: Array.from(popular.vector).map((value) => -value) };
		await index.sync(entries);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('matches a fresh build after notes are removed, and reuses their slots', async () => {
		const random = seededRandom(7);
		let entries = randomEntries(60, random);
		const index = new KnnIndex(K);
		await index.sync(entries);

		entries = entries.filter((_, i) => i % 15 !== 0);
		await index.sync(entries);
		assertMatchesBruteForce(index.pairs(), entries, K);
		expect(index.size).toBe(entries.length);

		entries = [...entries, ...randomEntries(2, random, 'added')];
		await index.sync(entries);
		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('stays correct through a long random sequence of edits, adds and removes', async () => {
		const random = seededRandom(8);
		let entries = randomEntries(70, random);
		const index = new KnnIndex(K);
		await index.sync(entries);

		let nextId = 0;
		for (let step = 0; step < 60; step++) {
			const roll = random();
			if (roll < 0.5) {
				const i = Math.floor(random() * entries.length);
				entries[i] = { id: entries[i].id, vector: randomVector(random) };
			} else if (roll < 0.75) {
				entries = [...entries, { id: `new${nextId++}`, vector: randomVector(random) }];
			} else if (entries.length > K + 2) {
				entries = entries.filter((_, i) => i !== Math.floor(random() * entries.length));
			}
			await index.sync(entries);
		}

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('grows past its starting capacity', async () => {
		const entries = randomEntries(300, seededRandom(9));
		const index = new KnnIndex(K);

		await index.sync(entries.slice(0, 40));
		await index.sync(entries);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('does no work when nothing changed', async () => {
		const entries = randomEntries(30, seededRandom(10));
		const index = new KnnIndex(K);
		await index.sync(entries);
		const before = index.pairs();

		await index.sync(entries.map((entry) => ({ ...entry, vector: Array.from(entry.vector) })));

		expect(index.pairs()).toEqual(before);
	});

	it('starts over when the vector dimension changes, such as after a model change', async () => {
		const index = new KnnIndex(K);
		await index.sync(randomEntries(20, seededRandom(11)));

		const shorter: KnnEntry[] = [
			{ id: 'a', vector: [1, 0] },
			{ id: 'b', vector: [0.6, 0.8] },
		];
		await index.sync(shorter);

		const pairs = index.pairs();
		expect(pairs).toHaveLength(1);
		expect(pairs[0].source).toBe('a');
		expect(pairs[0].score).toBeCloseTo(0.6, 5);
	});

	it('skips a note whose vector has the wrong dimension instead of corrupting the index', async () => {
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const index = new KnnIndex(K);

		await index.sync([
			{ id: 'a', vector: [1, 0] },
			{ id: 'bad', vector: [1, 0, 0] },
			{ id: 'b', vector: [0, 1] },
		]);

		expect(index.size).toBe(2);
		errorSpy.mockRestore();
	});

	it('stops when cancelled, then finishes correctly on the next sync', async () => {
		const entries = randomEntries(60, seededRandom(12));
		const index = new KnnIndex(K);

		await expect(index.sync(entries, () => true)).resolves.toBe(false);
		await expect(index.sync(entries)).resolves.toBe(true);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('finishes a cancelled incremental update on the next sync', async () => {
		const random = seededRandom(13);
		const entries = randomEntries(60, random);
		const index = new KnnIndex(K);
		await index.sync(entries);

		entries[3] = { id: entries[3].id, vector: randomVector(random) };
		await expect(index.sync(entries, () => true)).resolves.toBe(false);
		await index.sync(entries);

		assertMatchesBruteForce(index.pairs(), entries, K);
	});

	it('runs overlapping syncs one after the other, ending on the latest state', async () => {
		const random = seededRandom(15);
		const first = randomEntries(60, random);
		const second = first.slice(0, 40);
		const index = new KnnIndex(K, 0);

		await Promise.all([index.sync(first), index.sync(second)]);

		expect(index.size).toBe(40);
		assertMatchesBruteForce(index.pairs(), second, K);
	});

	it('hands control back during long work, so it never blocks in one stretch', async () => {
		const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
		const index = new KnnIndex(K, 0);

		await index.sync(randomEntries(50, seededRandom(14)));

		expect(setTimeoutSpy).toHaveBeenCalled();
		setTimeoutSpy.mockRestore();
	});
});
