# Architecture

Note Graph is a Joplin desktop plugin. It has no server component and sends
no data anywhere except to Joplin's own AI subsystem (`joplin.ai`), and only
when semantic analysis or LLM enrichment is turned on. Everything else runs
inside the plugin sandbox that Joplin provides.

Graph building happens in two stages. **Pass A** is required: it builds the
graph itself, structural edges always and semantic edges when AI analysis is
enabled (see [Similarity engine](similarity-engine.md) and [Graph
model](graph-model.md)). **Pass B** is optional: it asks Joplin AI's chat
model to label what Pass A already found, category tags on notes and
relationship explanations on semantic edges, without discovering any new
edges of its own (see [LLM enrichment](llm-enrichment.md)).

The plugin is really two programs that talk to each other over Joplin's
webview message bridge:

- **The plugin script** (`src/index.ts` and everything under `src/data` and
  `src/services`), which runs in Joplin's plugin host. It reads notes, tags
  and links through the Joplin data API, builds the graph, and reacts to
  workspace events.
- **The webview panel** (`src/ui`), which renders the graph with
  [Cytoscape.js](https://js.cytoscape.org/) inside an isolated webview. It
  has no access to the Joplin API directly; it only receives messages from
  the plugin script.

## Module map

| Path | Responsibility |
|---|---|
| `src/data` | Reads notes, tags and links from the Joplin API; extracts links from note bodies. |
| `src/data/Database` | SQLite-backed caches: embedding vectors and the last built graph. |
| `src/services/embeddings` | Resolves an embedding provider and turns notes into vectors, with caching. |
| `src/services/similarity` | Turns embedding vectors and note metadata into scored note pairs, and those into graph edges. |
| `src/services/graph` | Builds the renderable graph: nodes, edges, community detection, centrality, diffing. |
| `src/services/llm` | Pass B: batches semantic edges to Joplin AI's chat model and parses category/relationship labels back onto the graph. |
| `src/services/sync` | Listens to Joplin workspace events and turns them into incremental graph updates. |
| `src/services/settings` | Registers and reads the plugin's settings. |
| `src/services/AnalysisController.ts` | Orchestrates the above into a single graph-building pipeline; the one class `index.ts` talks to. |
| `src/ui` | The webview panel: HTML shell, styling, and the Cytoscape-driven `graph-view.js` client. |

## Request flow: opening the graph

The **Show Note Graph** command shows the panel first, then calls
`ensureGraphLoaded()`, which is a no-op if a graph is already built this
session and otherwise does one of two things:

- **A cached graph exists on disk:** post it immediately, then in the
  background run a sync-complete sweep and, if labels are missing, an
  enrichment backfill (see [Incremental updates](incremental-updates.md)
  and [LLM enrichment](llm-enrichment.md)).
- **Nothing cached:** load notes, post the structural graph
  (`buildStructural`), then embed and post the semantic graph
  (`embedAndBuildSemantic`). If LLM enrichment is enabled, a Pass B
  follow-up then labels the semantic edges and posts a patch on top of the
  already-posted graph.

`ensureGraphLoaded()` is also the target of a callback the panel invokes
when it polls with no data to show and is visible; a 30-second cooldown
after a load failure keeps that from retrying in a tight loop. Concurrent
callers share one in-flight load rather than triggering it twice.

If semantic analysis is off or fails, the structural graph stays and a
one-line status message explains why; Pass B then has nothing to enrich.

## AnalysisController: the single orchestrator

`AnalysisController` (`src/services/AnalysisController.ts`) is the only
class `index.ts` calls into for building or rebuilding the graph. It owns:

- the last set of notes and their embeddings, so settings changes (threshold,
  top-K) can recompute the graph without re-fetching embeddings;
- a monotonically increasing `runToken`, so a slow build that gets
  superseded by a newer one (e.g. the user reopens the panel while an embed
  is still running) discards its result instead of overwriting fresher data;
- the last `GraphData`, diffed against each new build via `GraphDiffer` so
  incremental updates can push a patch instead of a full graph;
- the `LLMEnricher` instance for Pass B, whose in-memory cache it seeds from
  the persisted graph cache on `loadFromCache()`, so labels already computed
  in a previous session don't need to be re-requested from the model.

See [Data pipeline](data-pipeline.md) for how notes are loaded and enriched,
[Similarity engine](similarity-engine.md) for how semantic edges are scored,
[Graph model](graph-model.md) for how nodes and edges are assembled, [LLM
enrichment](llm-enrichment.md) for Pass B, and [Incremental
updates](incremental-updates.md) for what happens after the initial load.

## Persistence

Two SQLite databases live in the plugin's data directory
(`joplin.plugins.dataDir()`), opened lazily on first use:

- `note-graph-vectors.sqlite`: one row per note's embedding vector, keyed by
  note ID and model ID.
- `note-graph-cache.sqlite`: the last successfully built graph (so reopening
  the panel is instant) and the sync cursors used for incremental updates.

Details in [Caching](caching.md).
