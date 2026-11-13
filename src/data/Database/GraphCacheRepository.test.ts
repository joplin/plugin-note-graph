import { GraphCacheRepository } from './GraphCacheRepository';
import { IVectorDatabase } from './VectorDatabase';
import { GraphData } from '../../services/graph/types';
import { Note } from '../Types';

class FakeConnection implements IVectorDatabase {
	public opened = false;
	private graphRow: { notes_json: string; graph_json: string } | null = null;
	private syncStateRow: {
		events_cursor: string | null;
		embeddings_cursor: string | null;
	} | null = null;
	private layouts = new Map<string, string>();
	private enrichmentRows: {
		kind: string;
		id: string;
		updated_time: number;
		enrichment_json: string;
	}[] = [];

	public async open(): Promise<void> {
		this.opened = true;
	}

	public async run(sql: string, params: unknown[]): Promise<void> {
		if (sql.includes('DELETE FROM graph_cache')) {
			this.graphRow = null;
		} else if (sql.includes('DELETE FROM layout_cache WHERE layout_key')) {
			this.layouts.delete((params as [string])[0]);
		} else if (sql.includes('DELETE FROM layout_cache WHERE rowid')) {
			const [limit] = params as [number];
			const keys = Array.from(this.layouts.keys());
			for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
				this.layouts.delete(key);
			}
		} else if (sql.includes('DELETE FROM layout_cache')) {
			this.layouts.clear();
		} else if (sql.includes('INTO layout_cache')) {
			const [key, json] = params as [string, string];
			this.layouts.set(key, json);
		} else if (sql.includes('DELETE FROM enrichment_cache')) {
			const [kind, id] = params as [string, string];
			this.enrichmentRows = this.enrichmentRows.filter(
				(row) => !(row.kind === kind && row.id === id)
			);
		} else if (sql.includes('INTO graph_cache')) {
			const [notesJson, graphJson] = params as [string, string, number];
			this.graphRow = { notes_json: notesJson, graph_json: graphJson };
		} else if (sql.includes('embeddings_cursor')) {
			const [cursor] = params as [string];
			this.syncStateRow = {
				events_cursor: this.syncStateRow?.events_cursor ?? null,
				embeddings_cursor: cursor,
			};
		} else if (sql.includes('INTO sync_state')) {
			const [cursor] = params as [string];
			this.syncStateRow = {
				events_cursor: cursor,
				embeddings_cursor: this.syncStateRow?.embeddings_cursor ?? null,
			};
		} else if (sql.includes('INTO enrichment_cache')) {
			const [kind, id, updatedTime, enrichmentJson] = params as [
				string,
				string,
				number,
				string
			];
			const existing = this.enrichmentRows.find((row) => row.kind === kind && row.id === id);
			if (existing) {
				existing.updated_time = updatedTime;
				existing.enrichment_json = enrichmentJson;
			} else {
				this.enrichmentRows.push({
					kind,
					id,
					updated_time: updatedTime,
					enrichment_json: enrichmentJson,
				});
			}
		}
	}

	public async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		if (sql.includes('FROM layout_cache')) {
			const json = this.layouts.get((params as [string])[0]);
			return (json ? [{ positions_json: json }] : []) as unknown as T[];
		}
		if (sql.includes('FROM graph_cache')) {
			return (this.graphRow ? [this.graphRow] : []) as unknown as T[];
		}
		if (sql.includes('FROM sync_state')) {
			return (this.syncStateRow ? [this.syncStateRow] : []) as unknown as T[];
		}
		if (sql.includes('FROM enrichment_cache')) {
			return this.enrichmentRows as unknown as T[];
		}
		return [];
	}
}

const note: Note = {
	id: 'n1',
	parent_id: 'p1',
	title: 'Note 1',
	body: 'body',
	created_time: 1,
	updated_time: 2,
};

const graphData: GraphData = {
	nodes: [
		{ data: { id: 'n1', label: 'Note 1', noteId: 'n1', degree: 0, community: 0, size: 1 } },
	],
	edges: [],
};

describe('GraphCacheRepository lifecycle', () => {
	it('stores and reloads a layout by key', async () => {
		const repo = new GraphCacheRepository(new FakeConnection());

		await repo.saveLayout('view', { a: { x: 1, y: 2 } });

		await expect(repo.loadLayout('view')).resolves.toEqual({ a: { x: 1, y: 2 } });
		await expect(repo.loadLayout('other')).resolves.toBeNull();
	});

	it('keeps only the most recently saved layouts, counting a re-save as recent', async () => {
		const repo = new GraphCacheRepository(new FakeConnection());

		await repo.saveLayout('oldest', { a: { x: 1, y: 1 } });
		await repo.saveLayout('resaved', { a: { x: 2, y: 2 } });
		for (let i = 0; i < 28; i++) await repo.saveLayout(`view-${i}`, { a: { x: i, y: i } });
		await repo.saveLayout('resaved', { a: { x: 3, y: 3 } });
		await repo.saveLayout('newest', { a: { x: 4, y: 4 } });

		await expect(repo.loadLayout('oldest')).resolves.toBeNull();
		await expect(repo.loadLayout('resaved')).resolves.toEqual({ a: { x: 3, y: 3 } });
		await expect(repo.loadLayout('newest')).resolves.toEqual({ a: { x: 4, y: 4 } });
	});

	it('discards saved layouts along with the cached graph', async () => {
		const repo = new GraphCacheRepository(new FakeConnection());
		await repo.saveLayout('view', { a: { x: 1, y: 2 } });

		await repo.clearGraph();

		await expect(repo.loadLayout('view')).resolves.toBeNull();
	});

	it('prunes labels for notes that no longer exist, for both nodes and edges', async () => {
		const repo = new GraphCacheRepository(new FakeConnection());
		const enrichment = { updatedTime: 1, enrichment: {} };
		await repo.saveEnrichments([
			{ kind: 'node', id: 'keep', ...enrichment },
			{ kind: 'node', id: 'gone', ...enrichment },
			{ kind: 'edge', id: 'keep::keep2::semantic', ...enrichment },
			{ kind: 'edge', id: 'keep::gone::semantic', ...enrichment },
		]);

		await repo.pruneEnrichments(new Set(['keep', 'keep2']));

		const remaining = (await repo.loadEnrichments()).map((record) => record.id);
		expect(remaining).toEqual(['keep', 'keep::keep2::semantic']);
	});

	it('prunes in a single transaction, so many deletions cost one disk commit', async () => {
		const connection = new FakeConnection();
		const statements: string[] = [];
		const run = connection.run.bind(connection);
		connection.run = async (sql: string, params: unknown[]) => {
			statements.push(sql);
			return run(sql, params);
		};
		const repo = new GraphCacheRepository(connection);
		await repo.saveEnrichments([
			{ kind: 'node', id: 'a', updatedTime: 1, enrichment: {} },
			{ kind: 'node', id: 'b', updatedTime: 1, enrichment: {} },
		]);
		statements.length = 0;

		await repo.pruneEnrichments(new Set());

		expect(statements[0]).toBe('BEGIN TRANSACTION');
		expect(statements[statements.length - 1]).toBe('COMMIT');
		expect(statements.filter((sql) => sql.includes('DELETE'))).toHaveLength(2);
	});

	it('reports whether any labels are stored', async () => {
		const repo = new GraphCacheRepository(new FakeConnection());
		await expect(repo.hasEnrichments()).resolves.toBe(false);

		await repo.saveEnrichments([{ kind: 'node', id: 'a', updatedTime: 1, enrichment: {} }]);

		await expect(repo.hasEnrichments()).resolves.toBe(true);
	});
});

describe('GraphCacheRepository', () => {
	let db: FakeConnection;
	let repo: GraphCacheRepository;

	beforeEach(() => {
		db = new FakeConnection();
		repo = new GraphCacheRepository(db);
	});

	describe('graph cache', () => {
		it('returns null when nothing has been cached yet', async () => {
			const result = await repo.loadGraph();
			expect(result).toBeNull();
		});

		it('round-trips notes and graph data through save/load', async () => {
			await repo.saveGraph([note], graphData);

			const result = await repo.loadGraph();

			expect(result).toEqual({ notes: [note], graphData });
		});

		it('overwrites the previous cache on a second save', async () => {
			await repo.saveGraph([note], graphData);
			const secondNote = { ...note, title: 'Updated' };
			await repo.saveGraph([secondNote], graphData);

			const result = await repo.loadGraph();

			expect(result?.notes[0].title).toBe('Updated');
		});
	});

	describe('events cursor', () => {
		it('returns null when sync has never run', async () => {
			const cursor = await repo.loadEventsCursor();
			expect(cursor).toBeNull();
		});

		it('round-trips the cursor through save/load', async () => {
			await repo.saveEventsCursor('cursor-1');
			expect(await repo.loadEventsCursor()).toBe('cursor-1');
		});

		it('overwrites the previous cursor on a second save', async () => {
			await repo.saveEventsCursor('cursor-1');
			await repo.saveEventsCursor('cursor-2');
			expect(await repo.loadEventsCursor()).toBe('cursor-2');
		});
	});

	describe('embeddings cursor', () => {
		it('returns null when the AI-on sweep has never run', async () => {
			const cursor = await repo.loadEmbeddingsCursor();
			expect(cursor).toBeNull();
		});

		it('round-trips the cursor through save/load', async () => {
			await repo.saveEmbeddingsCursor('embeddings-cursor-1');
			expect(await repo.loadEmbeddingsCursor()).toBe('embeddings-cursor-1');
		});

		it('overwrites the previous cursor on a second save', async () => {
			await repo.saveEmbeddingsCursor('embeddings-cursor-1');
			await repo.saveEmbeddingsCursor('embeddings-cursor-2');
			expect(await repo.loadEmbeddingsCursor()).toBe('embeddings-cursor-2');
		});

		it('saving the events cursor and the embeddings cursor never clobbers the other', async () => {
			await repo.saveEventsCursor('events-cursor-1');
			await repo.saveEmbeddingsCursor('embeddings-cursor-1');
			await repo.saveEventsCursor('events-cursor-2');

			expect(await repo.loadEventsCursor()).toBe('events-cursor-2');
			expect(await repo.loadEmbeddingsCursor()).toBe('embeddings-cursor-1');
		});
	});

	describe('clearGraph', () => {
		it('removes the cached graph so a later load returns null', async () => {
			await repo.saveGraph([note], graphData);

			await repo.clearGraph();

			expect(await repo.loadGraph()).toBeNull();
		});

		it('leaves the events and embeddings cursors untouched', async () => {
			await repo.saveGraph([note], graphData);
			await repo.saveEventsCursor('cursor-1');
			await repo.saveEmbeddingsCursor('embeddings-cursor-1');

			await repo.clearGraph();

			expect(await repo.loadEventsCursor()).toBe('cursor-1');
			expect(await repo.loadEmbeddingsCursor()).toBe('embeddings-cursor-1');
		});
	});

	describe('enrichment cache', () => {
		it('returns an empty list when nothing has been persisted', async () => {
			expect(await repo.loadEnrichments()).toEqual([]);
		});

		it('round-trips node and edge enrichments through save/load', async () => {
			await repo.saveEnrichments([
				{ kind: 'node', id: 'n1', updatedTime: 1, enrichment: { category: 'Cat' } },
				{
					kind: 'edge',
					id: 'a::b::semantic',
					updatedTime: 2,
					enrichment: { relationshipLabel: 'links' },
				},
			]);

			expect(await repo.loadEnrichments()).toEqual([
				{ kind: 'node', id: 'n1', updatedTime: 1, enrichment: { category: 'Cat' } },
				{
					kind: 'edge',
					id: 'a::b::semantic',
					updatedTime: 2,
					enrichment: { relationshipLabel: 'links' },
				},
			]);
		});

		it('upserts on a repeated save for the same kind and id', async () => {
			await repo.saveEnrichments([
				{ kind: 'node', id: 'n1', updatedTime: 1, enrichment: { category: 'Old' } },
			]);
			await repo.saveEnrichments([
				{ kind: 'node', id: 'n1', updatedTime: 3, enrichment: { category: 'New' } },
			]);

			expect(await repo.loadEnrichments()).toEqual([
				{ kind: 'node', id: 'n1', updatedTime: 3, enrichment: { category: 'New' } },
			]);
		});
	});

	describe('write serialization', () => {
		it('serializes interleaved graph and cursor writes instead of racing them', async () => {
			const order: string[] = [];
			const originalRun = db.run.bind(db);
			db.run = async (sql: string, params: unknown[]) => {
				order.push(sql.includes('graph_cache') ? 'graph' : 'cursor');
				await originalRun(sql, params);
			};

			await Promise.all([
				repo.saveGraph([note], graphData),
				repo.saveEventsCursor('cursor-1'),
			]);

			expect(order).toHaveLength(2);
			expect(await repo.loadGraph()).not.toBeNull();
			expect(await repo.loadEventsCursor()).toBe('cursor-1');
		});
	});
});
