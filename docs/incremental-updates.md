# Incremental updates

Once the graph panel has loaded once, it does not rebuild from scratch on
every note edit. `WorkspaceListener` and `IncrementalUpdater`
(`src/services/sync/`) turn Joplin workspace events into small, coalesced
patches.

## Listening

`WorkspaceListener` registers three Joplin workspace callbacks:

| Event | Handler |
|---|---|
| `joplin.workspace.onNoteChange` | Note created, updated, or deleted -> schedule an upsert or removal |
| `joplin.workspace.onNoteSelectionChange` | Note(s) newly selected -> schedule an upsert. Covers the case where switching notes reveals a change (e.g. after a sync) that no `onNoteChange` fired for. |
| `joplin.workspace.onSyncComplete` | A Joplin sync just finished -> run a full sweep for anything missed while the panel wasn't watching |

## Coalescing

`IncrementalUpdater` keeps two sets, `pendingUpsertIds` and
`pendingRemovedIds`. Scheduling an upsert removes that note from the removal
set (and vice versa), so a note edited and then quickly deleted ends up only
in the removal set. Every scheduling call resets a 1-second debounce timer
(`DEFAULT_COALESCE_WINDOW_MS`); rapid-fire edits (typing, or a bulk sync)
collapse into a single flush once things go quiet.

Flushes themselves run through a promise chain (`flushChain`) so overlapping
triggers (a debounce firing while a sync-complete sweep is also flushing)
never run concurrently and never leave a rejected promise blocking future
flushes.

## What a flush does

`flushInternal()`:

1. Drains the pending ID sets.
2. Re-fetches and re-enriches each upserted note
   (`NoteRepository.getNote` + `NotePreprocessor.processOne`). A note that
   has disappeared (deleted between being scheduled and being fetched) is
   reclassified as a removal instead.
3. Calls `AnalysisController.applyDelta(upserts, removedIds)`, which merges
   the changes into the last known note set, skips the rebuild entirely if
   nothing actually changed (same `updated_time`, tags, and links), and
   otherwise rebuilds the graph from the merged set.
4. If a graph came back, pushes `AnalysisController.getLastDiff()` (a
   `GraphDiff`) to the webview via the `onGraphPatch` callback, which in
   `index.ts` is wired to `postGraphPatch`.
5. Runs the LLM enrichment follow-up (`AnalysisController.enrichCurrentGraph`)
   against the rebuilt graph and pushes a second patch if Pass B changed
   anything.

If `applyDelta` returns `null` because a newer build superseded this one
mid-flight (`wasLastDeltaSkippedForRetry()`), the same IDs are re-queued and
retried, up to `MAX_CONSECUTIVE_RETRY_SKIPS` (5) consecutive times. After
the fifth, `IncrementalUpdater` gives up and waits for the next natural
trigger (another edit or sync) instead of retrying forever, and calls an
`onRetriesExhausted` callback, which `index.ts` wires to a status message:
"Note graph update paused after repeated failures; will retry on your next
edit."

Any unexpected error during a flush falls back to a full reload
(`onFullReloadNeeded`, wired to `performFullReload` in `index.ts`). If even
that fails, the original IDs are re-queued so the next flush has another
chance rather than silently losing the change.

## Sync-complete sweep

A background panel can miss workspace events entirely (Joplin only fires
`onNoteChange` for changes made through the UI it's attached to). To catch
everything else, `handleSyncComplete()` runs after every Joplin sync:

- **If AI analysis is enabled**, it pages through
  `joplin.ai.getEmbeddings()` (capped at 500 pages) from a saved cursor
  (`GraphCacheRepository.loadEmbeddingsCursor`) and schedules an upsert for
  every note ID it sees. This doubles as change detection: any note whose
  embedding was touched since the last sweep shows up here.
- **It always** also pages through `/events` (capped at 50 pages) from a
  saved cursor (`EventsRepository`, `GraphCacheRepository.loadEventsCursor`),
  which is the only source of *deletions* and the fallback change-detection
  path when AI analysis is off (or the embeddings sweep itself fails).
- Both cursors are saved back after a successful page, so the next sync
  only looks at what changed since this one.

If the embeddings sweep fails partway through, the sweep falls back to
`/events`-only change detection for that cycle rather than failing the
whole sync-complete handler. If the sweep as a whole throws, `index.ts`
falls back to a full reload.

## Cache-first panel open

When the panel is opened and a cached graph exists on disk but nothing has
been built yet this session, `index.ts` shows the cached graph immediately
(no recompute), then runs two steps in the background: `handleSyncComplete()`
to catch up on anything that changed since the cache was written, and then,
separately, a check for any semantic edge still missing a Pass B label. If
LLM enrichment is enabled and the cached graph has any, that check backfills
them the same way **Retry AI labels** does; see [LLM
enrichment](llm-enrichment.md#retrying-missing-labels). This two-step
background flow is why reopening the panel after restarting Joplin is fast
even for a large vault.

See [Caching](caching.md) for the cursor and graph cache schema, and
[Graph model](graph-model.md) for `GraphDiffer`, which produces the diff
being pushed here.
