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
	private scopeStateRow: { scope_key: string | null } | null = null;
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
		} else if (sql.includes('INTO scope_state')) {
			const [scopeKey] = params as [string];
			this.scopeStateRow = { scope_key: scopeKey };
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

	public async all<T>(sql: string): Promise<T[]> {
		if (sql.includes('FROM graph_cache')) {
			return (this.graphRow ? [this.graphRow] : []) as unknown as T[];
		}
		if (sql.includes('FROM sync_state')) {
			return (this.syncStateRow ? [this.syncStateRow] : []) as unknown as T[];
		}
		if (sql.includes('FROM scope_state')) {
			return (this.scopeStateRow ? [this.scopeStateRow] : []) as unknown as T[];
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

	describe('scope key', () => {
		it('returns null when no scope has ever been saved', async () => {
			expect(await repo.loadScopeKey()).toBeNull();
		});

		it('round-trips the scope key through save/load', async () => {
			await repo.saveScopeKey('current:folder-1');
			expect(await repo.loadScopeKey()).toBe('current:folder-1');
		});

		it('overwrites the previous scope key on a second save', async () => {
			await repo.saveScopeKey('all');
			await repo.saveScopeKey('current:folder-2');
			expect(await repo.loadScopeKey()).toBe('current:folder-2');
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
