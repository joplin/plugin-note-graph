import { Note } from '../../data/Types';
import { EmbeddedNote } from '../embeddings/Types';
import { KnnIndex } from './KnnIndex';
import {
	SEMANTIC_FLOOR,
	DEFAULT_THRESHOLD,
	TOP_K,
	LARGE_VAULT_THRESHOLD,
	NEIGHBOURHOOD_SIZE,
	TAG_BONUS,
	LINK_BONUS,
	ORGANIZATIONAL_TAG_RATIO,
	TEMPORAL_BONUS_1_DAY,
	TEMPORAL_BONUS_7_DAYS,
	MS_PER_DAY,
} from './ThresholdPresets';

export interface SimilarityPair {
	source: string;
	target: string;
	score: number;
}

/** A note's nearest neighbours, and how similar it usually is to them. */
interface Neighbourhood {
	ids: Set<string>;
	typicalScore: number;
}

export class SimilarityEngine {
	private readonly noteIds: string[];
	private readonly vectors: Map<string, number[]>;
	private readonly tagMap: Map<string, Set<string>>;
	private readonly linkSet: Set<string>;
	private readonly createdTimeMap: Map<string, number>;

	/** @param knnIndex - keep the same index between runs, so only changed notes are recomputed. */
	public constructor(
		notes: Note[],
		embeddedNotes: EmbeddedNote[],
		private readonly knnIndex: KnnIndex = new KnnIndex()
	) {
		this.noteIds = notes.map((n) => n.id);
		this.vectors = new Map<string, number[]>();
		for (const en of embeddedNotes) {
			this.vectors.set(en.note.id, en.embedding);
		}
		this.tagMap = this.buildTagMap(notes);
		this.linkSet = this.buildLinkSet(notes);
		this.createdTimeMap = new Map(notes.map((n) => [n.id, n.created_time]));
	}

	/**
	 * Orchestrates the full similarity pipeline:
	 * compute → floor (raw scores) → mutual neighbours → percentile cutoff
	 * (locally scaled scores) → normalize → bonuses → top-K.
	 *
	 * Both the floor and the cutoff are checked before normalization. Min-max
	 * normalization always maps the batch's most-similar pair to exactly 1.0, so
	 * a post-normalization threshold could never reject it — even in a vault of
	 * completely unrelated notes, the closest pair would be scaled up and pass.
	 * SEMANTIC_FLOOR is the small absolute floor on the raw score that guards
	 * tiny vaults with little data.
	 *
	 * Two notes must each be among the other's nearest neighbours. A note that
	 * is close to everything, without being about the same thing, stops being
	 * linked to all of them.
	 *
	 * The percentile cutoff keeps the top (1 - threshold) fraction of pairs by
	 * locally scaled score: how much closer two notes are than each of them
	 * usually is to its neighbours. A single cutoff on the raw score lets a
	 * dense group of near-identical notes set the bar for the whole vault, so
	 * notes elsewhere get no edges at all.
	 */
	public async compute(
		threshold: number = DEFAULT_THRESHOLD,
		topK: number = TOP_K,
		isCancelled?: () => boolean
	): Promise<SimilarityPair[]> {
		if (this.noteIds.length <= 1) {
			return [];
		}

		const rawPairs = await this.computeRawPairs(isCancelled);

		if (rawPairs.length === 0) {
			return [];
		}

		const neighbourhoods = this.findNeighbourhoods(rawPairs);
		const aboveFloor = this.filterBelowFloor(rawPairs, SEMANTIC_FLOOR);
		const mutual = aboveFloor.filter(
			(p) => this.isDirectlyLinked(p) || this.areMutualNeighbours(p, neighbourhoods)
		);

		if (mutual.length === 0) {
			return [];
		}

		const cutoff = this.percentileCutoff(mutual, threshold, neighbourhoods);
		const aboveThreshold = this.filterBelowThreshold(mutual, cutoff, neighbourhoods);

		if (aboveThreshold.length === 0) {
			return [];
		}

		const normalized = this.normalize(aboveThreshold, SEMANTIC_FLOOR);
		const enriched = this.addBonusPoints(normalized);
		const topPairs = this.selectTopK(enriched, topK);

		return topPairs;
	}

	/** Compares every pair in a small vault. Above that, only each note's nearest neighbours are candidates. */
	private computeRawPairs(isCancelled?: () => boolean): Promise<SimilarityPair[]> {
		if (this.noteIds.length <= LARGE_VAULT_THRESHOLD) {
			return Promise.resolve(this.computeCosinePairs(isCancelled));
		}
		return this.computeKnnPairs(isCancelled);
	}

	private async computeKnnPairs(isCancelled?: () => boolean): Promise<SimilarityPair[]> {
		const entries = this.noteIds
			.filter((id) => this.vectors.has(id))
			.map((id) => ({ id, vector: this.vectors.get(id) as number[] }));

		const finished = await this.knnIndex.sync(entries, isCancelled);
		return finished ? this.knnIndex.pairs() : [];
	}

	/** O(n²) pairwise cosine similarity via dot product on unit-norm vectors. */
	private computeCosinePairs(isCancelled?: () => boolean): SimilarityPair[] {
		const pairs: SimilarityPair[] = [];
		const n = this.noteIds.length;

		for (let i = 0; i < n; i++) {
			if (isCancelled?.()) break;
			const a = this.noteIds[i];
			const vecA = this.vectors.get(a);
			if (!vecA) continue;

			for (let j = i + 1; j < n; j++) {
				const b = this.noteIds[j];
				const vecB = this.vectors.get(b);
				if (!vecB) continue;

				const score = this.dotProduct(vecA, vecB);
				const [source, target] = a < b ? [a, b] : [b, a];
				pairs.push({ source, target, score });
			}
		}

		return pairs;
	}

	/** Dot product of two same-length vectors. */
	private dotProduct(a: number[], b: number[]): number {
		let sum = 0;
		for (let i = 0; i < a.length; i++) {
			sum += a[i] * b[i];
		}
		return sum;
	}

	/** Min-max normalizes scores to [0, 1], using only pairs that clear `floor` on their own to compute the range (excludes link-kept sub-floor outliers, see `filterBelowFloor`). */
	private normalize(pairs: SimilarityPair[], floor: number): SimilarityPair[] {
		let min = Infinity;
		let max = -Infinity;

		for (const p of pairs) {
			if (p.score < floor) continue;
			if (p.score < min) min = p.score;
			if (p.score > max) max = p.score;
		}

		if (min === Infinity) {
			return pairs;
		}

		const spread = max - min;
		if (spread < 0.1) {
			return pairs;
		}

		for (const p of pairs) {
			p.score = (p.score - min) / spread;
		}

		return pairs;
	}

	/** Adds shared-tag, direct-link, and temporal-proximity bonuses to each pair's score. */
	private addBonusPoints(pairs: SimilarityPair[]): SimilarityPair[] {
		for (const p of pairs) {
			p.score +=
				this.sharedTagBonus(p) + this.directLinkBonus(p) + this.temporalProximityBonus(p);
		}
		return pairs;
	}

	/** Jaccard overlap (intersection / union) between two notes' tag sets, scaled by TAG_BONUS. */
	private sharedTagBonus(pair: SimilarityPair): number {
		const tagsA = this.tagMap.get(pair.source) ?? new Set();
		const tagsB = this.tagMap.get(pair.target) ?? new Set();
		if (tagsA.size === 0 && tagsB.size === 0) return 0;

		let intersectionSize = 0;
		for (const t of tagsA) {
			if (tagsB.has(t)) intersectionSize++;
		}
		const unionSize = new Set([...tagsA, ...tagsB]).size;

		return (intersectionSize / unionSize) * TAG_BONUS;
	}

	private directLinkBonus(pair: SimilarityPair): number {
		return this.isDirectlyLinked(pair) ? LINK_BONUS : 0;
	}

	private isDirectlyLinked(pair: SimilarityPair): boolean {
		return this.linkSet.has(this.makePairKey(pair.source, pair.target));
	}

	/** Boosts notes created close together in time: same day scores higher than same week. */
	private temporalProximityBonus(pair: SimilarityPair): number {
		const createdA = this.createdTimeMap.get(pair.source);
		const createdB = this.createdTimeMap.get(pair.target);
		if (createdA === undefined || createdB === undefined) return 0;

		const daysApart = Math.abs(createdA - createdB) / MS_PER_DAY;
		if (daysApart <= 1) return TEMPORAL_BONUS_1_DAY;
		if (daysApart <= 7) return TEMPORAL_BONUS_7_DAYS;
		return 0;
	}

	/**
	 * Removes pairs whose *raw* score is below the safety floor — unless the
	 * notes are directly linked, in which case they're kept and left for the
	 * cutoff check later. Runs before normalization on purpose: the floor
	 * guards against spurious tag-only edges, which requires an absolute
	 * scale, not a batch-relative one.
	 */
	private filterBelowFloor(pairs: SimilarityPair[], floor: number): SimilarityPair[] {
		return pairs.filter((p) => p.score >= floor || this.isDirectlyLinked(p));
	}

	private findNeighbourhoods(pairs: SimilarityPair[]): Map<string, Neighbourhood> {
		const candidates = new Map<string, Array<{ id: string; score: number }>>();
		const add = (noteId: string, other: string, score: number): void => {
			const list = candidates.get(noteId);
			if (list) list.push({ id: other, score });
			else candidates.set(noteId, [{ id: other, score }]);
		};
		for (const p of pairs) {
			add(p.source, p.target, p.score);
			add(p.target, p.source, p.score);
		}

		const neighbourhoods = new Map<string, Neighbourhood>();
		for (const [noteId, list] of candidates) {
			const nearest = list.sort((a, b) => b.score - a.score).slice(0, NEIGHBOURHOOD_SIZE);
			neighbourhoods.set(noteId, {
				ids: new Set(nearest.map((n) => n.id)),
				typicalScore: nearest.reduce((sum, n) => sum + n.score, 0) / nearest.length,
			});
		}
		return neighbourhoods;
	}

	private areMutualNeighbours(
		pair: SimilarityPair,
		neighbourhoods: Map<string, Neighbourhood>
	): boolean {
		return (
			!!neighbourhoods.get(pair.source)?.ids.has(pair.target) &&
			!!neighbourhoods.get(pair.target)?.ids.has(pair.source)
		);
	}

	/** How much closer two notes are than each of them usually is to its neighbours. */
	private localScore(pair: SimilarityPair, neighbourhoods: Map<string, Neighbourhood>): number {
		const typical = (noteId: string): number =>
			neighbourhoods.get(noteId)?.typicalScore ?? pair.score;
		return 2 * pair.score - typical(pair.source) - typical(pair.target);
	}

	private percentileCutoff(
		pairs: SimilarityPair[],
		percentile: number,
		neighbourhoods: Map<string, Neighbourhood>
	): number {
		const scores = pairs
			.filter((p) => p.score >= SEMANTIC_FLOOR)
			.map((p) => this.localScore(p, neighbourhoods))
			.sort((a, b) => a - b);

		if (scores.length === 0) {
			return Infinity;
		}

		const clamped = Math.min(1, Math.max(0, percentile));
		const index = Math.min(
			scores.length - 1,
			Math.max(0, Math.ceil(clamped * scores.length) - 1)
		);
		return scores[index];
	}

	/** Keeps only pairs whose locally scaled score clears the cutoff, before normalization. */
	private filterBelowThreshold(
		pairs: SimilarityPair[],
		threshold: number,
		neighbourhoods: Map<string, Neighbourhood>
	): SimilarityPair[] {
		return pairs.filter((p) => this.localScore(p, neighbourhoods) >= threshold);
	}

	/**
	 * Keeps each note's own K strongest connections; the returned edge set is
	 * their union, so a note that many others pick as one of their top-K can
	 * end up with more than K edges. This is the standard k-nearest-neighbor
	 * graph definition and preserves degree as a centrality signal.
	 * Output pairs are always oriented source < target.
	 */
	private selectTopK(pairs: SimilarityPair[], k: number): SimilarityPair[] {
		const bySource = new Map<string, SimilarityPair[]>();

		for (const p of pairs) {
			this.appendPair(bySource, p.source, p);
			this.appendPair(bySource, p.target, {
				source: p.target,
				target: p.source,
				score: p.score,
			});
		}

		const deduped = new Map<string, SimilarityPair>();

		for (const [, candidates] of bySource) {
			candidates.sort((a, b) => b.score - a.score);
			const kept = candidates.slice(0, k);

			for (const p of kept) {
				const key = this.makePairKey(p.source, p.target);
				if (!deduped.has(key)) {
					const [source, target] =
						p.source < p.target ? [p.source, p.target] : [p.target, p.source];
					deduped.set(key, { source, target, score: p.score });
				}
			}
		}

		return Array.from(deduped.values());
	}

	private appendPair(
		map: Map<string, SimilarityPair[]>,
		noteId: string,
		pair: SimilarityPair
	): void {
		let list = map.get(noteId);
		if (!list) {
			list = [];
			map.set(noteId, list);
		}
		list.push(pair);
	}

	/** Deterministic ordered key for an undirected note pair. */
	private makePairKey(a: string, b: string): string {
		return a < b ? `${a}::${b}` : `${b}::${a}`;
	}

	/** Maps each note to its tags, excluding organizational tags shared by too much of the vault to be a meaningful signal. */
	private buildTagMap(notes: Note[]): Map<string, Set<string>> {
		const organizationalTags = this.findOrganizationalTags(notes);

		const map = new Map<string, Set<string>>();
		for (const n of notes) {
			const meaningfulTags = (n.tags ?? []).filter((t) => !organizationalTags.has(t));
			map.set(n.id, new Set(meaningfulTags));
		}
		return map;
	}

	private findOrganizationalTags(notes: Note[]): Set<string> {
		const tagCounts = new Map<string, number>();
		for (const n of notes) {
			for (const t of n.tags ?? []) {
				tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
			}
		}

		const threshold = notes.length * ORGANIZATIONAL_TAG_RATIO;
		const organizational = new Set<string>();
		for (const [tag, count] of tagCounts) {
			if (count > threshold) organizational.add(tag);
		}
		return organizational;
	}

	private buildLinkSet(notes: Note[]): Set<string> {
		const set = new Set<string>();
		for (const n of notes) {
			for (const link of n.links ?? []) {
				set.add(this.makePairKey(n.id, link));
			}
		}
		return set;
	}
}
