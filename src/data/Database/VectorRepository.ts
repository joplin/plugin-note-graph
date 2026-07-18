import { IVectorDatabase, VectorDatabase } from './VectorDatabase';

export interface CachedVector {
	vector: number[];
	modelId: string;
	updatedTime: number;
}

export interface VectorCacheEntry {
	noteId: string;
	vector: number[];
	modelId: string;
	updatedTime: number;
}

export interface VectorCache {
	getMany(noteIds: string[]): Promise<Map<string, CachedVector>>;
	saveMany(entries: VectorCacheEntry[]): Promise<void>;
}

interface VectorRow {
	note_id: string;
	model_id: string;
	updated_time: number;
	vector: Buffer;
}

/**
 * Persists note embedding vectors in SQLite so unchanged notes aren't
 * re-fetched from joplin.ai.getEmbeddings(). A cached vector is only reused
 * when both its note_id and model_id match, since staleness is decided by
 * the caller comparing `updatedTime` against the note's current updated_time.
 */
export class VectorRepository implements VectorCache {
	/** SQLite caps bound parameters per statement (as low as 999 on some builds); stay well under it. */
	private static readonly QUERY_BATCH_SIZE = 500;

	/**
	 * Serializes writes: sqlite transactions live on the shared connection, so
	 * two interleaved saveMany calls would nest BEGIN TRANSACTION and error.
	 */
	private writeLock: Promise<void> = Promise.resolve();

	public constructor(private readonly db: IVectorDatabase = new VectorDatabase()) {}

	/** Returns cached vectors for the given note IDs, keyed by note ID. Missing notes are omitted. */
	public async getMany(noteIds: string[]): Promise<Map<string, CachedVector>> {
		if (noteIds.length === 0) {
			return new Map();
		}

		await this.db.open();

		const result = new Map<string, CachedVector>();
		for (const batch of this.chunk(noteIds, VectorRepository.QUERY_BATCH_SIZE)) {
			const rows = await this.queryBatch(batch);
			for (const row of rows) {
				result.set(row.note_id, {
					vector: this.decodeVector(row.vector),
					modelId: row.model_id,
					updatedTime: row.updated_time,
				});
			}
		}
		return result;
	}

	/** Inserts or updates vectors for the given notes, in a single transaction. Calls are serialized. */
	public saveMany(entries: VectorCacheEntry[]): Promise<void> {
		if (entries.length === 0) {
			return Promise.resolve();
		}

		const task = this.writeLock.then(() => this.saveManyInternal(entries));
		// Keep the lock chain alive whether this write succeeds or fails.
		this.writeLock = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}

	private async saveManyInternal(entries: VectorCacheEntry[]): Promise<void> {
		await this.db.open();

		await this.db.run('BEGIN TRANSACTION', []);
		try {
			for (const entry of entries) {
				await this.db.run(
					`INSERT INTO note_vectors (note_id, model_id, updated_time, vector)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(note_id) DO UPDATE SET
						model_id = excluded.model_id,
						updated_time = excluded.updated_time,
						vector = excluded.vector`,
					[
						entry.noteId,
						entry.modelId,
						entry.updatedTime,
						this.encodeVector(entry.vector),
					]
				);
			}
			await this.db.run('COMMIT', []);
		} catch (e) {
			// A failed ROLLBACK (e.g. "database is locked") must not mask the
			// original write error.
			try {
				await this.db.run('ROLLBACK', []);
			} catch (rollbackError) {
				console.error('Vector cache rollback failed after a write error:', rollbackError);
			}
			throw e;
		}
	}

	private async queryBatch(noteIds: string[]): Promise<VectorRow[]> {
		const placeholders = noteIds.map(() => '?').join(',');
		return this.db.all<VectorRow>(
			`SELECT note_id, model_id, updated_time, vector FROM note_vectors WHERE note_id IN (${placeholders})`,
			noteIds
		);
	}

	private chunk<T>(items: T[], size: number): T[][] {
		const batches: T[][] = [];
		for (let i = 0; i < items.length; i += size) {
			batches.push(items.slice(i, i + size));
		}
		return batches;
	}

	/** Encodes a vector as a Float32 BLOB for compact SQLite storage. */
	private encodeVector(vector: number[]): Buffer {
		const floats = Float32Array.from(vector);
		return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
	}

	/**
	 * Decodes a Float32 BLOB back into a plain number array. Copies the bytes
	 * first: Node pools small Buffers at arbitrary byte offsets, and viewing
	 * an unaligned offset with `new Float32Array(buffer, byteOffset, …)`
	 * throws a RangeError.
	 */
	private decodeVector(blob: Buffer): number[] {
		const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
		return Array.from(new Float32Array(copy));
	}
}
