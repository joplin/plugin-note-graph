/**
 * Keeps community numbers stable between rebuilds. Louvain's numbering only
 * reflects size order, so one edit can swap two communities and recolor every
 * note in them. Each new community takes the number of the old community it has
 * the most notes in common with, so colors and cluster identities carry over.
 */
export class CommunityIdStabilizer {
	private previous = new Map<string, number>();

	/** Starts from numbers already in use, such as those on a graph loaded from the cache. */
	public seed(assignments: Map<string, number>): void {
		this.previous = assignments;
	}

	public stabilize(assignments: Map<string, number>): Map<string, number> {
		const stable = this.previous.size === 0 ? assignments : this.remap(assignments);
		this.previous = stable;
		return stable;
	}

	private remap(assignments: Map<string, number>): Map<string, number> {
		const membersByCommunity = new Map<number, string[]>();
		for (const [noteId, community] of assignments) {
			const members = membersByCommunity.get(community);
			if (members) members.push(noteId);
			else membersByCommunity.set(community, [noteId]);
		}

		const candidates = this.rankOverlaps(membersByCommunity);
		const newIdByCommunity = new Map<number, number>();
		const takenIds = new Set<number>();
		for (const { community, previousId } of candidates) {
			if (newIdByCommunity.has(community) || takenIds.has(previousId)) continue;
			newIdByCommunity.set(community, previousId);
			takenIds.add(previousId);
		}

		let nextId = this.firstUnusedId(takenIds);
		const orderedCommunities = Array.from(membersByCommunity.keys()).sort((a, b) => a - b);
		for (const community of orderedCommunities) {
			if (newIdByCommunity.has(community)) continue;
			while (takenIds.has(nextId)) nextId++;
			newIdByCommunity.set(community, nextId);
			takenIds.add(nextId);
		}

		const stable = new Map<string, number>();
		for (const [noteId, community] of assignments) {
			stable.set(noteId, newIdByCommunity.get(community) as number);
		}
		return stable;
	}

	/** Every pairing of a new community with an old one that shares notes, most shared notes first. */
	private rankOverlaps(
		membersByCommunity: Map<number, string[]>
	): Array<{ community: number; previousId: number; overlap: number }> {
		const candidates: Array<{ community: number; previousId: number; overlap: number }> = [];
		for (const [community, members] of membersByCommunity) {
			const overlapByPrevious = new Map<number, number>();
			for (const noteId of members) {
				const previousId = this.previous.get(noteId);
				if (previousId !== undefined) {
					overlapByPrevious.set(previousId, (overlapByPrevious.get(previousId) ?? 0) + 1);
				}
			}
			for (const [previousId, overlap] of overlapByPrevious) {
				candidates.push({ community, previousId, overlap });
			}
		}
		return candidates.sort(
			(a, b) =>
				b.overlap - a.overlap || a.community - b.community || a.previousId - b.previousId
		);
	}

	private firstUnusedId(takenIds: Set<number>): number {
		let id = 0;
		while (takenIds.has(id)) id++;
		return id;
	}
}
