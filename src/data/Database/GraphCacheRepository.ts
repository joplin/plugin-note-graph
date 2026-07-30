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

interface GraphCacheRow {
	notes_json: string;
	graph_json: string;
}

interface SyncStateRow {
	events_cursor: string | null;
	embeddings_cursor: string | null;
}

export class GraphCacheRepository {
	private writeLock: Promise<void> = Promise.resolve();

	public constructor(
		private readonly db: IVectorDatabase = new VectorDatabase(DB_FILE_NAME, [
			GRAPH_CACHE_SCHEMA,
			SYNC_STATE_SCHEMA,
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

	private enqueueWrite(write: () => Promise<void>): Promise<void> {
		const task = this.writeLock.then(write);
		this.writeLock = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}
}
