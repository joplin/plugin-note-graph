import { VectorRepository } from './VectorRepository';
import { IVectorDatabase } from './VectorDatabase';

/**
 * In-memory stand-in for VectorDatabase. sqlite3 is only reachable at runtime
 * via joplin.require(), so VectorRepository is tested against this fake
 * rather than a real database; it emulates the single upsert statement and
 * the `note_id IN (...)` select that VectorRepository issues.
 */
class FakeVectorDatabase implements IVectorDatabase {
	public opened = false;
	public allCallBatchSizes: number[] = [];
	private rows = new Map<string, { note_id: string; model_id: string; updated_time: number; vector: Buffer }>();

	public async open(): Promise<void> {
		this.opened = true;
	}

	public async run(_sql: string, params: unknown[]): Promise<void> {
		if (params.length === 0) {
			return; // BEGIN TRANSACTION / COMMIT / ROLLBACK
		}
		const [noteId, modelId, updatedTime, vector] = params as [string, string, number, Buffer];
		this.rows.set(noteId, { note_id: noteId, model_id: modelId, updated_time: updatedTime, vector });
	}

	public async all<T>(_sql: string, params: unknown[]): Promise<T[]> {
		const ids = params as string[];
		this.allCallBatchSizes.push(ids.length);
		const found = ids.map(id => this.rows.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
		return found as unknown as T[];
	}
}

describe('VectorRepository', () => {
	let db: FakeVectorDatabase;
	let repo: VectorRepository;

	beforeEach(() => {
		db = new FakeVectorDatabase();
		repo = new VectorRepository(db);
	});

	describe('getMany', () => {
		it('returns an empty map without opening the database for no IDs', async () => {
			const result = await repo.getMany([]);
			expect(result.size).toBe(0);
			expect(db.opened).toBe(false);
		});

		it('returns nothing for IDs that were never saved', async () => {
			const result = await repo.getMany(['missing']);
			expect(result.size).toBe(0);
			expect(db.opened).toBe(true);
		});
	});

	describe('saveMany + getMany round trip', () => {
		it('round-trips vector values through the Float32 BLOB encoding', async () => {
			const vector = [0.1, -0.25, 0.987654, 1, -1, 0];
			await repo.saveMany([{ noteId: 'n1', vector, modelId: 'm1', updatedTime: 100 }]);

			const result = await repo.getMany(['n1']);
			const entry = result.get('n1');

			expect(entry).toBeDefined();
			expect(entry!.modelId).toBe('m1');
			expect(entry!.updatedTime).toBe(100);
			expect(entry!.vector).toHaveLength(vector.length);
			for (let i = 0; i < vector.length; i++) {
				// Float32 storage loses some precision relative to the JS float64 input.
				expect(entry!.vector[i]).toBeCloseTo(vector[i], 5);
			}
		});

		it('overwrites the previous entry for the same note ID', async () => {
			await repo.saveMany([{ noteId: 'n1', vector: [1, 0], modelId: 'm1', updatedTime: 100 }]);
			await repo.saveMany([{ noteId: 'n1', vector: [0, 1], modelId: 'm2', updatedTime: 200 }]);

			const result = await repo.getMany(['n1']);
			const entry = result.get('n1');

			expect(entry!.modelId).toBe('m2');
			expect(entry!.updatedTime).toBe(200);
			expect(entry!.vector[0]).toBeCloseTo(0, 5);
			expect(entry!.vector[1]).toBeCloseTo(1, 5);
		});

		it('only returns entries for the requested IDs that exist', async () => {
			await repo.saveMany([
				{ noteId: 'n1', vector: [1, 0], modelId: 'm1', updatedTime: 100 },
				{ noteId: 'n2', vector: [0, 1], modelId: 'm1', updatedTime: 100 },
			]);

			const result = await repo.getMany(['n1', 'n3']);

			expect(result.has('n1')).toBe(true);
			expect(result.has('n2')).toBe(false);
			expect(result.has('n3')).toBe(false);
		});

		it('does nothing for an empty entries array', async () => {
			await repo.saveMany([]);
			expect(db.opened).toBe(false);
		});
	});

	describe('large vaults', () => {
		it('chunks getMany so a single query never exceeds SQLite\'s bound-parameter limit', async () => {
			const noteIds = Array.from({ length: 1200 }, (_, i) => `n${i}`);
			await repo.saveMany(
				noteIds.map(id => ({ noteId: id, vector: [1, 0], modelId: 'm1', updatedTime: 1 })),
			);

			const result = await repo.getMany(noteIds);

			expect(result.size).toBe(1200);
			expect(db.allCallBatchSizes.length).toBeGreaterThan(1);
			for (const size of db.allCallBatchSizes) {
				expect(size).toBeLessThanOrEqual(500);
			}
			expect(db.allCallBatchSizes.reduce((a, b) => a + b, 0)).toBe(1200);
		});
	});
});
