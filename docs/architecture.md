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
  [Cytoscape.js](https://js.cytoscape.org/) inside an iframe. It has no access
  to the Joplin API directly; it only receives messages from the plugin script.
  It shares Joplin's UI thread, so all heavy work, including layout, happens in
  the plugin script. See [Large vaults](large-vaults.md). The same page also
  runs in a popup, described [below](#the-popup).

## Module map

| Path | Responsibility |
|---|---|
| `src/data` | Reads notes, tags and links from the Joplin API; extracts links from note bodies. |
| `src/data/Database` | SQLite-backed caches: embedding vectors and the last built graph. |
| `src/services/embeddings` | Resolves an embedding provider and turns notes into vectors, with caching. |
| `src/services/similarity` | Turns embedding vectors and note metadata into scored note pairs, and those into graph edges. |
| `src/services/graph` | Builds the graph (nodes, edges, community detection, centrality), and decides what the panel shows: bounded views, positions and patches. |
| `src/services/llm` | Pass B: batches semantic edges to Joplin AI's chat model and parses category/relationship labels back onto the graph. |
| `src/services/sync` | Listens to Joplin workspace events and turns them into incremental graph updates. |
| `src/services/settings` | Registers and reads the plugin's settings. |
| `src/services/status` | What the panel's "Graph status" view shows: the state of each step, in plain words, and the latest problems logged. |
| `src/services/AnalysisController.ts` | Orchestrates the above into a single graph-building pipeline. |
| `src/services/NoteLoader.ts` | Loads every note in the vault, and reports whether the load was complete. |
| `src/utils` | Shared helpers: retry with backoff, and the `Logger` interface. |
| `src/ui` | The webview panel: HTML shell, styling, and the Cytoscape-driven `graph-view.js` client. |

## Request flow: opening the graph

The **Show Note Graph** command shows the panel first, then calls
`ensureGraphLoaded()`, which is a no-op if a graph is already built this
session and otherwise does one of two things:

- **A cached graph exists on disk:** post it immediately, then in the
  background run a sync-complete sweep and, if labels are missing, an
  enrichment backfill (see [Incremental updates](incremental-updates.md)
  and [LLM enrichment](llm-enrichment.md)).
- **Nothing cached:** load notes, show the structural graph
  (`buildStructural`), then embed and show the semantic graph
  (`embedAndBuildSemantic`). If LLM enrichment is enabled, a Pass B
  follow-up then labels the semantic edges and posts a patch on top of the
  already-posted graph.

`ensureGraphLoaded()` is also the target of a callback the panel invokes
when it polls with no data to show and is visible; a 30-second cooldown
after a load failure keeps that from retrying in a tight loop. Concurrent
callers share one in-flight load rather than triggering it twice.

If semantic analysis is off or fails, the structural graph stays and a
one-line status message explains why; Pass B then has nothing to enrich.

## The popup

The graph can also open in a popup, for windows with no room for a side
panel. The **Note Graph Popup** command, behind the graph icon in the note
toolbar, opens it over Joplin, leaving the side panel as it was, and loads the
graph the same way as **Show Note Graph**. If the popup can't be set up when
the plugin starts, that's logged and the side panel works without it.

The popup is a Joplin dialog (`joplin.views.dialogs`) that loads the same HTML
and scripts as the panel. Whatever decides what the graph shows is kept by the
plugin, so the two always agree:

- **The view, layout and tag filter.** `GraphPresenter` owns them. Every graph it
  sends names its layout and grouping as well, so a view that didn't pick the
  layout still shows the right one.
- **Coloring, the Links / Similar / Tags toggles and the minimum similarity.**
  The page sends a change as `set-view-choices`; `webview.ts` keeps it, passes
  it on to every view as `view-choices`, and includes it in every `request-data`
  reply, so a popup opening fresh starts with the same choices. A view never
  sends back choices it was given. Coloring by search isn't shared, because it
  follows the view's own search box.

Zoom and pan, the search text, focus mode and open menus stay with each view.

A few things are different about dialogs:

- **Messaging.** Dialogs have no message API of their own. Joplin finds a view
  by its handle, whatever kind it is, so `joplin.views.panels.onMessage`,
  `postMessage` and `hide` work on the dialog too. `webview.ts` sends every
  update to the panel and, while it's open, to the popup.
- **It's modal.** While it's open, the rest of Joplin can't be clicked, so the
  command only ever opens it. Clicking a note in the graph opens it behind the
  popup, which stays open until it's closed.
- **Closing.** It has no Joplin buttons, so Joplin doesn't close it on Escape
  itself. Instead `setup.js` posts `escape-pressed` for any Escape a menu or the
  search box hasn't already used, and the plugin closes the popup on it. The
  side panel ignores that message. Joplin still draws an empty button bar under
  the popup, and `styles/popup-chrome.css`, loaded into Joplin's window with
  `joplin.window.loadChromeCssFile`, hides it for this popup only.
- **A fresh page each time.** Joplin rebuilds the popup's page every time it
  opens, so the graph is drawn again from the plugin's data, and zoom and pan
  start over.

A side panel hidden with its ✕ still receives graphs, but its canvas has no
size while hidden, so any fit made then is wrong. `graph-view.js` fits the
graph again when the canvas becomes visible. Until Cytoscape has measured the
new size, it also doesn't move the view to the open note, because that move
would be worked out against a canvas of no size and would undo the refit.

## AnalysisController: the single orchestrator

`AnalysisController` (`src/services/AnalysisController.ts`) is the only
class `index.ts` calls into for building or rebuilding the graph, and
`GraphPresenter` is the only one it calls to show the result. The controller owns:

- the last set of notes and their embeddings, so settings changes (threshold,
  top-K) can recompute the graph without re-fetching embeddings;
- a monotonically increasing `runToken`, so a slow build that gets
  superseded by a newer one (e.g. the user reopens the panel while an embed
  is still running) discards its result instead of overwriting fresher data;
- the last `GraphData`;
- the `LLMEnricher` instance for Pass B, whose in-memory cache it seeds from
  the persisted graph cache on `loadFromCache()`, so labels already computed
  in a previous session don't need to be re-requested from the model.

See [Data pipeline](data-pipeline.md) for how notes are loaded and enriched,
[Similarity engine](similarity-engine.md) for how semantic edges are scored,
[Graph model](graph-model.md) for how nodes and edges are assembled, [LLM
enrichment](llm-enrichment.md) for Pass B, and [Incremental
updates](incremental-updates.md) for what happens after the initial load.

## Logging

Services never call `console` directly. Each takes a `Logger` (`src/utils/Logger.ts`)
as a constructor default, `consoleLogger`, so a test can pass its own. `index.ts`
builds everything with a `RecordingLogger`, which passes each message on to the
console and keeps the latest warnings and errors for the panel's "What's
happening" view.

## Persistence

Two SQLite databases live in the plugin's data directory
(`joplin.plugins.dataDir()`), opened lazily on first use:

- `note-graph-vectors.sqlite`: one row per note's embedding vector, keyed by
  note ID and model ID.
- `note-graph-cache.sqlite`: the last successfully built graph and its layouts (so
  reopening the panel is instant), and the sync cursors used for incremental updates.

Details in [Caching](caching.md).
