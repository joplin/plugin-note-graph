# Troubleshooting

## "AI analysis unavailable - showing structural graph"

This status message appears when AI analysis is enabled in settings but the
graph couldn't be built with semantic edges. The underlying reason is
usually one of these, surfaced from `ProviderResolver` or
`JoplinNativeProvider`:

- **`joplin.ai is not available.`** Your Joplin version doesn't expose the
  AI API, or AI is turned off in Joplin's own Configuration screen (**AI**
  page, "Enable AI features"). Requires Joplin 3.7 or later with AI enabled
  (the plugin itself only requires Joplin 3.5+; only semantic analysis and
  LLM enrichment need 3.7+).
- **`Joplin AI index is not usable yet (state: preparing)`** or
  **`(state: disabled)`**: the embedding index hasn't started, or the
  Configuration screen's separate "Enable the embeddings indexer" option is
  unticked even though AI features are otherwise on.
- **`(state: indexing)`** is not blocking by itself; notes not yet indexed
  just show up as per-note errors ("Note not yet indexed by Joplin AI"),
  which can make the semantic graph look sparse until indexing catches up.

If AI analysis is off in the plugin's own settings (Configuration screen's
**Note Graph** section), no status message appears; the structural graph is
simply the expected result. See [Settings reference](settings.md).

## The graph has very few or no semantic edges

- Check the **similarity threshold** setting; 70% is the default and can be
  lowered to surface more edges.
- A small vault, or a vault with genuinely unrelated notes, will produce
  fewer edges by design: semantic edges require the raw cosine similarity to
  clear the threshold *before* normalization, and no tag, link, or time bonus
  can manufacture one out of a weak semantic score. See [Similarity
  engine](similarity-engine.md).
- Confirm the embedding index state is `ready` or at least `indexing` with
  meaningful progress, not `preparing`.

## "No graph data received"

The panel opened but hasn't received any graph yet. This is normal for a
moment on first open of a large vault (notes are still loading and being
embedded); check the progress bar. If it persists, check the developer
console (**Help -> Toggle Development Tools**) for an error logged by
`index.ts` or `AnalysisController`.

## Some notes or edges have no category badge or relationship label

Confirm both **Enable AI-based semantic analysis** and **Enable LLM
analysis** are on; Pass B has nothing to label without semantic edges from
Pass A. A batch that fails every retry attempt is simply left unlabeled for
that run rather than blocking the rest of the graph; tick **Retry AI
labels** to ask again. See [LLM
enrichment](llm-enrichment.md#retrying-missing-labels). The developer
console's `LLM enrichment:` log lines say exactly which batch failed and
why.

## Colors changed after adding or removing notes

Community IDs are stable for an *unchanged* note/edge set, but adding or
removing notes can shift which community is largest and therefore
renumber IDs, changing colors. This is expected behavior, not a bug; see
the "Stability" note in [Graph model](graph-model.md).

## Notes, tags, or events look incomplete in a very large vault

Several fetches are capped as a safety measure (see [Data
pipeline](data-pipeline.md) and [Incremental
updates](incremental-updates.md) for the exact numbers). Hitting a cap logs
a message and returns a partial result rather than failing outright; a
subsequent sync sweep picks up anything missed. Check the developer console
for the corresponding log line.

## Reinstalling after a build

Joplin does not always pick up a rebuilt `.jpl` automatically. After
`npm run dist`, reinstall it from the Configuration screen's **Plugins**
page (**Plugin tools** gear button -> **Install from file**) and restart
Joplin (or disable/re-enable the plugin) if changes don't appear to take
effect.
