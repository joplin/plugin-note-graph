const MIN_SIZE = 1;
const MAX_SIZE = 10;

/** Used when every note has the same degree. There's nothing to compare, so all nodes get the same mid-range size. */
const FLAT_DEGREE_SIZE = 5;

export class CentralityScorer {
	/**
	 * Maps each note's degree (connection count) to a 1-10 size scale, so
	 * the most connected notes render biggest. See scale() for why this
	 * isn't plain min-max.
	 */
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

	/**
	 * Most notes only have a few connections, and a couple of hubs have way
	 * more. Plain min-max scaling would squeeze almost everything down near
	 * MIN_SIZE. Using log compression instead spreads the low-degree notes
	 * out across the scale instead of flattening them.
	 */
	private scale(degree: number, min: number, spread: number): number {
		const normalized = Math.log1p(degree - min) / Math.log1p(spread);
		return Math.round(MIN_SIZE + normalized * (MAX_SIZE - MIN_SIZE));
	}
}
