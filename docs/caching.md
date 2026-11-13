# Caching

The plugin persists two things to disk so it doesn't have to re-fetch or
re-embed everything on every panel open: embedding vectors, and the last
built graph plus sync cursors. Both live in Joplin's per-plugin data
directory (`joplin.plugins.dataDir()`), as separate SQLite files.

## Why SQLite, and how it's accessed

Native Node modules can't be bundled into a plugin the normal way, so the
database access goes through Joplin's own bundled `sqlite3` module via
`joplin.require('sqlite3')`. `VectorDatabase`
(`src/data/Database/VectorDatabase.ts`) is a thin promisified wrapper around
that callback-based driver: it owns the connection and runs the schema's
`CREATE TABLE IF NOT EXISTS` statements on open, and exposes `run()` and
`all()`. Query logic itself lives in the repository classes, not in this
wrapper. Each database has one shared connection for the life of the plugin, with
a busy timeout so concurrent writes wait instead of failing.

Schema changes are migrations: statements applied in order, once each, tracked
with SQLite's `user_version`. Only ever add to the end of a migration list. Each
migration and its `user_version` bump run in one transaction, so a crash can't leave a
migration applied but unrecorded, which would fail when it ran again.

`open()` is safe to call repeatedly and concurrently. Every caller waits until the
schema and migrations are in place, not just until the connection exists. If opening fails, both
the in-progress promise and the (possibly half-created) connection are
reset, so a later call retries cleanly instead of replaying a stale
rejection or treating a half-open database as ready.

## Vector cache

**File:** `note-graph-vectors.sqlite`

```sql
CREATE TABLE IF NOT EXISTS note_vectors (
    note_id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    updated_time INTEGER NOT NULL,
    vector BLOB NOT NULL
)
```

Managed by `VectorRepository` (`src/data/Database/VectorRepository.ts`),
used by `EmbeddingOrchestrator` (see [Similarity
engine](similarity-engine.md)). Vectors are stored as `Float32` BLOBs
(`Buffer.from(Float32Array.buffer, ...)`), not JSON, to keep storage compact.
Decoding copies the underlying bytes before viewing them as a
`Float32Array`, because Node can place a small `Buffer` at an unaligned byte
offset inside a shared pool, and viewing that directly would throw.

A cached vector is reused if its `model_id` matches. `updated_time` is not used to
decide freshness, because Joplin re-embeds an edit minutes later, so right after an
edit it can't say whether a vector is current. Embedding sweeps keep vectors fresh
instead; see [Incremental updates](incremental-updates.md#embedding-sweeps). Changing
the AI model in Joplin settings invalidates the whole cache, since every lookup then
misses on `model_id`.

Rows for deleted notes are removed as they're deleted, and again on each complete
whole-vault load.

Reads are batched (up to 500 note IDs per `SELECT ... WHERE note_id IN (...)`,
`QUERY_BATCH_SIZE`) to stay under SQLite's bound-parameter limit. Writes run
inside a single transaction per `saveMany()` call and are serialized through
an internal promise chain, since two interleaved transactions on the same
connection would otherwise nest `BEGIN TRANSACTION` and error.

## Graph cache and sync state

**File:** `note-graph-cache.sqlite`

```sql
CREATE TABLE IF NOT EXISTS graph_cache (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    notes_json TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    updated_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    events_cursor TEXT,
    embeddings_cursor TEXT,
    embeddings_model TEXT   -- added by a migration
);

CREATE TABLE IF NOT EXISTS layout_cache (
    layout_key TEXT PRIMARY KEY,
    positions_json TEXT NOT NULL
);
```

Managed by `GraphCacheRepository` (`src/data/Database/GraphCacheRepository.ts`).
Both tables are single-row (`CHECK (id = 1)`), upserted with
`ON CONFLICT(id) DO UPDATE`, since the plugin only ever needs "the current
state," not history.

- `graph_cache` holds the last successfully built `GraphData` plus the note
  list it was built from, serialized as JSON. Note bodies are kept only as
  600-character excerpts. Writes wait three seconds and save only the latest graph,
  so a burst of changes means one write. `AnalysisController` writes
  this after every successful build (fire-and-forget; a write failure is
  logged, not propagated), except while the loaded notes are incomplete, so
  a partial graph can't replace a good cached one, and `index.ts` reads it on panel open to render
  instantly before a background sync sweep runs. Any Pass B `category` and
  `relationshipLabel` fields on that graph ride along in the same JSON, and
  `AnalysisController` reseeds `LLMEnricher`'s in-memory cache from them on
  load; see [LLM enrichment](llm-enrichment.md).
- `layout_cache` holds computed node positions for each notebook's main view, keyed by
  view, layout and grouping, so reopening a graph needs no new layout. Only the 30 most
  recently saved are kept. See [Large vaults](large-vaults.md).
- `sync_state` holds the two pagination cursors used by
  `IncrementalUpdater`'s sync-complete sweep: `events_cursor` for
  `/events` (deletions and the AI-off change-detection fallback) and
  `embeddings_cursor` for `joplin.ai.getEmbeddings()` (change detection
  while AI analysis is on). See [Incremental
  updates](incremental-updates.md).

Graph-cache and sync-state writes go through the same kind of serialized
write queue as the vector cache, for the same reason: SQLite transactions
live on one shared connection.
