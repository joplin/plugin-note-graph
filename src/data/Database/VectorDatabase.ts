import joplin from 'api';

export interface IVectorDatabase {
	open(): Promise<void>;
	run(sql: string, params: unknown[]): Promise<void>;
	all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

interface Sqlite3Database {
	run(sql: string, params: unknown[], callback: (err: Error | null) => void): void;
	all(sql: string, params: unknown[], callback: (err: Error | null, rows: unknown[]) => void): void;
}

/**
 * Thin promisified wrapper around Joplin's bundled sqlite3 module (accessed via
 * `joplin.require('sqlite3')`, since native packages can't be bundled with a
 * plugin). Owns only the connection and schema; query logic lives in
 * VectorRepository.
 */
export class VectorDatabase implements IVectorDatabase {
	private static readonly DB_FILE_NAME = 'note-graph-vectors.sqlite';
	private static readonly SCHEMA = `
		CREATE TABLE IF NOT EXISTS note_vectors (
			note_id TEXT PRIMARY KEY,
			model_id TEXT NOT NULL,
			updated_time INTEGER NOT NULL,
			vector BLOB NOT NULL
		)
	`;

	private db: Sqlite3Database | null = null;
	private opening: Promise<void> | null = null;

	/** Opens (creating if needed) the vector cache database. Safe to call repeatedly. */
	public async open(): Promise<void> {
		if (this.db) return;
		if (!this.opening) {
			this.opening = this.openInternal();
		}
		await this.opening;
	}

	public async run(sql: string, params: unknown[]): Promise<void> {
		const db = this.requireDb();
		await new Promise<void>((resolve, reject) => {
			db.run(sql, params, (err) => (err ? reject(err) : resolve()));
		});
	}

	public async all<T>(sql: string, params: unknown[]): Promise<T[]> {
		const db = this.requireDb();
		return new Promise<T[]>((resolve, reject) => {
			db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
		});
	}

	private async openInternal(): Promise<void> {
		const sqlite3 = joplin.require('sqlite3');
		const dataDir = await joplin.plugins.dataDir();
		const dbPath = `${dataDir}/${VectorDatabase.DB_FILE_NAME}`;

		this.db = await new Promise<Sqlite3Database>((resolve, reject) => {
			const db = new sqlite3.Database(dbPath, (err: Error | null) => {
				if (err) reject(err);
				else resolve(db);
			});
		});

		await this.run(VectorDatabase.SCHEMA, []);
	}

	private requireDb(): Sqlite3Database {
		if (!this.db) {
			throw new Error('VectorDatabase used before open() completed.');
		}
		return this.db;
	}
}
