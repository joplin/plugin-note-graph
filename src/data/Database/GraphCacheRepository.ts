import { IVectorDatabase, VectorDatabase } from './VectorDatabase';
import { Note } from '../Types';
import { GraphData } from '../../services/graph/types';

const DB_FILE_NAME = 'note-graph-cache.sqlite';

const GRAPH_CACHE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS graph_cache (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		notes_json TEXT NOT NULL,
		graph_json TEXT NOT NULL,
		updated_time INTEGER NOT NULL
	)
`;

const SYNC_STATE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS sync_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		events_cursor TEXT,
		embeddings_cursor TEXT
	)
`;

const SCOPE_STATE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS scope_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		scope_key TEXT
	)
`;

const ENRICHMENT_CACHE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS enrichment_cache (
		kind TEXT NOT NULL,
		id TEXT NOT NULL,
		updated_time INTEGER NOT NULL,
		enrichment_json TEXT NOT NULL,
		PRIMARY KEY (kind, id)
	)
`;

interface GraphCacheRow {
	notes_json: string;
	graph_json: string;
}

interface SyncStateRow {
	events_cursor: string | null;
	embeddings_cursor: string | null;
}

interface ScopeStateRow {
	scope_key: string | null;
}

interface EnrichmentCacheRow {
	kind: string;
	id: string;
	updated_time: number;
	enrichment_json: string;
}

export interface PersistedEnrichment {
	kind: 'node' | 'edge';
	id: string;
	updatedTime: number;
	enrichment: Record<string, unknown>;
}

export class GraphCacheRepository {
	private writeLock: Promise<void> = Promise.resolve();

	public constructor(
		private readonly db: IVectorDatabase = new VectorDatabase(DB_FILE_NAME, [
			GRAPH_CACHE_SCHEMA,
			SYNC_STATE_SCHEMA,
			SCOPE_STATE_SCHEMA,
			ENRICHMENT_CACHE_SCHEMA,
		])
	) {}

	public async loadGraph(): Promise<{ notes: Note[]; graphData: GraphData } | null> {
		await this.db.open();
		const rows = await this.db.all<GraphCacheRow>(
			'SELECT notes_json, graph_json FROM graph_cache WHERE id = 1',
			[]
		);
		const row = rows[0];
		if (!row) return null;

		return {
			notes: JSON.parse(row.notes_json) as Note[],
			graphData: JSON.parse(row.graph_json) as GraphData,
		};
	}

	public saveGraph(notes: Note[], graphData: GraphData): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run(
				`INSERT INTO graph_cache (id, notes_json, graph_json, updated_time)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					notes_json = excluded.notes_json,
					graph_json = excluded.graph_json,
					updated_time = excluded.updated_time`,
				[JSON.stringify(notes), JSON.stringify(graphData), Date.now()]
			);
		});
	}

	public async loadEventsCursor(): Promise<string | null> {
		await this.db.open();
		const rows = await this.db.all<SyncStateRow>(
			'SELECT events_cursor FROM sync_state WHERE id = 1',
			[]
		);
		return rows[0]?.events_cursor ?? null;
	}

	public saveEventsCursor(cursor: string): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run(
				`INSERT INTO sync_state (id, events_cursor)
				 VALUES (1, ?)
				 ON CONFLICT(id) DO UPDATE SET events_cursor = excluded.events_cursor`,
				[cursor]
			);
		});
	}

	public async loadEmbeddingsCursor(): Promise<string | null> {
		await this.db.open();
		const rows = await this.db.all<SyncStateRow>(
			'SELECT embeddings_cursor FROM sync_state WHERE id = 1',
			[]
		);
		return rows[0]?.embeddings_cursor ?? null;
	}

	public saveEmbeddingsCursor(cursor: string): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run(
				`INSERT INTO sync_state (id, embeddings_cursor)
				 VALUES (1, ?)
				 ON CONFLICT(id) DO UPDATE SET embeddings_cursor = excluded.embeddings_cursor`,
				[cursor]
			);
		});
	}

	public async loadScopeKey(): Promise<string | null> {
		await this.db.open();
		const rows = await this.db.all<ScopeStateRow>(
			'SELECT scope_key FROM scope_state WHERE id = 1',
			[]
		);
		return rows[0]?.scope_key ?? null;
	}

	public saveScopeKey(scopeKey: string): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run(
				`INSERT INTO scope_state (id, scope_key)
				 VALUES (1, ?)
				 ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key`,
				[scopeKey]
			);
		});
	}

	public clearGraph(): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run('DELETE FROM graph_cache WHERE id = 1', []);
		});
	}

	public async loadEnrichments(): Promise<PersistedEnrichment[]> {
		await this.db.open();
		const rows = await this.db.all<EnrichmentCacheRow>(
			'SELECT kind, id, updated_time, enrichment_json FROM enrichment_cache',
			[]
		);
		return rows.map((row) => ({
			kind: row.kind === 'node' ? 'node' : 'edge',
			id: row.id,
			updatedTime: row.updated_time,
			enrichment: JSON.parse(row.enrichment_json) as Record<string, unknown>,
		}));
	}

	public saveEnrichments(records: PersistedEnrichment[]): Promise<void> {
		if (records.length === 0) return Promise.resolve();
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run('BEGIN TRANSACTION', []);
			try {
				for (const record of records) {
					await this.db.run(
						`INSERT INTO enrichment_cache (kind, id, updated_time, enrichment_json)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(kind, id) DO UPDATE SET
							updated_time = excluded.updated_time,
							enrichment_json = excluded.enrichment_json`,
						[record.kind, record.id, record.updatedTime, JSON.stringify(record.enrichment)]
					);
				}
				await this.db.run('COMMIT', []);
			} catch (e) {
				try {
					await this.db.run('ROLLBACK', []);
				} catch (rollbackError) {
					console.error(
						'Enrichment cache rollback failed after a write error:',
						rollbackError
					);
				}
				throw e;
			}
		});
	}

	private enqueueWrite(write: () => Promise<void>): Promise<void> {
		const task = this.writeLock.then(write);
		this.writeLock = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}
}
