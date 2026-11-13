# Large vaults

Note Graph is built to open a vault of tens of thousands of notes without
freezing Joplin. This page explains the two rules behind that, and what they
mean when you change the code.

## Rule 1: the panel never runs a layout

The panel is an iframe inside Joplin's main window, so it shares Joplin's UI
thread. Force-directed layout is synchronous and its cost grows roughly with the
square of the number of nodes: about 1 s at 500 nodes and over two minutes at
3000. Running it in the panel froze the whole of Joplin, and on a 10,500-note
vault it never finished before Joplin crashed.

The plugin script runs in its own hidden window, where heavy work can't freeze
the UI. So `GraphLayoutEngine` computes every position there, and the panel only
draws them:

| View | How positions are computed |
|---|---|
| Up to 600 notes | Real fCoSE force layout |
| Above 600 notes, or when grouped | Two-level: fCoSE on the communities, then each community's notes in a spiral, most connected first |
| Hierarchical | Breadth-first |

The positions of a notebook's main view are saved in SQLite (`layout_cache`), for the
30 most recent, so reopening it needs no new layout; connections and tag-filtered
views are kept in memory only, for the last 20. When a graph changes, notes already on screen keep their exact
positions and new notes are placed beside what they connect to. A fresh layout runs
when a change adds more than 30% of a view's edges, such as when semantic edges first
arrive, so the layout reflects them. If a layout ever fails, notes are placed in a
grid, so the graph still appears.

`src/ui/graph-view.guard.test.ts` fails if a layout ever finds its way back into
the panel.

## Rule 2: the panel is never given the whole vault

The plugin always reads every note, because a note in another notebook can link to,
share a tag with, or be similar to the notes on screen. Reading isn't what froze
Joplin; drawing was. `GraphViewBuilder` turns the full graph into a view with a fixed
upper size, so the cost of drawing doesn't depend on how large the vault is:

| Limit | Value |
|---|---|
| Notes in a view | 1500 |
| Edges in a view | 3000 |
| Notes from other notebooks in a notebook view | 300 |
| Notes in a connections view | 300 |

The views are:

- **All notes**: only when no notebook is chosen and the vault has 1500 notes or fewer.
  Above that, "All notebooks" isn't offered, and anyone who had it saved gets the
  current notebook and a line saying why.
- **Notebook**: the chosen notebook, including nested ones, plus the notes elsewhere that
  connect to it, drawn faded with a dashed outline. Links are preferred, then semantic
  similarity, then shared tags. Ring edges never bring a note in, because they say
  nothing about a particular pair. If the notebook doesn't fit, it shows its most
  connected notes and says so.
- **Connections**: a note and everything up to three steps from it, set with the depth
  slider. Opened from a search result, a note's right-click menu, or by clicking a note
  from another notebook. If no notebook is open on a large vault, this is what shows for
  the open note.

When a view has more edges than the limit, links are kept first, then semantic
edges by score, then tag edges, and finally ring edges (see [Graph
model](graph-model.md)). A note from another notebook whose connections were all cut is
left out too, since it is only there for them. The view says what it left out.

Moving to another notebook only changes the view, so nothing is read again. The
notebook list itself is reused for 10 seconds, and read again sooner if a notebook the
view needs isn't in it. `ScopeFollower`
decides when that's needed. A connections view stays open when the notebook changes.

The tag filter works the same way: the plugin finds every note in scope with that tag,
so it can reach notes that didn't fit in the unfiltered view.

Search works across every note, not just what's on screen. When some notes aren't
drawn, the panel asks the plugin, which has them all.

In a notebook view, the stats bar shows totals for the notebooks in scope, including what
connects to them from elsewhere, not just what's drawn. In a connections view it counts
what's drawn.

Colouring by community, notebook or search only changes how notes are drawn. Colouring
by search colours the matches among the notes on screen.

## Drawing

Even a bounded view can hold the UI thread for too long if it's all added at once,
so `graph-view.js` adds elements in slices of 150 with a pause between them. A patch
that arrives mid-drawing waits until the drawing finishes. Whether an update is applied
as a patch, compared with what's drawn, or redrawn is decided in `graphUpdatePolicy.ts`. Above 800 nodes or 600
edges, the panel switches to a cheaper style: straight solid edges, no arrows, no
text outlines, and labels only when zoomed in. Each kind of edge keeps its color, so they
can still be told apart.

## Testing at scale

```sh
npm run dist
npm run perf:panel -- --notes=10500 --ai
```

`perf:panel` runs the real plugin against a fake Joplin with the real panel in a
headless browser, and reports every block of the panel's thread. It fails if any
block is over 200 ms, apart from one-off actions marked `*` in its report, such as
exporting, where a brief pause is expected. It takes a few minutes and doesn't need
Joplin installed. It can't catch problems specific to Joplin itself, so also try a
change by hand on a large vault.
