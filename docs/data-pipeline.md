# Data pipeline

Before any graph is built, notes go through a fetch-and-enrich pipeline that
turns raw Joplin API responses into the `Note` shape the rest of the plugin
works with:

```ts
interface Note {
    id: string;
    parent_id: string;
    title: string;
    body: string;
    created_time: number;
    updated_time: number;
    links?: string[];
    tags?: string[];
}
```

`links` and `tags` are not part of Joplin's note API response; they are
populated by `NotePreprocessor` before anything downstream sees the note.

## Fetching notes

`NoteRepository` (`src/data/NoteRepository.ts`) fetches notes in pages of up
to 100 through `joplin.data.get(['notes'], ...)`, requesting only the fields
the plugin needs (`id`, `parent_id`, `title`, `body`, `created_time`,
`updated_time`, `deleted_time`). Notes with a non-zero `deleted_time` (in the
trash) are filtered out. Every note is fetched (no cap); a page fetch
error truncates rather than throwing, so a transient API error surfaces a
partial graph instead of failing the whole load.

`getNote(id)` fetches a single note for the incremental-update path. A 404
("Not Found") is treated as "the note no longer exists" and returns `null`
rather than throwing, since a deleted note is a normal outcome, not an
error.

## Extracting tags

`TagRepository` (`src/data/TagRepository.ts`) builds a note-to-tags map two
ways:

- `getNoteTagsMap()`: fetches all tags (capped at 1000), then for each tag
  fetches every note that has it, and inverts that into a
  `Record<noteId, tagTitle[]>`. Used for full loads.
- `getTagsForNote(noteId)`: fetches tags for one note directly, capped at
  100 pages as a safety limit. Used for the incremental single-note path
  (`NotePreprocessor.processOne`).

Both report a `truncated` flag rather than throwing when a cap is hit, so a
large vault degrades to partial tag data instead of failing outright.

## Extracting links

`LinkExtractor` (`src/data/LinkExtractor.ts`) scans a note's Markdown body
for Joplin's internal resource link format: `:/<32-hex-id>` or
`joplin://<32-hex-id>`, optionally followed by a `#hash` anchor. It looks in
three places:

- Markdown inline links: `[text](:/id)`.
- Markdown reference-style link definitions: `[text]: :/id`.
- HTML `<a href="...">` and `<img src="...">` tags (Joplin note bodies can
  contain raw HTML).

Fenced and inline code blocks are stripped before scanning, so a link
pasted as an example inside a code block is not treated as a real
connection. `extractLinks()` returns the deduplicated set of linked item
IDs; whether that ID is actually another note (versus an attached image or
file) is decided later, by `EdgeFactory` checking it against the set of
notes currently in scope.

## Enrichment

`NotePreprocessor` (`src/data/NotePreprocessor.ts`) combines the two:

- `process(notes)`: builds the tag map once for the whole batch, then maps
  every note to itself plus `links` (via `LinkExtractor`) and `tags` (via
  the map). Used on full loads.
- `processOne(note)`: same idea for a single note, using
  `TagRepository.getTagsForNote`. Used when the incremental updater
  re-fetches one changed note. Throws if the tag fetch was truncated,
  since a partial tag list for a single note (unlike a whole-vault batch)
  usually means something is wrong rather than just large.

## Where this feeds in

`index.ts`'s `loadNotes()` runs `NoteRepository.getAllNotes()` then
`NotePreprocessor.process()` and hands the result to
`AnalysisController.buildStructural()` and `.embedAndBuildSemantic()`. See
[Graph model](graph-model.md) for what happens next.
