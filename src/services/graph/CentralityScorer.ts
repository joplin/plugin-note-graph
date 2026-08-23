const MIN_SIZE = 1;
const MAX_SIZE = 10;

/** Used when every note has the same degree. There's nothing to compare, so all nodes get the same mid-range size. */
const FLAT_DEGREE_SIZE = 5;

export function clampSize(size: number): number {
	return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

export class CentralityScorer {
	/** Maps each note's degree to a 1-10 size scale. See `scale()` for why this isn't plain min-max. */
	public score(degreeMap: Map<string, number>): Map<string, number> {
		if (degreeMap.size === 0) {
			return new Map();
		}

		let min = Infinity;
		let max = -Infinity;
		for (const degree of degreeMap.values()) {
			if (degree < min) min = degree;
			if (degree > max) max = degree;
		}
		const spread = max - min;

		const sizes = new Map<string, number>();
		for (const [noteId, degree] of degreeMap) {
			sizes.set(noteId, spread === 0 ? FLAT_DEGREE_SIZE : this.scale(degree, min, spread));
		}
		return sizes;
	}

	/** Log compression instead of plain min-max, since most notes have few connections and a couple of hubs have way more; linear scaling would squeeze everyone but the hubs down near MIN_SIZE. */
	private scale(degree: number, min: number, spread: number): number {
		const normalized = Math.log1p(degree - min) / Math.log1p(spread);
		return Math.round(MIN_SIZE + normalized * (MAX_SIZE - MIN_SIZE));
	}
}
