# Development

## Requirements

- Node.js and npm.
- Joplin desktop, for loading and testing the built plugin.

## Setup

```sh
npm install
```

## Building

```sh
npm run dist
```

Runs the full build: the main plugin bundle, any extra scripts declared in
`plugin.config.json`, the webview bundle, then packages everything into a
`.jpl` archive under `publish/`. This is what `npm run prepare` also runs,
so a plain `npm install` after cloning builds the plugin as a side effect.

```sh
npm run build:webview
```

Builds only the webview bundle (`src/ui/graph-view.js` and its Cytoscape
dependencies), via `webview.webpack.config.js`. Useful when iterating on the
panel UI without rebuilding the whole plugin.

## Loading the plugin in Joplin

1. Run `npm run dist` to produce a `.jpl` file under `publish/`.
2. In Joplin, open the Configuration screen's **Plugins** page, press the
   **Plugin tools** (gear) button, choose **Install from file**, and select
   that `.jpl`.
3. Restart Joplin, or disable and re-enable the plugin, to pick up changes
   after a rebuild.

## Testing

```sh
npm test              # run once
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

Tests run under Jest with `ts-jest`, rooted at `src/`, matching
`**/*.test.ts`. Every test file sits next to the module it tests. The
Joplin plugin API itself is mocked at `src/tests/mocks/joplin.ts`, aliased
in place of the real `api` module via `jest.config.js`'s
`moduleNameMapper`; the `api/types` module maps to the real
`api/types.ts` type declarations (types only, no runtime behavior to mock).

## Formatting

```sh
npm run format
```

Runs Prettier over `src/**/*.{ts,tsx,js,jsx,json,css,md}`. Notable settings
from `.prettierrc`: tabs (not spaces), single quotes, semicolons, 100-column
print width. Match these by hand if your editor doesn't run Prettier on
save; a diff that's pure re-indentation makes review harder for no benefit.

## Project layout

```
src/
    index.ts                  Plugin entry point: registers commands, settings, listeners.
    manifest.json              Joplin plugin manifest.
    data/                      Joplin API access: notes, tags, links, events.
        Database/                SQLite-backed caches.
    services/
        AnalysisController.ts    Orchestrates graph building.
        embeddings/               Embedding provider resolution, fetching, caching.
        similarity/                Similarity scoring and edge creation.
        graph/                     Graph assembly, community detection, centrality, diffing.
        llm/                       Pass B: LLM enrichment (categories, relationship labels).
        sync/                       Workspace-event listening and incremental updates.
        settings/                   Plugin settings registration and access.
    ui/
        App.ts, components/       Panel HTML shell.
        webview.ts                  Panel lifecycle and plugin<->webview messaging.
        graph-view.js               Cytoscape client, compiled by webview.webpack.config.js.
        setup.js                    Close-button wiring, copied as-is (no imports to bundle).
        styles/panel.css            Panel styling.
    tests/mocks/                Joplin API mock for Jest.
api/                            Joplin's plugin API type declarations (vendored, not modified).
docs/                            This documentation.
```
