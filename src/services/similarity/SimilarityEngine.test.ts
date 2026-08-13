import joplin from 'api';
import { SimilarityEngine } from './SimilarityEngine';
import { Note } from '../../data/Types';
import { EmbeddedNote } from '../embeddings/Types';
import { LARGE_VAULT_THRESHOLD } from './ThresholdPresets';

function makeNote(
	id: string,
	title: string,
	links: string[] = [],
	tags: string[] = [],
	createdTime = 0
): Note {
	return {
		id,
		parent_id: 'p1',
		title,
		body: '',
		created_time: createdTime,
		updated_time: 1,
		links,
		tags,
	};
}

const DAY_MS = 1000 * 60 * 60 * 24;

function embed(id: string, vector: number[]): EmbeddedNote {
	return { note: makeNote(id, 'Note ' + id), embedding: vector };
}

describe('SimilarityEngine', () => {
	describe('compute', () => {
		it('returns empty for no notes', async () => {
			const engine = new SimilarityEngine([], []);
			const pairs = await engine.compute();
			expect(pairs).toEqual([]);
		});

		it('returns empty for a single note', async () => {
			const engine = new SimilarityEngine([makeNote('a', 'A')], [embed('a', [1, 0, 0])]);
			const pairs = await engine.compute();
			expect(pairs).toEqual([]);
		});

		it('computes cosine similarity for two similar notes', async () => {
			const notes = [makeNote('a', 'A'), makeNote('b', 'B')];
			const embedded = [embed('a', [1, 0]), embed('b', [0.95, 0.3])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			expect(pairs).toHaveLength(1);
			expect(pairs[0].source).toBe('a');
			expect(pairs[0].target).toBe('b');
			expect(pairs[0].score).toBeGreaterThan(0.5);
		});

		it('orders source before target deterministically', async () => {
			const notes = [makeNote('b', 'B'), makeNote('a', 'A')];
			const embedded = [embed('b', [1, 0]), embed('a', [0.95, 0.3])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			expect(pairs).toHaveLength(1);
			expect(pairs[0].source).toBe('a');
			expect(pairs[0].target).toBe('b');
		});

		it('returns empty when all notes lack vectors', async () => {
			const notes = [makeNote('a', 'A'), makeNote('b', 'B')];
			const engine = new SimilarityEngine(notes, []);
			const pairs = await engine.compute();
			expect(pairs).toEqual([]);
		});

		it('skips notes without vectors in the mapping', async () => {
			const notes = [makeNote('a', 'A'), makeNote('b', 'B'), makeNote('c', 'C')];
			const embedded = [embed('a', [0.95, 0.3]), embed('c', [0.3, 0.95])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const involvesB = pairs.some((p) => p.source === 'b' || p.target === 'b');
			expect(involvesB).toBe(false);
		});
	});

	describe('normalization', () => {
		it('produces scores in [0, 1] range', async () => {
			const notes = [makeNote('a', 'A'), makeNote('b', 'B'), makeNote('c', 'C')];
			const embedded = [embed('a', [1, 0]), embed('b', [0.95, 0.3]), embed('c', [0.3, 0.95])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			for (const p of pairs) {
				expect(p.score).toBeGreaterThanOrEqual(0);
				expect(p.score).toBeLessThanOrEqual(1.5);
			}
		});

		it('gives higher scores to more similar notes', async () => {
			// With the floor applied to the raw score before normalize, whichever
			// pair is weakest among the floor survivors normalizes to exactly 0 —
			// b-c (raw ~0.589) plays that role here so it doesn't drag a-c down
			// with it, letting both a-b and a-c clear the threshold with a-b
			// still scoring higher.
			const notes = [makeNote('a', 'A'), makeNote('b', 'B'), makeNote('c', 'C')];
			const embedded = [
				embed('a', [1, 0, 0]),
				embed('b', [0.9, Math.sqrt(1 - 0.81), 0]),
				embed('c', [0.8, -0.3, Math.sqrt(0.27)]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const abScore = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);

			const acScore = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'c') || (p.source === 'c' && p.target === 'a')
			);

			expect(abScore).toBeDefined();
			expect(acScore).toBeDefined();
			expect(abScore!.score).toBeGreaterThan(acScore!.score);
		});
	});

	describe('tag bonuses', () => {
		it('boosts score when notes share tags', async () => {
			// Padded to 7 notes so the 'shared' tag (on 2 of them) stays under the
			// 30% organizational-tag threshold and isn't excluded from the signal.
			const notes = [
				makeNote('a', 'A', [], ['shared']),
				makeNote('b', 'B', [], ['shared']),
				makeNote('c', 'C', [], []),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
			];
			const embedded = [
				embed('a', [0.95, 0.3]),
				embed('b', [0.98, 0.2]),
				embed('c', [0.96, 0.28]),
				embed('pad0', [-1, 0]),
				embed('pad1', [0, -1]),
				embed('pad2', [-0.7, 0.7]),
				embed('pad3', [0.7, -0.7]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const abWithTag = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const acNoTag = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'c') || (p.source === 'c' && p.target === 'a')
			);

			expect(abWithTag).toBeDefined();
			expect(acNoTag).toBeDefined();
			expect(abWithTag!.score).toBeGreaterThan(acNoTag!.score);
		});

		it('scales the tag bonus by Jaccard overlap, not raw shared-tag count', async () => {
			// a-b and c-d each have the highest raw dot product (0.9) in the whole
			// fixture, so both normalize to exactly 1.0 regardless of the padding
			// notes' spread — isolating the tag bonus as the only source of
			// difference between their final scores. a/b fully overlap in tags
			// (jaccard=1.0 -> bonus=0.1); c/d partially overlap (jaccard=0.5 ->
			// bonus=0.05). A raw-count bonus would instead give both pairs the
			// same 2 * TAG_BONUS = 0.2, making them equal.
			const notes = [
				makeNote('a', 'A', [], ['p', 'q']),
				makeNote('b', 'B', [], ['p', 'q']),
				makeNote('c', 'C', [], ['r', 's']),
				makeNote('d', 'D', [], ['r', 's', 't', 'u']),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
			];
			const embedded = [
				embed('a', [1, 0, 0, 0]),
				embed('b', [0.9, Math.sqrt(1 - 0.81), 0, 0]),
				embed('c', [0, 1, 0, 0]),
				embed('d', [0, 0.9, Math.sqrt(1 - 0.81), 0]),
				embed('pad0', [-1, 0, 0, 0]),
				embed('pad1', [0, -1, 0, 0]),
				embed('pad2', [0, 0, -1, 0]),
				embed('pad3', [0, 0, 0, 1]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const ab = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const cd = pairs.find(
				(p) =>
					(p.source === 'c' && p.target === 'd') || (p.source === 'd' && p.target === 'c')
			);

			expect(ab).toBeDefined();
			expect(cd).toBeDefined();
			expect(ab!.score - cd!.score).toBeCloseTo(0.05, 5);
		});

		it('excludes organizational tags (present on more than 30% of notes) from the bonus', async () => {
			// 'inbox' appears on a, c, d, e (4 of 10 notes = 40%) — organizational, excluded.
			// 'project' appears only on a and b (2 of 10 = 20%) — meaningful, included.
			const notes = [
				makeNote('a', 'A', [], ['inbox', 'project']),
				makeNote('b', 'B', [], ['project']),
				makeNote('c', 'C', [], ['inbox']),
				makeNote('d', 'D', [], ['inbox']),
				makeNote('e', 'E', [], ['inbox']),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
				makeNote('pad4', 'Pad 4'),
			];
			const embedded = [
				embed('a', [0.95, 0.3]),
				embed('b', [0.98, 0.2]),
				embed('c', [0.96, 0.28]),
				embed('d', [-1, 0]),
				embed('e', [0, -1]),
				embed('pad0', [-0.7, 0.7]),
				embed('pad1', [0.7, -0.7]),
				embed('pad2', [-0.9, 0.1]),
				embed('pad3', [0.1, -0.9]),
				embed('pad4', [-0.5, -0.5]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const abSharesProject = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const acSharesOnlyInbox = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'c') || (p.source === 'c' && p.target === 'a')
			);

			expect(abSharesProject).toBeDefined();
			expect(acSharesOnlyInbox).toBeDefined();
			expect(abSharesProject!.score).toBeGreaterThan(acSharesOnlyInbox!.score);
		});
	});

	describe('link bonuses', () => {
		it('boosts score when notes link to each other', async () => {
			const notes = [
				makeNote('a', 'A', ['b'], []),
				makeNote('b', 'B', [], []),
				makeNote('c', 'C', [], []),
			];
			const embedded = [
				embed('a', [0.95, 0.3]),
				embed('b', [0.98, 0.2]),
				embed('c', [0.96, 0.28]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const abWithLink = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const acNoLink = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'c') || (p.source === 'c' && p.target === 'a')
			);

			expect(abWithLink).toBeDefined();
			expect(acNoLink).toBeDefined();
			expect(abWithLink!.score).toBeGreaterThan(acNoLink!.score);
		});
	});

	describe('temporal proximity bonus', () => {
		it('gives a stronger boost to notes created within a day than notes created within a week', async () => {
			// a-b and c-d each have the same raw dot product (0.9) in the whole
			// fixture, so both normalize to exactly 1.0 regardless of the padding
			// notes' spread — isolating the temporal bonus as the only source of
			// difference between their final scores. a/b were created 12 hours
			// apart (same-day bonus 0.1); c/d were created 3 days apart (same-week
			// bonus 0.05).
			const notes = [
				makeNote('a', 'A', [], [], 0),
				makeNote('b', 'B', [], [], 12 * 60 * 60 * 1000),
				makeNote('c', 'C', [], [], 0),
				makeNote('d', 'D', [], [], 3 * DAY_MS),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
			];
			const embedded = [
				embed('a', [1, 0, 0, 0]),
				embed('b', [0.9, Math.sqrt(1 - 0.81), 0, 0]),
				embed('c', [0, 1, 0, 0]),
				embed('d', [0, 0.9, Math.sqrt(1 - 0.81), 0]),
				embed('pad0', [-1, 0, 0, 0]),
				embed('pad1', [0, -1, 0, 0]),
				embed('pad2', [0, 0, -1, 0]),
				embed('pad3', [0, 0, 0, 1]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const ab = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const cd = pairs.find(
				(p) =>
					(p.source === 'c' && p.target === 'd') || (p.source === 'd' && p.target === 'c')
			);

			expect(ab).toBeDefined();
			expect(cd).toBeDefined();
			expect(ab!.score - cd!.score).toBeCloseTo(0.05, 5);
		});

		it('gives no temporal bonus to notes created more than a week apart', async () => {
			const notes = [
				makeNote('a', 'A', [], [], 0),
				makeNote('b', 'B', [], [], DAY_MS),
				makeNote('c', 'C', [], [], 0),
				makeNote('d', 'D', [], [], 30 * DAY_MS),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
			];
			const embedded = [
				embed('a', [1, 0, 0, 0]),
				embed('b', [0.9, Math.sqrt(1 - 0.81), 0, 0]),
				embed('c', [0, 1, 0, 0]),
				embed('d', [0, 0.9, Math.sqrt(1 - 0.81), 0]),
				embed('pad0', [-1, 0, 0, 0]),
				embed('pad1', [0, -1, 0, 0]),
				embed('pad2', [0, 0, -1, 0]),
				embed('pad3', [0, 0, 0, 1]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const ab = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const cd = pairs.find(
				(p) =>
					(p.source === 'c' && p.target === 'd') || (p.source === 'd' && p.target === 'c')
			);

			expect(ab).toBeDefined();
			expect(cd).toBeDefined();
			expect(ab!.score - cd!.score).toBeCloseTo(0.1, 5);
		});

		it('applies the bonus inclusively at exactly 1 day and exactly 7 days', async () => {
			const notes = [
				makeNote('a', 'A', [], [], 0),
				makeNote('b', 'B', [], [], DAY_MS),
				makeNote('c', 'C', [], [], 0),
				makeNote('d', 'D', [], [], 7 * DAY_MS),
				makeNote('pad0', 'Pad 0'),
				makeNote('pad1', 'Pad 1'),
				makeNote('pad2', 'Pad 2'),
				makeNote('pad3', 'Pad 3'),
			];
			const embedded = [
				embed('a', [1, 0, 0, 0]),
				embed('b', [0.9, Math.sqrt(1 - 0.81), 0, 0]),
				embed('c', [0, 1, 0, 0]),
				embed('d', [0, 0.9, Math.sqrt(1 - 0.81), 0]),
				embed('pad0', [-1, 0, 0, 0]),
				embed('pad1', [0, -1, 0, 0]),
				embed('pad2', [0, 0, -1, 0]),
				embed('pad3', [0, 0, 0, 1]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const ab = pairs.find(
				(p) =>
					(p.source === 'a' && p.target === 'b') || (p.source === 'b' && p.target === 'a')
			);
			const cd = pairs.find(
				(p) =>
					(p.source === 'c' && p.target === 'd') || (p.source === 'd' && p.target === 'c')
			);

			expect(ab).toBeDefined();
			expect(cd).toBeDefined();
			expect(ab!.score - cd!.score).toBeCloseTo(0.05, 5);
		});
	});

	describe('top-K filtering', () => {
		it('limits edges per note', async () => {
			const notes = [];
			const embedded = [];
			for (let i = 0; i < 6; i++) {
				notes.push(makeNote(`n${i}`, `Note ${i}`));
				embedded.push(
					embed(`n${i}`, [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)])
				);
			}

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			for (const note of notes) {
				const edges = pairs.filter((p) => p.source === note.id || p.target === note.id);
				expect(edges.length).toBeLessThanOrEqual(5);
			}
		});

		it('lets a hub note exceed K edges when more than K notes independently pick it', async () => {
			// A shares a "topic" dimension with 8 satellites, and each satellite
			// also has its own unique dimension. That makes every satellite closer
			// to A (dot = 0.9) than to any other satellite (dot = 0.81), so A is
			// always each satellite's #1 pick. Top-K is per-note (union), not a
			// hard cap on incoming edges, so A ends up with more than 5 edges here.
			const dims = 9;
			const aVector = new Array(dims).fill(0);
			aVector[0] = 1;

			const notes = [makeNote('a', 'A')];
			const embedded = [embed('a', aVector)];

			for (let i = 0; i < 8; i++) {
				const satelliteVector = new Array(dims).fill(0);
				satelliteVector[0] = 0.9;
				satelliteVector[i + 1] = 0.3;
				notes.push(makeNote(`n${i}`, `Note ${i}`));
				embedded.push(embed(`n${i}`, satelliteVector));
			}

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			const aEdges = pairs.filter((p) => p.source === 'a' || p.target === 'a');
			expect(aEdges.length).toBeGreaterThan(5);
		});
	});

	describe('custom threshold and top-K overrides', () => {
		it('applies a stricter caller-supplied threshold instead of DEFAULT_THRESHOLD', async () => {
			const notes = [makeNote('a', 'A'), makeNote('b', 'B')];
			const embedded = [embed('a', [1, 0]), embed('b', [0.95, 0.3])];

			const engine = new SimilarityEngine(notes, embedded);
			const defaultPairs = await engine.compute();
			const strictPairs = await engine.compute(1.2);

			expect(defaultPairs).toHaveLength(1);
			expect(strictPairs).toEqual([]);
		});

		it('applies a looser caller-supplied threshold that admits a pair DEFAULT_THRESHOLD would reject', async () => {
			// Raw cosine 0.35 (above SEMANTIC_FLOOR) plus the same-day temporal
			// bonus (0.1) lands at 0.45 — below DEFAULT_THRESHOLD (0.5) but above
			// a caller-supplied 0.4.
			const notes = [makeNote('a', 'A'), makeNote('b', 'B')];
			const embedded = [embed('a', [1, 0]), embed('b', [0.35, Math.sqrt(1 - 0.35 * 0.35)])];

			const engine = new SimilarityEngine(notes, embedded);
			const defaultPairs = await engine.compute();
			const loosePairs = await engine.compute(0.4);

			expect(defaultPairs).toEqual([]);
			expect(loosePairs).toHaveLength(1);
		});

		it('applies a caller-supplied top-K instead of TOP_K', async () => {
			// selectTopK is a per-note union (a pair survives if *either* endpoint
			// keeps it in its own top-K), so topK=0 is the only value that
			// unambiguously proves the override took effect: every note's own
			// kept list is empty, so no pair can survive from any side.
			const notes = [];
			const embedded = [];
			for (let i = 0; i < 6; i++) {
				notes.push(makeNote(`n${i}`, `Note ${i}`));
				embedded.push(
					embed(`n${i}`, [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)])
				);
			}

			const engine = new SimilarityEngine(notes, embedded);
			const defaultPairs = await engine.compute();
			const zeroKPairs = await engine.compute(undefined, 0);

			expect(defaultPairs.length).toBeGreaterThan(0);
			expect(zeroKPairs).toEqual([]);
		});
	});

	describe('SEMANTIC_FLOOR and threshold ordering', () => {
		it('rejects a below-floor pair even with a shared tag', async () => {
			// a and b are nearly orthogonal (cosine ~0), share a tag but are not
			// linked. SEMANTIC_FLOOR must reject them before bonuses or threshold
			// ever apply — tags alone can never manufacture an edge out of a weak
			// semantic score.
			const notes = [makeNote('a', 'A', [], ['shared']), makeNote('b', 'B', [], ['shared'])];
			const embedded = [embed('a', [1, 0]), embed('b', [0, 1])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			expect(pairs).toEqual([]);
		});

		it('lets a direct link bypass the floor, but the boosted score must still clear the threshold', async () => {
			// a and b are nearly orthogonal (cosine ~0) but directly link to each other
			// and share a tag. The link bypasses SEMANTIC_FLOOR (a user-created edge
			// isn't a false positive), but the resulting boosted score (~0.25) still
			// isn't enough to clear DEFAULT_THRESHOLD (0.5).
			const notes = [
				makeNote('a', 'A', ['b'], ['shared']),
				makeNote('b', 'B', [], ['shared']),
			];
			const embedded = [embed('a', [1, 0]), embed('b', [0, 1])];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			expect(pairs).toEqual([]);
		});
	});

	describe('floor is applied to raw scores, before normalization', () => {
		it('returns zero pairs for a vault of unrelated notes even when normalization runs', async () => {
			// Raw dots span 0 to 0.12 (spread >= 0.1, so normalization would run
			// and map the best pair to 1.0). Vectors are near-orthogonal with
			// only a small "leakage" component on a shared axis, so every
			// pairwise raw score stays below SEMANTIC_FLOOR (0.3) — with the
			// floor applied on the raw scale, nothing survives.
			const notes = [
				makeNote('a', 'A'),
				makeNote('b', 'B'),
				makeNote('c', 'C'),
				makeNote('d', 'D'),
			];
			const embedded = [
				embed('a', [1, 0.05, 0, 0]),
				embed('b', [0, 1, 0.08, 0]),
				embed('c', [0, 0, 1, 0.12]),
				embed('d', [0.03, 0, 0, 1]),
			];

			const engine = new SimilarityEngine(notes, embedded);
			const pairs = await engine.compute();

			expect(pairs).toEqual([]);
		});
	});

	describe('large vault (search-based) path retry', () => {
		function makeLargeVault(): { notes: Note[]; embedded: EmbeddedNote[] } {
			const count = LARGE_VAULT_THRESHOLD + 1;
			const notes: Note[] = [];
			for (let i = 0; i < count; i++) {
				notes.push(makeNote('n' + i, 'Note ' + i));
			}
			const embedded = [embed('n0', [1, 0]), embed('n1', [1, 0])];
			return { notes, embedded };
		}

		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('retries a failed note search and keeps the result once it succeeds', async () => {
			const { notes, embedded } = makeLargeVault();
			const search = (joplin.ai as unknown as { search: jest.Mock }).search;
			let calls = 0;
			search.mockImplementation(async (options: { query: { noteId: string } }) => {
				calls++;
				if (options.query.noteId === 'n0' && calls === 1) {
					throw new Error('network blip');
				}
				if (options.query.noteId === 'n0') {
					return [{ noteId: 'n1', chunkIndex: 0, chunkText: '', score: 0.9 }];
				}
				return [];
			});

			const engine = new SimilarityEngine(notes, embedded);
			const pairsPromise = engine.compute();
			await jest.advanceTimersByTimeAsync(500);
			const pairs = await pairsPromise;

			expect(pairs.some((p) => p.source === 'n0' && p.target === 'n1')).toBe(true);
		});

		it('falls back to cosine similarity when every note search fails after retrying', async () => {
			const { notes, embedded } = makeLargeVault();
			const search = (joplin.ai as unknown as { search: jest.Mock }).search;
			search.mockRejectedValue(new Error('search unavailable'));
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

			const engine = new SimilarityEngine(notes, embedded);
			const pairsPromise = engine.compute();
			await jest.advanceTimersByTimeAsync(notes.length * 500 + 1000);
			const pairs = await pairsPromise;

			expect(pairs.some((p) => p.source === 'n0' && p.target === 'n1')).toBe(true);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('falling back to pairwise cosine similarity'),
				expect.anything()
			);
			warnSpy.mockRestore();
		});

		it('gives up after a handful of consecutive failures instead of retrying every note in a large vault', async () => {
			const { notes, embedded } = makeLargeVault();
			const search = (joplin.ai as unknown as { search: jest.Mock }).search;
			search.mockRejectedValue(new Error('search unavailable'));
			jest.spyOn(console, 'warn').mockImplementation(() => undefined);

			const engine = new SimilarityEngine(notes, embedded);
			const pairsPromise = engine.compute();
			await jest.advanceTimersByTimeAsync(3 * 500 + 1000);
			await pairsPromise;

			expect(search.mock.calls.length).toBeLessThan(notes.length);
		});
	});
});
