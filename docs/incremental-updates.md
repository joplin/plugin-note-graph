# Incremental updates

Once the graph panel has loaded once, it does not rebuild from scratch on
every note edit. `WorkspaceListener` and `IncrementalUpdater`
(`src/services/sync/`) turn Joplin workspace events into small, coalesced
updates, and editing a note never touches embeddings.

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
   the changes into the last known note set and then does the least it can:
   - **Nothing changed:** returns `null`.
   - **Only the note's text changed:** remembers the note and returns `null`. The
     graph doesn't depend on text, so nothing is rebuilt or sent. The cache is written
     a minute later, so a restart doesn't fetch the note again; a note being typed is
     saved every few seconds, and the cache holds the whole vault.
   - **The title, notebook, tags or links changed, or a note was added or
     removed:** rebuilds links, tags, communities and sizes
     (`GraphBuilder.rebuildStructure`), keeping the semantic edges already
     computed.
4. If a graph came back, sends it through `onGraphChanged`. In `index.ts` that
   goes to `GraphPresenter`, which works out the patch for the view on screen; see
   [Large vaults](large-vaults.md).
5. Runs the LLM enrichment follow-up (`AnalysisController.enrichCurrentGraph`)
   against the rebuilt graph and publishes it again if Pass B changed anything.

A delta never cancels a semantic build that's in flight. If an edit lands during
one, the build finishes using the merged note set, so neither is lost.

If more than 1000 notes changed at once, a single full reload replaces fetching
each of them.

Any unexpected error during a flush falls back to a full reload
(`onFullReloadNeeded`, wired to `performFullReload` in `index.ts`). If even
that fails, the original IDs are re-queued so the next flush has another
chance rather than silently losing the change.

## Sync-complete sweep

A background panel can miss workspace events entirely (Joplin only fires
`onNoteChange` for changes made through the UI it's attached to). To catch
everything else, `handleSyncComplete()` runs after every Joplin sync:

- **It always** pages through `/events` (capped at 50 pages) from a saved cursor
  (`EventsRepository`, `GraphCacheRepository.loadEventsCursor`), for the notes that
  changed or were deleted. The cursor is saved back afterwards, so the next sync
  only looks at what changed since this one.
- **If AI analysis is enabled**, it also runs an embedding sweep, described below.

A failed embedding sweep is logged and doesn't affect the rest of the sync. If the
`/events` sweep throws, `index.ts` falls back to a full reload.

## Embedding sweeps

Joplin embeds notes in the background: 100 at a time every 30 seconds during its
first scan, then on a three-minute tick. An edit's new embedding therefore doesn't
exist until minutes after the edit, and nothing about the note itself says whether
Joplin has caught up. Fetching a vector straight after an edit would return the old
one and record it as current.

So freshness comes from Joplin's chunk stream instead. `EmbeddingChangeDetector`
follows `joplin.ai.getEmbeddings()` from a saved cursor, which reports every note
Joplin has re-embedded since the last sweep:

1. `AnalysisController.markVectorsStale()` records those notes.
2. `AnalysisController.refreshStaleVectors()` fetches new vectors for only those
   notes, saves them, and rebuilds if any really differ. If the fetch fails, the
   notes stay marked for the next attempt.

Sweeps run after each sync, and every three minutes while the panel is visible, so
people who never sync still get fresh semantic edges. They're limited to one per
two and a half minutes. New notes get their first vector the same way.

The first sweep over a large index can't tell what changed, so it only marks notes
with no vector yet and notes whose stored vector is older than the note
(`AnalysisController.markOutdatedVectorsStale()`); everything else the full load
already fetched. Joplin's stream
gives no position past its final page, so that page is read again on each sweep, and
a vector identical to the current one causes no rebuild. If the embedding model
changes, the sweep starts over and a full reload follows.

## Cache-first panel open

When the panel is opened and a cached graph exists on disk but nothing has
been built yet this session, `index.ts` shows the cached graph immediately
(no recompute), then runs two steps in the background: `handleSyncComplete()`
to catch up on anything that changed since the cache was written, and then,
separately, a check for any semantic edge still missing a Pass B label. If
LLM enrichment is enabled and the cached graph has any, that check backfills
them the same way **Retry AI labels** does; see [LLM
enrichment](llm-enrichment.md#retrying-missing-labels). This background flow is why reopening the panel after restarting Joplin is fast
even for a large vault. A cached graph has no vectors in memory, so the first sweep
compares against the stored vectors its similar-note connections were built from,
and only rebuilds when one really changed, instead of embedding the whole vault again
on every start.

Between those two steps, `reconcileWithVault()` compares the cached notes with the
vault's actual list of notes and update times, fetched without bodies, and applies
any difference. This catches what events can't: changes made while the plugin was
off, or a graph write lost when Joplin closed before it finished.

See [Caching](caching.md) for the cursor and graph cache schema, and
[Graph model](graph-model.md) for `GraphDiffer`, which produces the patches sent
to the panel.
