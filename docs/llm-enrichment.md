# LLM enrichment (Pass B)

The graph-building pipeline has two stages. **Pass A**, covered in [Graph
model](graph-model.md) and [Similarity engine](similarity-engine.md),
builds link, tag, and semantic edges. **Pass B**, LLM enrichment, is an
optional second stage that runs after Pass A and asks Joplin's AI chat
model to label what Pass A already found: a topic category per note, and a
one-line explanation for each semantic connection. Pass B never discovers
new edges; it only annotates the ones Pass A produced.

## What it adds

- **Categories.** Each note touched by a semantic edge gets a short topic
  label (for example "Container Gardening"), shown as a badge in the
  node's hover tooltip.
- **Relationship labels.** Each semantic edge gets a one-line explanation of
  why the two notes are connected (for example "both list watering
  schedules for container plants"), shown when hovering that edge.
- **A small centrality nudge.** The model can also nudge a note's node size
  by -2 to +2, on top of the degree-based size from `CentralityScorer`.

Link edges, tag edges, and the semantic edges themselves are entirely
unaffected. If Pass B is off, never runs, or fails, the graph is exactly
what Pass A produced.

**Enable LLM analysis** (`noteGraph.llmEnrichmentEnabled`), off by default,
turns it on; it has no effect until AI-based semantic analysis is also
enabled and has produced semantic edges to label.

## Cost and data handling

Pass B sends text to whatever AI provider you have set up in Joplin's own AI
configuration, so the cost and privacy behavior follow that configuration,
not this plugin. Note Graph never stores or forwards note content anywhere
of its own accord; its only outbound traffic is the `joplin.ai.chat()` call
described below. Joplin routes that call to the provider you chose in
Joplin's Configuration screen (**AI** page). The plugin has no separate
server, no separate terms and no third-party destination of its own.

What actually leaves your machine and what it costs therefore depends
entirely on that provider:

- **Which provider.** `joplin.ai.chat()` uses whichever chat model Joplin is
  configured to talk to. If you point Joplin at a local or self-hosted
  model, note content stays on your machine; if you use a cloud provider,
  the excerpts go to that provider's servers and are handled under its
  terms. The plugin does not select or influence the provider.

- **How much is sent.** Only notes and edges that already carry a semantic
  edge are ever sent, in batches of 4, with each note body truncated to 300
  characters (`MAX_BODY_EXCERPT_LENGTH`). Unchanged notes and edges are
  served from the in-memory cache and never re-sent, so re-running
  enrichment on a mostly unchanged graph sends very little new text.

- **Credentials and billing.** Any API key, account, rate limit, or billing
  relationship belongs to Joplin's AI setup, not to Note Graph. The plugin
  neither reads nor manages credentials and has no usage meter or cost
  estimate of its own.

In short, treat Pass B as an extension of Joplin's AI chat. Its cost and
privacy posture are whatever you already accepted when you enabled AI in
Joplin. The plugin adds nothing on top of that.

## Where it runs: `LLMEnricher`

`LLMEnricher` (`src/services/llm/LLMEnricher.ts`) is called from
`AnalysisController.applyEnrichment()`, which `enrichCurrentGraph()` invokes
as a follow-up once a graph has already been built and posted. It only ever
sees the notes and edges that touch a `semantic` edge.

**Batching:** edges are grouped into batches of 4 (`EDGES_PER_BATCH`)
before each batch goes to `joplin.ai.chat()` as one request.

**Caching:** two in-memory maps, `nodeCache` and `edgeCache`, key results
by note/edge ID plus the `updated_time` they were computed from, so an
unchanged note or edge is never re-sent to the model. On
`AnalysisController.loadFromCache()`, this cache is seeded from whatever
categories and labels are already in the persisted graph cache, so labels
survive a Joplin restart. `LLMEnricher` itself never touches SQLite; see
[Caching](caching.md) for where that data lives. If nothing in a run is
uncached, `enrich()` returns without contacting `joplin.ai` at all.

**Retrying:** each batch gets up to 4 attempts (`MAX_ATTEMPTS_PER_BATCH`),
1 second apart, on a `chat()` call throwing, an unusable response, or a
response that fails schema validation. A partial result, where the model
labeled some but not all relationships in the batch, is accepted as-is. A
batch that exhausts its attempts contributes nothing, but later batches
still run.

**Cancellation:** before each batch and each retry, `LLMEnricher` checks an
`isStale()` callback from the caller, wired by `AnalysisController` to its
`runToken` staleness check (see [Architecture](architecture.md)). A stale
run stops issuing requests and returns what it already has.

**Existing categories:** each batch's prompt includes up to 40 categories
(`MAX_EXISTING_CATEGORIES`) already seen this session, drawn from the
in-memory cache, so the model reuses a label instead of inventing a
near-duplicate for the same topic.

## The prompt and its parsing

`buildBatchPrompt()` (`src/services/llm/PromptBuilder.ts`) sends a fixed
system prompt plus a user message of `{ notes, pairs, existingCategories }`
as JSON to `joplin.ai.chat()`. Note bodies are truncated to 300 characters
(`MAX_BODY_EXCERPT_LENGTH`). The system prompt tells the model to treat note
content strictly as data, never as instructions to follow; to return
exactly one JSON object with no prose; to echo note/edge IDs back verbatim;
and to write relationship labels that name the actual shared subject
("related" or "similar topic" are called out as unacceptable, since the
label is shown with neither note's title visible).

`parseEnrichmentResponse()` (`src/services/llm/ResponseParser.ts`) rejects
the whole response if it isn't JSON with `notes` and `relationships`
arrays. Within a valid response it's permissive per item: a note entry is
kept only if its `id` matches the batch and it carries at least one usable
field, `category` being a non-empty string (truncated to 60 characters) or
`centralityAdjustment` an integer in `[-2, 2]`. A relationship entry is
matched back to a real edge via its `(from, to)` pair; a label is truncated
to 80 characters.
Anything that doesn't fit is dropped for that one item rather than
rejecting the batch.

## Applying results

Back in `AnalysisController.applyEnrichment()`, a node's `category` and
`size` (adjusted by `centralityAdjustment` and re-clamped to `1-10` via
`clampSize()`) are set if the enrichment provided them; an edge's
`relationshipLabel` likewise. If enrichment throws outside the per-batch
retry handling above, the error is logged and the graph is returned exactly
as Pass A built it.

In the panel, a category renders as a badge at the top of a node's hover
tooltip, and a relationship label renders in a tooltip on hovering its
semantic edge, the same mechanism tag edges use for their tag names. While
Pass B runs, the panel's progress bar reads "Enriching notes" instead of
"Building graph." Neither affects selection, search, focus mode, or export.

## Retrying missing labels

**Retry AI labels** (`noteGraph.retryEnrichment`) is a one-shot trigger, not
a persistent toggle: ticking it retries Pass B for anything still
unlabeled, then unticks itself. It's a no-op if the panel hasn't been
opened yet, and exists because a batch that exhausts its retries is not
retried automatically afterward.

The plugin also runs this backfill once on its own, right after loading a
cached graph, if that graph has semantic edges without labels and LLM
enrichment is enabled.
