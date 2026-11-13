# Note Graph

Note Graph is a [Joplin](https://joplinapp.org) plugin that visualizes your
notes as an interactive graph. It connects notes by the links and tags you
already use, and by semantic similarity using Joplin's own built-in AI. This
way you can see how your notes actually relate to each other, not just how
they're filed. An optional second stage, LLM enrichment (Pass B), adds topic
labels and one-line explanations for those connections.

## Features

- **Explicit connections.** Notes linked with `[text](:/noteId)` or sharing
  a tag are connected automatically, no setup required.
- **Semantic connections.** With Joplin AI enabled, the plugin
  embeds your notes and adds edges between notes that are related in
  content even when nothing links them. Tunable threshold and edge count.
- **Optional LLM enrichment (Pass B).** Labels each semantic connection with a
  one-line explanation of why it exists, using Joplin AI chat. Off by default.
- **Community detection.** Notes cluster into color-coded groups using the
  Louvain method, with a keyword-based fallback for small or sparse vaults.
- **Centrality-scaled nodes.** More connected notes render larger, so hubs
  stand out at a glance.
- **Live updates.** The graph updates as you edit, create, and delete
  notes, without a full rebuild, and catches up automatically after a sync.
- **Built for large vaults.** The plugin reads your whole vault in the background,
  but only draws what fits: a notebook, including nested ones, plus the notes in
  other notebooks that connect to it. Search reaches every note, and a note's
  connections can be widened with a depth slider. Layout runs away from Joplin's UI
  thread, so a large vault doesn't freeze the app.
- **Local and instant.** Embeddings, labels, and the last built graph are
  cached in a local SQLite database, so reopening the panel doesn't mean
  waiting again. Nothing is sent anywhere except to Joplin's own AI
  subsystem, and only when semantic analysis or LLM enrichment is on.
- **A panel built for exploring, not just looking.** Search, a depth slider, a tag
  filter, focus mode (isolate a note's neighborhood), per-edge-type toggles, zoom, and
  PNG/SVG/JSON export. It follows Joplin's theme and adapts down to a narrow panel.

## Requirements

- Joplin desktop 3.5 or later.
- Joplin 3.7 or later with AI enabled (Configuration screen's **AI** page),
  if you want semantic connections or LLM enrichment. Everything else works
  without it.

## Installation

### From the Joplin plugin marketplace

1. In Joplin, open the Configuration screen and go to the **Plugins** page.
2. Use the search box to look for **Note Graph**.
3. Press **Install** next to Note Graph.
4. Restart Joplin when prompted to complete installation.

### From a `.jpl` file

Build the plugin from source and install the resulting file:

```sh
npm install
npm run dist
```

This produces a `.jpl` file under `publish/`. In Joplin, open the
Configuration screen's **Plugins** page, press the **Plugin tools** (gear)
button, choose **Install from file**, and select it. Restart Joplin after
installing an update.

## Usage

Open it from the **Tools** menu: **Show Note Graph**. The graph builds from
your current notes, tags and links; if AI analysis is enabled in the
plugin's settings, semantic edges are added once your notes are embedded.
If LLM enrichment is also enabled, relationship labels appear on hover once
Pass B finishes labeling them.

The note open in Joplin is highlighted, and the highlight follows as you move between
notes. Click a node to open that note, or right-click it for more. Double-click to
zoom in on it.

- **Top of the panel:** choose which notebooks to show, and search every note. Press
  Enter to open the top result, or Escape to clear the search.
- **Toolbar:** turn links, similar notes and tags on or off, show only one tag, choose
  how notes are colored, focus on the selected note, or export the view.
- **On the graph:** choose how notes are arranged, zoom, and fit the graph to the panel.
- **A note's connections:** open them from a search result or the right-click menu, and
  use the depth slider to widen or narrow them.

## Configuration

Available in the Configuration screen's **Note Graph** section:

| Setting | Default | Effect |
|---|---|---|
| Enable AI-based semantic analysis | Off | Adds semantic similarity edges using Joplin AI |
| Similarity threshold | 70% | Only the strongest (100 − value)% of candidate pairs become edges, ranked by how much closer two notes are than each usually is to its nearest notes. Lower values surface more semantic edges |
| Max semantic edges per note | 5 | Caps how many semantic connections each note keeps |
| Enable LLM analysis | Off | Adds Pass B relationship explanations |
| Retry AI embedding | Off | One-shot: re-runs AI-based semantic analysis, reusing cached embeddings |
| Retry AI labels | Off | One-shot: labels up to 200 more connections still unlabeled |

Full details, including how the similarity score and Pass B labels are
computed, are in [docs/settings.md](docs/settings.md),
[docs/similarity-engine.md](docs/similarity-engine.md), and
[docs/llm-enrichment.md](docs/llm-enrichment.md).

## Documentation

In-depth documentation lives in [`docs/`](docs/README.md): architecture,
the data pipeline, the similarity engine, the graph model, LLM enrichment
(Pass B), incremental updates, caching, development setup, and
troubleshooting.

## Development

```sh
npm install       # also builds the plugin (npm run prepare)
npm test          # run the test suite
npm run format    # apply the project's Prettier config
```

See [docs/development.md](docs/development.md) for the full build, test
and project-layout reference.

## License

[MIT](LICENSE)
