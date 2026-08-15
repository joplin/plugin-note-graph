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
wrapper.

`open()` is safe to call repeatedly and concurrently: if opening fails, both
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

A cached vector is only reused if both its `note_id` and `model_id` match;
the caller (`EmbeddingOrchestrator`) also compares `updated_time` against
the note's current value to decide freshness. Changing the AI model in
Joplin settings naturally invalidates the whole cache, since every lookup
will then miss on `model_id`.

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
    embeddings_cursor TEXT
);
```

Managed by `GraphCacheRepository` (`src/data/Database/GraphCacheRepository.ts`).
Both tables are single-row (`CHECK (id = 1)`), upserted with
`ON CONFLICT(id) DO UPDATE`, since the plugin only ever needs "the current
state," not history.

- `graph_cache` holds the last successfully built `GraphData` plus the note
  list it was built from, serialized as JSON. `AnalysisController` writes
  this after every successful build (fire-and-forget; a write failure is
  logged, not propagated) and `index.ts` reads it on panel open to render
  instantly before a background sync sweep runs. Any Pass B `category` and
  `relationshipLabel` fields on that graph ride along in the same JSON, and
  `AnalysisController` reseeds `LLMEnricher`'s in-memory cache from them on
  load; see [LLM enrichment](llm-enrichment.md).
- `sync_state` holds the two pagination cursors used by
  `IncrementalUpdater`'s sync-complete sweep: `events_cursor` for
  `/events` (deletions and the AI-off change-detection fallback) and
  `embeddings_cursor` for `joplin.ai.getEmbeddings()` (change detection
  while AI analysis is on). See [Incremental
  updates](incremental-updates.md).

Graph-cache and sync-state writes go through the same kind of serialized
write queue as the vector cache, for the same reason: SQLite transactions
live on one shared connection.
