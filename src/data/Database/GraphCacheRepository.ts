import { IVectorDatabase, VectorDatabase } from './VectorDatabase';
import { Note } from '../Types';
import { GraphData } from '../../services/graph/types';
import { Logger, consoleLogger } from '../../utils/Logger';

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

const ENRICHMENT_CACHE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS enrichment_cache (
		kind TEXT NOT NULL,
		id TEXT NOT NULL,
		updated_time INTEGER NOT NULL,
		enrichment_json TEXT NOT NULL,
		PRIMARY KEY (kind, id)
	)
`;

const LAYOUT_CACHE_SCHEMA = `
	CREATE TABLE IF NOT EXISTS layout_cache (
		layout_key TEXT PRIMARY KEY,
		positions_json TEXT NOT NULL
	)
`;

/** Each view of each notebook saves a layout, so keep only the most recent. */
const MAX_SAVED_LAYOUTS = 30;

/**
 * Applied in order, once each. Only ever add to the end. The last three date from
 * when the graph began to hold the whole vault and record each note's notebook: an
 * older cached graph may cover one notebook and lacks that, so it can't be reused.
 */
const MIGRATIONS = [
	'ALTER TABLE sync_state ADD COLUMN embeddings_model TEXT',
	'DROP TABLE IF EXISTS scope_state',
	'DELETE FROM graph_cache',
	'DELETE FROM layout_cache',
];

interface GraphCacheRow {
	notes_json: string;
	graph_json: string;
}

interface SyncStateRow {
	events_cursor: string | null;
	embeddings_cursor: string | null;
}

interface EnrichmentCacheRow {
	kind: string;
	id: string;
	updated_time: number;
	enrichment_json: string;
}

export type NodePositions = Record<string, { x: number; y: number }>;

/** Stores computed node positions, so reopening a graph doesn't need a new layout. */
export interface LayoutStore {
	loadLayout(layoutKey: string): Promise<NodePositions | null>;
	saveLayout(layoutKey: string, positions: NodePositions): Promise<void>;
}

export interface PersistedEnrichment {
	kind: 'node' | 'edge';
	id: string;
	updatedTime: number;
	enrichment: Record<string, unknown>;
}

export class GraphCacheRepository implements LayoutStore {
	private writeLock: Promise<void> = Promise.resolve();

	public constructor(
		private readonly db: IVectorDatabase = new VectorDatabase(
			DB_FILE_NAME,
			[GRAPH_CACHE_SCHEMA, SYNC_STATE_SCHEMA, ENRICHMENT_CACHE_SCHEMA, LAYOUT_CACHE_SCHEMA],
			MIGRATIONS
		),
		private readonly logger: Logger = consoleLogger
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

	public async loadEmbeddingsModel(): Promise<string | null> {
		await this.db.open();
		const rows = await this.db.all<{ embeddings_model: string | null }>(
			'SELECT embeddings_model FROM sync_state WHERE id = 1',
			[]
		);
		return rows[0]?.embeddings_model ?? null;
	}

	public saveEmbeddingsModel(modelId: string): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run(
				`INSERT INTO sync_state (id, embeddings_model)
				 VALUES (1, ?)
				 ON CONFLICT(id) DO UPDATE SET embeddings_model = excluded.embeddings_model`,
				[modelId]
			);
		});
	}

	/** Forgets the sweep position, so the next sweep starts over. Needed when the embedding model changes. */
	public clearEmbeddingsCursor(): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run('UPDATE sync_state SET embeddings_cursor = NULL WHERE id = 1', []);
		});
	}

	public async loadLayout(layoutKey: string): Promise<NodePositions | null> {
		await this.db.open();
		const rows = await this.db.all<{ positions_json: string }>(
			'SELECT positions_json FROM layout_cache WHERE layout_key = ?',
			[layoutKey]
		);
		return rows[0] ? (JSON.parse(rows[0].positions_json) as NodePositions) : null;
	}

	public saveLayout(layoutKey: string, positions: NodePositions): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run('DELETE FROM layout_cache WHERE layout_key = ?', [layoutKey]);
			await this.db.run(
				'INSERT INTO layout_cache (layout_key, positions_json) VALUES (?, ?)',
				[layoutKey, JSON.stringify(positions)]
			);
			await this.db.run(
				`DELETE FROM layout_cache WHERE rowid NOT IN
				 (SELECT rowid FROM layout_cache ORDER BY rowid DESC LIMIT ?)`,
				[MAX_SAVED_LAYOUTS]
			);
		});
	}

	public clearGraph(): Promise<void> {
		return this.enqueueWrite(async () => {
			await this.db.open();
			await this.db.run('DELETE FROM graph_cache WHERE id = 1', []);
			await this.db.run('DELETE FROM layout_cache', []);
		});
	}

	public async hasEnrichments(): Promise<boolean> {
		await this.db.open();
		const rows = await this.db.all<{ id: string }>(
			'SELECT id FROM enrichment_cache LIMIT 1',
			[]
		);
		return rows.length > 0;
	}

	/** Removes labels for notes that no longer exist. Only call this with a complete, whole-vault list. */
	public async pruneEnrichments(noteIdsToKeep: Set<string>): Promise<void> {
		await this.db.open();
		const rows = await this.db.all<{ kind: string; id: string }>(
			'SELECT kind, id FROM enrichment_cache',
			[]
		);
		const stale = rows.filter((row) =>
			row.kind === 'node'
				? !noteIdsToKeep.has(row.id)
				: row.id
						.split('::')
						.slice(0, 2)
						.some((noteId) => !noteIdsToKeep.has(noteId))
		);
		if (stale.length === 0) return;

		await this.enqueueWrite(() =>
			this.inTransaction(async () => {
				for (const row of stale) {
					await this.db.run('DELETE FROM enrichment_cache WHERE kind = ? AND id = ?', [
						row.kind,
						row.id,
					]);
				}
			})
		);
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
			await this.inTransaction(async () => {
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
			});
		});
	}

	/** Many writes in one transaction cost one disk commit instead of one each, and apply all together or not at all. */
	private async inTransaction(work: () => Promise<void>): Promise<void> {
		await this.db.run('BEGIN TRANSACTION', []);
		try {
			await work();
			await this.db.run('COMMIT', []);
		} catch (e) {
			try {
				await this.db.run('ROLLBACK', []);
			} catch (rollbackError) {
				this.logger.error(
					'Enrichment cache rollback failed after a write error:',
					rollbackError
				);
			}
			throw e;
		}
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
