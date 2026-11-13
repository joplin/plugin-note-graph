import { Logger, consoleLogger } from '../../utils/Logger';

export interface KnnEntry {
	id: string;
	vector: ArrayLike<number>;
}

export interface KnnPair {
	source: string;
	target: string;
	score: number;
}

/** Above this share of changed notes, rebuilding everything is cheaper than updating them one at a time. */
const FULL_REBUILD_RATIO = 0.2;
export const DEFAULT_NEIGHBORS_PER_NOTE = 20;
export const WORK_SLICE_MS = 25;

const NO_NEIGHBOR = -1;

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Exact top-K nearest neighbours for every note, held in flat typed arrays. A
 * later `sync` only recomputes what changed, so updating one note costs one row
 * of comparisons rather than a pass over the whole vault. Long work yields
 * regularly and can be cancelled; a cancelled `sync` resumes on the next call.
 */
export class KnnIndex {
	private dimension = 0;
	private capacity = 0;
	private vectors = new Float32Array(0);
	private neighborScores = new Float32Array(0);
	private neighborSlots = new Int32Array(0);
	private minScore = new Float32Array(0);
	private minPosition = new Int32Array(0);
	private readonly slotById = new Map<string, number>();
	private idBySlot: Array<string | null> = [];
	private readonly freeSlots: number[] = [];
	private readonly changedSlots = new Set<number>();
	private readonly staleSlots = new Set<number>();
	private lastYieldAt = 0;
	private syncChain: Promise<unknown> = Promise.resolve();

	public constructor(
		private readonly neighborsPerNote: number = DEFAULT_NEIGHBORS_PER_NOTE,
		private readonly workSliceMs: number = WORK_SLICE_MS,
		private readonly logger: Logger = consoleLogger
	) {}

	public get size(): number {
		return this.slotById.size;
	}

	/** Brings the index in line with `entries`. Returns false if cancelled before finishing. */
	public sync(entries: KnnEntry[], isCancelled: () => boolean = () => false): Promise<boolean> {
		const task = this.syncChain.then(() => this.runSync(entries, isCancelled));
		this.syncChain = task.catch(() => undefined);
		return task;
	}

	private async runSync(entries: KnnEntry[], isCancelled: () => boolean): Promise<boolean> {
		this.resetIfDimensionChanged(entries);
		this.applyRemovals(entries);
		this.applyUpserts(entries);

		this.lastYieldAt = Date.now();
		if (this.changedSlots.size > this.slotById.size * FULL_REBUILD_RATIO) {
			return this.rebuildAll(isCancelled);
		}
		return this.updateIncrementally(isCancelled);
	}

	/** Each undirected pair that appears in either note's neighbour list, oriented source < target. */
	public pairs(): KnnPair[] {
		const seen = new Set<number>();
		const pairs: KnnPair[] = [];

		for (const slot of this.slotById.values()) {
			const offset = slot * this.neighborsPerNote;
			for (let position = 0; position < this.neighborsPerNote; position++) {
				const other = this.neighborSlots[offset + position];
				if (other === NO_NEIGHBOR) continue;

				const key =
					slot < other ? slot * this.capacity + other : other * this.capacity + slot;
				if (seen.has(key)) continue;
				seen.add(key);

				const a = this.idBySlot[slot] as string;
				const b = this.idBySlot[other] as string;
				const [source, target] = a < b ? [a, b] : [b, a];
				pairs.push({ source, target, score: this.neighborScores[offset + position] });
			}
		}
		return pairs;
	}

	private resetIfDimensionChanged(entries: KnnEntry[]): void {
		if (entries.length === 0) return;
		const dimension = entries[0].vector.length;
		if (dimension === this.dimension) return;

		this.dimension = dimension;
		this.capacity = 0;
		this.vectors = new Float32Array(0);
		this.neighborScores = new Float32Array(0);
		this.neighborSlots = new Int32Array(0);
		this.minScore = new Float32Array(0);
		this.minPosition = new Int32Array(0);
		this.slotById.clear();
		this.idBySlot = [];
		this.freeSlots.length = 0;
		this.changedSlots.clear();
		this.staleSlots.clear();
	}

	private applyRemovals(entries: KnnEntry[]): void {
		const wantedIds = new Set(entries.map((entry) => entry.id));
		const removedSlots = new Set<number>();
		for (const [id, slot] of this.slotById) {
			if (!wantedIds.has(id)) removedSlots.add(slot);
		}
		if (removedSlots.size === 0) return;

		for (const slot of removedSlots) {
			this.slotById.delete(this.idBySlot[slot] as string);
			this.idBySlot[slot] = null;
			this.freeSlots.push(slot);
			this.changedSlots.delete(slot);
			this.staleSlots.delete(slot);
			this.clearNeighbors(slot);
		}

		for (const slot of this.slotById.values()) {
			if (this.listContainsAny(slot, removedSlots)) this.staleSlots.add(slot);
		}
	}

	private applyUpserts(entries: KnnEntry[]): void {
		for (const entry of entries) {
			if (entry.vector.length !== this.dimension) {
				this.logger.error(
					`KnnIndex: skipping note ${entry.id}, its vector has the wrong dimension.`
				);
				continue;
			}

			let slot = this.slotById.get(entry.id);
			if (slot === undefined) {
				slot = this.allocateSlot(entry.id);
				this.writeVector(slot, entry.vector);
				this.changedSlots.add(slot);
			} else if (!this.vectorEquals(slot, entry.vector)) {
				this.writeVector(slot, entry.vector);
				this.changedSlots.add(slot);
			}
		}
	}

	private allocateSlot(id: string): number {
		let slot = this.freeSlots.pop();
		if (slot === undefined) {
			slot = this.idBySlot.length;
			if (slot >= this.capacity) this.grow();
			this.idBySlot.push(id);
		} else {
			this.idBySlot[slot] = id;
		}
		this.slotById.set(id, slot);
		this.clearNeighbors(slot);
		return slot;
	}

	private grow(): void {
		const capacity = Math.max(64, this.capacity * 2);

		const vectors = new Float32Array(capacity * this.dimension);
		vectors.set(this.vectors);
		const neighborScores = new Float32Array(capacity * this.neighborsPerNote);
		neighborScores.set(this.neighborScores);
		const neighborSlots = new Int32Array(capacity * this.neighborsPerNote);
		neighborSlots.set(this.neighborSlots);
		const minScore = new Float32Array(capacity);
		minScore.set(this.minScore);
		const minPosition = new Int32Array(capacity);
		minPosition.set(this.minPosition);

		this.capacity = capacity;
		this.vectors = vectors;
		this.neighborScores = neighborScores;
		this.neighborSlots = neighborSlots;
		this.minScore = minScore;
		this.minPosition = minPosition;
	}

	private writeVector(slot: number, vector: ArrayLike<number>): void {
		const offset = slot * this.dimension;
		for (let i = 0; i < this.dimension; i++) {
			this.vectors[offset + i] = vector[i];
		}
	}

	private vectorEquals(slot: number, vector: ArrayLike<number>): boolean {
		const offset = slot * this.dimension;
		for (let i = 0; i < this.dimension; i++) {
			if (this.vectors[offset + i] !== Math.fround(vector[i])) return false;
		}
		return true;
	}

	private async rebuildAll(isCancelled: () => boolean): Promise<boolean> {
		const slots = Array.from(this.slotById.values());
		for (const slot of slots) {
			this.clearNeighbors(slot);
			this.changedSlots.add(slot);
		}

		for (let i = 0; i < slots.length; i++) {
			if (isCancelled()) return false;
			await this.yieldIfSliceUsed();

			const a = slots[i];
			for (let j = i + 1; j < slots.length; j++) {
				const b = slots[j];
				const score = this.dot(a, b);
				this.insertNeighbor(a, b, score);
				this.insertNeighbor(b, a, score);
			}
		}

		this.changedSlots.clear();
		this.staleSlots.clear();
		return true;
	}

	private async updateIncrementally(isCancelled: () => boolean): Promise<boolean> {
		const slots = Array.from(this.slotById.values());

		for (const changed of Array.from(this.changedSlots)) {
			if (isCancelled()) return false;
			await this.yieldIfSliceUsed();
			this.recomputeChangedRow(changed, slots);
			this.changedSlots.delete(changed);
			this.staleSlots.delete(changed);
		}

		for (const stale of Array.from(this.staleSlots)) {
			if (isCancelled()) return false;
			await this.yieldIfSliceUsed();
			this.recomputeOwnList(stale, slots);
			this.staleSlots.delete(stale);
		}
		return true;
	}

	/** Recomputes a note whose vector changed, and corrects its entry in every other note's list. */
	private recomputeChangedRow(changed: number, slots: number[]): void {
		this.clearNeighbors(changed);
		for (const other of slots) {
			if (other === changed) continue;
			const score = this.dot(changed, other);
			this.insertNeighbor(changed, other, score);
			this.updateEntryInOtherList(other, changed, score);
		}
	}

	private updateEntryInOtherList(owner: number, changed: number, score: number): void {
		const position = this.findNeighbor(owner, changed);
		if (position === NO_NEIGHBOR) {
			this.insertNeighbor(owner, changed, score);
			return;
		}

		const offset = owner * this.neighborsPerNote;
		if (score < this.neighborScores[offset + position]) {
			// A note outside the list may now rank higher, and only a full row can tell.
			this.staleSlots.add(owner);
		}
		this.neighborScores[offset + position] = score;
		this.refreshMinimum(owner);
	}

	/** Rebuilds one note's list when only its neighbours changed, so no other list is affected. */
	private recomputeOwnList(owner: number, slots: number[]): void {
		this.clearNeighbors(owner);
		for (const other of slots) {
			if (other === owner) continue;
			this.insertNeighbor(owner, other, this.dot(owner, other));
		}
	}

	private dot(a: number, b: number): number {
		const vectors = this.vectors;
		const dimension = this.dimension;
		const offsetA = a * dimension;
		const offsetB = b * dimension;
		let sum = 0;
		for (let i = 0; i < dimension; i++) {
			sum += vectors[offsetA + i] * vectors[offsetB + i];
		}
		return sum;
	}

	private insertNeighbor(owner: number, neighbor: number, score: number): void {
		if (score <= this.minScore[owner]) return;

		const position = owner * this.neighborsPerNote + this.minPosition[owner];
		this.neighborScores[position] = score;
		this.neighborSlots[position] = neighbor;
		this.refreshMinimum(owner);
	}

	private refreshMinimum(owner: number): void {
		const offset = owner * this.neighborsPerNote;
		let lowest = Infinity;
		let lowestPosition = 0;
		for (let position = 0; position < this.neighborsPerNote; position++) {
			const score = this.neighborScores[offset + position];
			if (score < lowest) {
				lowest = score;
				lowestPosition = position;
			}
		}
		this.minScore[owner] = lowest;
		this.minPosition[owner] = lowestPosition;
	}

	private clearNeighbors(slot: number): void {
		const offset = slot * this.neighborsPerNote;
		this.neighborScores.fill(-Infinity, offset, offset + this.neighborsPerNote);
		this.neighborSlots.fill(NO_NEIGHBOR, offset, offset + this.neighborsPerNote);
		this.minScore[slot] = -Infinity;
		this.minPosition[slot] = 0;
	}

	private findNeighbor(owner: number, neighbor: number): number {
		const offset = owner * this.neighborsPerNote;
		for (let position = 0; position < this.neighborsPerNote; position++) {
			if (this.neighborSlots[offset + position] === neighbor) return position;
		}
		return NO_NEIGHBOR;
	}

	private listContainsAny(owner: number, slots: Set<number>): boolean {
		const offset = owner * this.neighborsPerNote;
		for (let position = 0; position < this.neighborsPerNote; position++) {
			if (slots.has(this.neighborSlots[offset + position])) return true;
		}
		return false;
	}

	private async yieldIfSliceUsed(): Promise<void> {
		if (Date.now() - this.lastYieldAt < this.workSliceMs) return;
		await nextTurn();
		this.lastYieldAt = Date.now();
	}
}
