import joplin from 'api';
import { SearchOptions, SearchResult } from 'api/types';
import { Note } from '../../data/Types';
import { EmbeddedNote } from '../embeddings/Types';
import {
	SEMANTIC_FLOOR,
	DEFAULT_THRESHOLD,
	TOP_K,
	LARGE_VAULT_THRESHOLD,
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

export class SimilarityEngine {
	private readonly noteIds: string[];
	private readonly vectors: Map<string, number[]>;
	private readonly tagMap: Map<string, Set<string>>;
	private readonly linkSet: Set<string>;
	private readonly createdTimeMap: Map<string, number>;

	public constructor(notes: Note[], embeddedNotes: EmbeddedNote[]) {
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
	 * compute → floor (raw scores) → normalize → enrich → threshold → top-K.
	 *
	 * SEMANTIC_FLOOR is applied to *raw* scores, before normalization. Min-max
	 * normalization always maps the batch's most-similar pair to exactly 1.0,
	 * so a post-normalization floor can never reject it — even in a vault of
	 * completely unrelated notes. Flooring on the raw scale (where 0.3 has an
	 * absolute meaning) is what actually guarantees that tags alone can never
	 * manufacture an edge out of a weak semantic score.
	 */
	public async compute(
		threshold: number = DEFAULT_THRESHOLD,
		topK: number = TOP_K
	): Promise<SimilarityPair[]> {
		if (this.noteIds.length <= 1) {
			return [];
		}

		const rawPairs = await this.computeRawPairs();

		if (rawPairs.length === 0) {
			return [];
		}

		const aboveFloor = this.filterBelowFloor(rawPairs, SEMANTIC_FLOOR);

		if (aboveFloor.length === 0) {
			return [];
		}

		const normalized = this.normalize(aboveFloor);
		const enriched = this.addBonusPoints(normalized);
		const aboveThreshold = this.filterBelowThreshold(enriched, threshold);
		const topPairs = this.selectTopK(aboveThreshold, topK);

		return topPairs;
	}

	/** Picks the appropriate similarity strategy based on vault size. */
	private computeRawPairs(): Promise<SimilarityPair[]> {
		if (this.noteIds.length <= LARGE_VAULT_THRESHOLD) {
			return Promise.resolve(this.computeCosinePairs());
		}
		return this.computeSearchPairs();
	}

	/** O(n²) pairwise cosine similarity via dot product on unit-norm vectors. */
	private computeCosinePairs(): SimilarityPair[] {
		const pairs: SimilarityPair[] = [];
		const n = this.noteIds.length;

		for (let i = 0; i < n; i++) {
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

	/**
	 * Uses joplin.ai.search({ noteId }) to find candidate pairs via vector index.
	 * Only checks that joplin.ai itself exists — never probes a specific method
	 * property without invoking it (see JoplinNativeProvider.validateAiApi for why).
	 *
	 * Score-scale assumption: search relevance scores are treated as raw
	 * similarity scores and flow through the same floor → normalize pipeline
	 * as cosine scores.
	 *
	 * Failure handling: individual per-note search failures are skipped (a
	 * partial candidate set is still useful), but if *every* call fails —
	 * e.g. joplin.ai exists but search doesn't on this Joplin version — we
	 * fall back to O(n²) cosine instead of silently returning zero pairs.
	 * Retry/backoff and progress/cancel for this path are ANG-012.
	 */
	private async computeSearchPairs(): Promise<SimilarityPair[]> {
		const joplinAi = joplin.ai as unknown as
			| { search: (options: SearchOptions) => Promise<SearchResult[]> }
			| undefined;
		if (!joplinAi) {
			return this.computeCosinePairs();
		}

		const pairs = new Map<string, SimilarityPair>();
		let successCount = 0;
		let firstError: unknown = null;

		for (const noteId of this.noteIds) {
			try {
				const results = await joplinAi.search({
					query: { noteId },
					relevance: 'normal',
				});
				successCount++;

				for (const r of results) {
					if (!this.vectors.has(r.noteId) || r.noteId === noteId) {
						continue;
					}

					const key = this.makePairKey(noteId, r.noteId);
					const existing = pairs.get(key);
					if (existing) {
						existing.score = Math.max(existing.score, r.score);
						continue;
					}

					const [source, target] =
						noteId < r.noteId ? [noteId, r.noteId] : [r.noteId, noteId];

					pairs.set(key, { source, target, score: r.score });
				}
			} catch (e) {
				if (firstError === null) {
					firstError = e;
					console.warn(
						'joplin.ai.search failed for a note; skipping it. First error:',
						e
					);
				}
				continue;
			}
		}

		if (successCount === 0 && this.noteIds.length > 0) {
			console.warn(
				'All joplin.ai.search calls failed; falling back to pairwise cosine similarity.',
				firstError
			);
			return this.computeCosinePairs();
		}

		return Array.from(pairs.values());
	}

	/** Dot product of two same-length vectors. */
	private dotProduct(a: number[], b: number[]): number {
		let sum = 0;
		for (let i = 0; i < a.length; i++) {
			sum += a[i] * b[i];
		}
		return sum;
	}

	/** Min-max normalizes scores to [0, 1]. Skips if spread is too narrow. */
	private normalize(pairs: SimilarityPair[]): SimilarityPair[] {
		let min = Infinity;
		let max = -Infinity;

		for (const p of pairs) {
			if (p.score < min) min = p.score;
			if (p.score > max) max = p.score;
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
	 * threshold check later. Runs before normalization on purpose: the floor
	 * guards against spurious tag-only edges, which requires an absolute
	 * scale, not a batch-relative one.
	 */
	private filterBelowFloor(pairs: SimilarityPair[], floor: number): SimilarityPair[] {
		return pairs.filter((p) => p.score >= floor || this.isDirectlyLinked(p));
	}

	/** Keeps only pairs whose bonus-boosted score clears the threshold. */
	private filterBelowThreshold(pairs: SimilarityPair[], threshold: number): SimilarityPair[] {
		return pairs.filter((p) => p.score >= threshold);
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
