import joplin from 'api';

export interface IVectorDatabase {
	open(): Promise<void>;
	run(sql: string, params: unknown[]): Promise<void>;
	all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

interface Sqlite3Database {
	run(sql: string, params: unknown[], callback: (err: Error | null) => void): void;
	all(
		sql: string,
		params: unknown[],
		callback: (err: Error | null, rows: unknown[]) => void
	): void;
	close(callback?: (err: Error | null) => void): void;
}

/**
 * Thin promisified wrapper around Joplin's bundled sqlite3 module (accessed via
 * `joplin.require('sqlite3')`, since native packages can't be bundled with a
 * plugin). Owns only the connection and schema; query logic lives in the
 * repository classes that use it.
 */
export class VectorDatabase implements IVectorDatabase {
	private db: Sqlite3Database | null = null;
	private opening: Promise<void> | null = null;

	public constructor(
		private readonly dbFileName: string,
		private readonly schemaStatements: string[]
	) {}

	/**
	 * Opens (creating if needed) the database. Safe to call repeatedly. A
	 * failed open is not cached: both `opening` and `db` are reset on
	 * rejection so a later call can retry from scratch, instead of either
	 * re-awaiting the same stale rejection or (if the connection itself
	 * succeeded but schema creation failed) treating a half-open database as
	 * ready forever.
	 */
	public async open(): Promise<void> {
		if (this.db) return;
		if (!this.opening) {
			this.opening = this.openInternal().catch((e) => {
				this.opening = null;
				if (this.db) {
					this.db.close();
					this.db = null;
				}
				throw e;
			});
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
		const dbPath = `${dataDir}/${this.dbFileName}`;

		this.db = await new Promise<Sqlite3Database>((resolve, reject) => {
			const db = new sqlite3.Database(dbPath, (err: Error | null) => {
				if (err) reject(err);
				else resolve(db);
			});
		});

		for (const statement of this.schemaStatements) {
			await this.run(statement, []);
		}
	}

	private requireDb(): Sqlite3Database {
		if (!this.db) {
			throw new Error(`VectorDatabase (${this.dbFileName}) used before open() completed.`);
		}
		return this.db;
	}
}
