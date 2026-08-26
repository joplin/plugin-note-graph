# Settings reference

Registered by `registerGraphSettings()`
(`src/services/settings/GraphSettings.ts`) under the **Note Graph** section
of Joplin's Configuration screen. Registration itself is dynamic and re-runs on
every plugin start (Joplin doesn't persist section/setting *definitions*
across restarts), but the values a user sets are persisted by Joplin as
normal.

| Setting | Key | Type | Default | Effect |
|---|---|---|---|---|
| Enable AI-based semantic analysis | `noteGraph.aiAnalysisEnabled` | Boolean | `false` | Turns semantic edges on or off. Requires Joplin AI to be enabled with a ready embedding index (Configuration screen's AI page). |
| Similarity threshold (%) | `noteGraph.similarityThreshold` | Integer, 0-100, step 5 | `70` | Minimum content similarity (raw cosine) for a semantic edge to appear, as a percentage. Lower = more edges. Only applies when AI analysis is enabled. |
| Max semantic edges per note (top-K) | `noteGraph.maxEdgesPerNote` | Integer, 1-20, step 1 | `5` | Caps how many of each note's strongest semantic connections are kept. Only applies when AI analysis is enabled. |
| Enable LLM analysis | `noteGraph.llmEnrichmentEnabled` | Boolean | `false` | Turns on Pass B: category labels and relationship explanations via Joplin AI chat. Requires AI-based semantic analysis to also be enabled. See [LLM enrichment](llm-enrichment.md). |
| Retry AI embedding | `noteGraph.retryEmbedding` | Boolean | `false` | One-shot trigger, not a persistent toggle: ticking it immediately retries AI-based semantic analysis (for example, after cancelling it), then unticks itself. No-op if the graph panel hasn't been opened yet. |
| Retry AI labels | `noteGraph.retryEnrichment` | Boolean | `false` | One-shot trigger, not a persistent toggle: ticking it retries Pass B for any note/edge still missing a label, then unticks itself. No-op if the graph panel hasn't been opened yet. |

Joplin's settings API has no float/slider type, only integer, so the
threshold is stored as a whole-number percentage and converted to the `0-1`
scale `SimilarityEngine` expects by `getSimilaritySettings()`. A value
outside its valid range, or one that isn't a usable number at all, falls
back to the setting's default rather than being clamped to the nearest
valid value. See [Similarity engine](similarity-engine.md) for what
threshold and top-K actually do in the scoring pipeline.

## Reacting to changes

`index.ts` listens for `joplin.settings.onChange` and only acts if the
graph has already been built at least once (`analysisController.hasNotes()`)
and the change touched one of the six keys above (`NOTE_GRAPH_SETTING_KEYS`):

- **Ticking "Retry AI embedding"** is handled first and separately from
  everything else: the setting is immediately reset to `false` (so it
  behaves like a button, not a checkbox that stays on) and AI analysis
  re-runs, reusing cached embeddings for unchanged notes and re-embedding
  only the ones that miss the cache.
- **Ticking "Retry AI labels"** is handled next, the same way: reset to
  `false`, then a Pass B retry pass runs. See [LLM
  enrichment](llm-enrichment.md#retrying-missing-labels).
- **Toggling AI analysis** re-runs the full semantic analysis
  (`runSemanticAnalysis`), which re-embeds if turning on, or drops back to
  the structural graph if turning off. This also determines whether Pass B
  can do anything, since it depends on semantic edges existing.
- **Any other change** (threshold, top-K, or toggling LLM analysis) is a
  no-op if AI analysis is currently off, since none of them have an effect
  without semantic edges. If AI analysis is on but notes haven't been
  embedded yet, it falls back to a full `runSemanticAnalysis`. Otherwise it
  recomputes edges from the already-embedded vectors *and* re-runs Pass B
  enrichment against the new edge set, reusing whatever is already cached.

If the panel hasn't been opened yet, a settings change is a no-op; the new
values simply apply the next time the graph is built.
