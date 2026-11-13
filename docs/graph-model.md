# Graph model

`GraphBuilder` (`src/services/graph/GraphBuilder.ts`) turns a list of
enriched notes, plus optionally their embeddings, into the `GraphData`
structure the webview renders.

## Data shape

```ts
type EdgeType = 'link' | 'tag' | 'semantic';

interface GraphNode {
    id: string;
    label: string;      // note title, truncated to 64 chars
    noteId: string;
    degree: number;      // total edges touching this node
    community: number;   // 0 = largest community, see below
    size: number;         // 1-10, centrality-scaled
    category?: string;    // Pass B topic label, see docs/llm-enrichment.md
    notebookId?: string;  // the notebook the note is in
    tagNames?: string;    // the note's tags, one per line
    outsideScope?: boolean; // drawn only because it connects to the notebook on screen
}

interface GraphEdge {
    source: string;
    target: string;
    type: EdgeType;
    tagName?: string;              // comma-separated tag names, only when type === 'tag'
    relationshipLabel?: string;     // Pass B explanation, only ever set on type === 'semantic'
    ring?: boolean;                 // a tag too widely used to connect all its notes, see below
}

interface RenderedEdge extends GraphEdge {
    id: string;           // `${source}::${target}::${type}`
}

interface GraphData {
    nodes: Array<{ data: GraphNode }>;
    edges: Array<{ data: RenderedEdge }>;
}
```

The `{ data: ... }` wrapping matches the element format Cytoscape.js expects,
so the webview can pass nodes and edges straight into `cy.add()` without
reshaping them.

## Building edges

`EdgeFactory` (`src/services/similarity/EdgeFactory.ts`) creates three kinds
of edges:

- **Link edges**: one per explicit `:/id` or `joplin://id` link whose target
  is another note in the current note set, kept in the direction it was
  authored (`source` is the linking note, `target` the linked one). Two
  notes that link to each other both ways produce two edges, one per
  direction; a note linking to the same target twice in its body still
  produces only one.
- **Tag edges**: one per pair of notes sharing a tag, with all shared tag
  names merged onto a single edge (`tagName: "project, urgent"`). Tags
  shared by more than 20 notes are skipped entirely, since a tag on n notes
  would otherwise contribute a clique of n·(n-1)/2 edges.
- **Semantic edges**: one per surviving pair from `SimilarityEngine`, see
  [Similarity engine](similarity-engine.md).

After edges are built, `GraphBuilder` drops any edge referencing a note
outside the current node set (this matters for the incremental path, where
`notes` may be a subset).

`category` and `relationshipLabel` are never set here. They're filled in
afterward, by Pass B, if LLM enrichment is enabled; see [LLM
enrichment](llm-enrichment.md).

## Centrality: node size

`CentralityScorer` (`src/services/graph/CentralityScorer.ts`) maps each
note's degree (edge count) to a size between 1 and 10. It uses log
compression rather than linear min-max scaling:

```
normalized = log1p(degree - min) / log1p(max - min)
size = round(1 + normalized * 9)
```

Most notes in a typical vault have a handful of connections while a few
hub notes have many; linear scaling would squeeze nearly everything down
near the minimum size just to leave room for the hubs. Log compression
keeps the size differences legible across the whole range. If every note
has the same degree, there is nothing to scale, so every node gets a flat
mid-range size (5).

The module also exports a standalone `clampSize()` function, which just
clamps a number into the same `1-10` range. Pass B uses it to re-clamp a
node's size after applying its own small centrality nudge, so an enrichment
adjustment can never push a node's size outside the range this scorer
itself produces. See [LLM enrichment](llm-enrichment.md).

## Community detection

`LouvainDetector` (`src/services/graph/LouvainDetector.ts`) assigns each
note a `community` number, used to color nodes in the panel.

**Primary path:** the [Louvain
method](https://en.wikipedia.org/wiki/Louvain_method) via the
`graphology-communities-louvain` package, run on a graph where an edge's
weight is the number of relationships connecting that pair of notes (a pair
that is both linked and tagged and semantically similar counts for more
than a coincidental single edge). The library's RNG is seeded
deterministically (a small xorshift-style generator, not `Math.random`), so
re-running Louvain on an *unchanged* graph always produces the same
partition instead of reshuffling colors between panel opens.

**Between rebuilds,** `CommunityIdStabilizer` keeps the numbers steady. Louvain's
numbering only reflects size order, so one edit could swap two communities and
recolor every note in them. Each new community instead takes the number of the old
community it shares the most notes with.

**Fallback path** (keyword/link grouping) is used when:

- there are fewer than 3 notes or no edges at all (`MIN_NOTES_FOR_LOUVAIN`),
  since Louvain would only produce singletons;
- Louvain's result is *degenerate*: at or above an 80% ratio of communities
  to notes (`DEGENERATE_COMMUNITY_RATIO`), which is functionally the same
  as everyone being their own island;
- Louvain throws.

The fallback groups notes by their most frequent meaningful word (English
stopwords and words of 3 characters or fewer are ignored), then unions
groups that share a direct edge, using a union-find (`DisjointSet`)
structure. If Louvain's result was merely more fragmented than the fallback
(not degenerate, just worse) and the fallback isn't itself *collapsed*
(one bucket holding 80%+ of all notes, `MAX_FALLBACK_DOMINANT_SHARE`), the
fallback replaces it.

**Stability:** whichever result wins, community IDs are first renumbered by
group size, largest first, ties broken by the lowest member note ID. That
makes community `0` always the biggest community for a *given* note/edge set,
so re-rendering an unchanged graph never recolors it. That guarantee is
scoped to a fixed note/edge set: adding or removing notes can shift which
community is largest and therefore reassign IDs, which is why colors can
shift as a vault grows even though they hold steady between two opens of an
unchanged one.

## Diffing: `GraphDiffer`

`GraphDiffer` (`src/services/graph/GraphDiffer.ts`) computes the difference
between the previously built `GraphData` and a newly built one:

```ts
interface GraphDiff {
    upsertedNodes: Array<{ data: GraphNode }>;
    upsertedEdges: Array<{ data: RenderedEdge }>;
    removedNodeIds: string[];
    removedEdgeIds: string[];
}
```

A node or edge counts as changed if any field present on either side
differs. The comparison is over the union of both objects' defined keys, not
their key counts, so a node gaining or losing an optional field like
`category` (set by Pass B, absent otherwise) is detected correctly instead
of being miscounted as a length mismatch. `GraphPresenter` runs this diff on the
view on screen after every change, and sends the result as a patch instead of the
whole view. See [Large vaults](large-vaults.md).
