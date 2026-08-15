# Note Graph documentation

This is the in-depth documentation for the Note Graph plugin: how it's put
together, and why it's built the way it is. For install and quick-start
instructions, see the [root README](../README.md).

## Contents

1. [Architecture](architecture.md) - how the plugin and the webview panel
   fit together, and the overall request flow.
2. [Data pipeline](data-pipeline.md) - fetching notes, tags, and links from
   the Joplin API.
3. [Similarity engine](similarity-engine.md) - how semantic edges are
   scored from embedding vectors.
4. [Graph model](graph-model.md) - nodes, edges, centrality, and community
   detection.
5. [LLM enrichment (Pass B)](llm-enrichment.md) - optional category labels
   and relationship explanations via Joplin AI chat.
6. [Incremental updates](incremental-updates.md) - how the graph stays live
   as you edit, without a full rebuild.
7. [Caching](caching.md) - the SQLite-backed vector and graph caches.
8. [Settings reference](settings.md) - every setting, what it does, and
   when changing it triggers a rebuild.
9. [Development](development.md) - building, testing, and project layout.
10. [Troubleshooting](troubleshooting.md) - common issues and what causes
    them.

## Reading order

If you're new to the codebase, read them in order: architecture first for
the map, then data pipeline through LLM enrichment for how a graph gets
built from scratch, then incremental updates and caching for what happens
after that. Settings and development are reference material you can jump
to directly.
