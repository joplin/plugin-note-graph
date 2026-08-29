# Similarity engine

Semantic edges connect notes whose *content* is related even if nothing
explicitly links them. They exist only when AI analysis is enabled in
settings and Joplin's embedding index is ready. This document covers how a
raw embedding vector for a note becomes a scored, thresholded edge.

## Getting embeddings

`ProviderResolver.resolveWithValidation()` (`src/services/embeddings/ProviderResolver.ts`)
checks that `joplin.ai` exists and that `getIndexStatus()` reports a usable
state before anything else runs. It throws a specific, user-facing error
otherwise (for example, "Joplin AI index is not usable yet"), which
`AnalysisController` catches and turns into a fallback to the structural
graph plus a status message.

The index state machine (mirrors Joplin's own `AiIndexState`):

| State | Meaning | Blocks fetching? |
|---|---|---|
| `unavailable` | AI feature not available on this Joplin build. | Yes |
| `disabled` | AI is turned off in Joplin settings. | Yes |
| `preparing` | Index not started yet. | Yes |
| `indexing` | Index exists but is still filling in; some notes may not be indexed yet. | No (partial results) |
| `ready` | Fully indexed. | No |

`JoplinNativeProvider` (`src/services/embeddings/providers/JoplinNativeProvider.ts`)
fetches vectors via `joplin.ai.getEmbeddings()`, paginating (1000 chunks per
page, capped at 500 pages). A note's body can be split into multiple
embedding chunks; `poolAndNormalize()` averages a note's chunk vectors into
one and L2-normalizes it, so downstream cosine similarity is a plain dot
product. If the embedding model changes mid-fetch (a user changed the AI
model in Joplin settings while a fetch was in flight), pagination restarts
from scratch, up to 3 times, before giving up. A page fetch that fails is
attempted up to 3 times, 1 second apart. Cancellation is checked only
between pages, so a cancelled fetch returns whatever it collected so far.

**Important implementation detail:** `joplin.ai` is exposed to plugins
through Joplin's RPC proxy bridge. Checking whether a *method* exists with
`typeof joplinAi.someMethod` (without calling it) can corrupt the property
path the proxy tracks for later real calls. The provider only ever checks
that the top-level `joplin.ai` object exists, then calls a method directly
and lets a genuinely missing method fail on invocation. If you touch this
code, keep that rule; see the comment on `validateAiApi()` for the full
reasoning.

## Caching vectors

`EmbeddingOrchestrator` (`src/services/embeddings/Orchestrator.ts`) sits
between `AnalysisController` and the provider. For each note it checks
`VectorRepository` (a SQLite-backed cache) for a vector whose cached
`updatedTime` and `modelId` still match the note; only notes that miss the
cache are sent to the provider. Freshly fetched vectors are written back to
the cache. A cache read or write failure is logged and treated as a full
miss/no-op rather than failing the embed, so a corrupt cache degrades to
"slower" rather than "broken." See [Caching](caching.md) for the schema.

## Scoring: `SimilarityEngine.compute()`

`SimilarityEngine` (`src/services/similarity/SimilarityEngine.ts`) runs a
fixed pipeline over every candidate note pair:

```
raw scores -> floor (absolute) -> percentile cutoff (raw) -> normalize -> bonuses -> top-K
```

The **percentile cutoff is checked on the raw score, before normalization**.
Min-max normalization always maps the batch's most-similar pair to exactly
1.0, so a post-normalization cutoff could never reject it — even in a vault of
completely unrelated notes, the closest pair would be scaled up and pass.
Checking the raw cosine first gives the cutoff a relative meaning; it keeps
only the top `(1 - threshold)` fraction of the surviving raw scores, which is
what separates a batch whose scores are all compressed into a narrow band
(for example e5's [0.7, 1]). Normalization then only ranks the pairs that
already passed.

### 1. Raw scores

- **Vaults of 300 notes or fewer** (`LARGE_VAULT_THRESHOLD`): plain O(n²)
  pairwise cosine similarity (dot product of the L2-normalized vectors).
- **Larger vaults**: `joplin.ai.search({ query: { noteId }, relevance: 'normal' })`
  per note, using Joplin's own vector index instead of comparing every pair
  in the plugin. Each note's call is retried once on a transient failure and
  then skipped if it still fails, since a partial candidate set is still
  useful. But if the first three notes in a row all fail (for example,
  `search` exists on `joplin.ai` but isn't supported by this Joplin version),
  the engine gives up early and falls back to full O(n²) cosine for the whole
  vault, instead of retrying every remaining note only to fail the same way.

### 2. Floor

Pairs scoring below `SEMANTIC_FLOOR` (0.3) on the **raw** scale are dropped,
unless the two notes are already directly linked (those are kept and
resolved later, at the cutoff step). This has to happen before
normalization: min-max normalization would always stretch the best pair in
the batch to exactly 1.0, even in a vault of totally unrelated notes, so a
floor applied *after* normalization could never reject anything. Flooring the
raw score is what gives 0.3 an absolute, not batch-relative, meaning, and it
is the small absolute floor that keeps a tiny vault with little data from
manufacturing edges out of weak scores.

### 3. Percentile cutoff

Pairs whose raw score is below the score at the configured percentile
(`DEFAULT_THRESHOLD` = 0.7, user-adjustable) are dropped. The percentile is
computed over the above-floor raw scores in this batch, so it keeps only the
top `(1 - threshold)` fraction — e.g. the strongest 30% at the default 70%.
Like the floor, this runs on the raw scale, *before* normalization, and it is
batch-relative on purpose: an unrelated pair that happens to be a batch's
closest cannot be normalized up to pass, and a batch whose scores all sit in
a narrow band (the e5 failure mode) is still separated by relative rank.
Normalization then only ranks the pairs that already cleared it.

### 4. Normalize

Surviving scores are min-max normalized to `[0, 1]` together. If the spread
between the batch's min and max is under 0.1, normalization is skipped (there
is nothing meaningful to stretch).

### 5. Bonuses

Three additive bonuses nudge the normalized score:

| Bonus | Constant | Basis |
|---|---|---|
| Shared tags | `TAG_BONUS` = 0.1 | Jaccard overlap of the two notes' tags, excluding "organizational" tags (see below) |
| Direct link | `LINK_BONUS` = 0.05 | The notes already reference each other via `:/id`. Smaller than the tag bonus on purpose: a link already gets its own edge from `EdgeFactory`, so this only affects whether a *redundant* semantic edge also appears. |
| Temporal proximity | `TEMPORAL_BONUS_1_DAY` = 0.1 / `TEMPORAL_BONUS_7_DAYS` = 0.05 | Notes created within 1 day / 7 days of each other |

"Organizational" tags are tags present on more than `ORGANIZATIONAL_TAG_RATIO`
(30%) of the vault, for example an `inbox` or `todo` tag applied broadly.
They are excluded from the tag-overlap bonus because sharing them says
nothing about content similarity.

Because the floor and the percentile cutoff are checked on the *raw* score,
bonuses can rank pairs but can never manufacture an edge out of a weak
semantic score.

### 6. Top-K

Each note keeps its K strongest remaining connections
(`TOP_K` = 5 by default, user-adjustable, "max semantic edges per note" in
settings). This is the standard k-nearest-neighbor graph construction: the
returned edge set is the *union* of every note's top-K, so a note that many
other notes pick as one of their top-K can end up with more than K edges
overall. That is intentional; it keeps degree meaningful as a centrality
signal instead of artificially flattening it.

All the constants named above live in
`src/services/similarity/ThresholdPresets.ts`. Threshold and top-K are also
exposed as settings; see [Settings reference](settings.md).

## From pairs to edges

`EdgeFactory.createSemanticEdges()` (`src/services/similarity/EdgeFactory.ts`)
turns each surviving `SimilarityPair` with a positive score into a
`semantic`-type `GraphEdge`. See [Graph model](graph-model.md) for how those
combine with link and tag edges into the final graph.
