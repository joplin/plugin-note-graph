import joplin from 'api';

export interface Note {
    id: string;
    title: string;
    body: string;
    parent_id: string;
    created_time: number;
    updated_time: number;
    tags: Tag[];
    links: string[];
}

export interface Tag {
    id: string;
    title: string;
    created_time: number;
    updated_time: number;
}

function extractLinks(body: string): string[] {
    const linkPattern = new RegExp(':/([a-f0-9]{32})', 'g');
    const matches: string[] = [];
    let match;
    while ((match = linkPattern.exec(body)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

async function buildNoteTagsMap(): Promise<Map<string, Tag[]>> {
    const noteTagsMap = new Map<string, Tag[]>();
    
    const tagsResponse = await joplin.data.get(['tags']);
    const allTags = tagsResponse.items || [];
    
    for (const tag of allTags) {
        const notesResponse = await joplin.data.get(['tags', tag.id, 'notes']);
        for (const note of notesResponse.items || []) {
            if (!noteTagsMap.has(note.id)) {
                noteTagsMap.set(note.id, []);
            }
            noteTagsMap.get(note.id)!.push(tag);
        }
    }
    
    return noteTagsMap;
}

export async function fetchAllNotes(): Promise<Note[]> {
    const noteTagsMap = await buildNoteTagsMap();
    const notes: Note[] = [];
    const fields = ['id', 'title', 'body', 'parent_id', 'created_time', 'updated_time'];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const response = await joplin.data.get(['notes'], {
            fields,
            limit: 100,
            page,
        });

        for (const note of response.items) {
            const tags = noteTagsMap.get(note.id) || [];
            const links = extractLinks(note.body);
            notes.push({
                ...note,
                tags,
                links,
            });
        }

        hasMore = response.has_more;
        page++;
    }

    return notes;
}

export async function getAllTags(): Promise<Tag[]> {
    const response = await joplin.data.get(['tags']);
    return response.items || [];
}

export async function getNotesWithTag(tagId: string): Promise<Note[]> {
    const noteTagsMap = await buildNoteTagsMap();
    const response = await joplin.data.get(['tags', tagId, 'notes']);
    const tagNotes: Note[] = [];

    for (const note of response.items || []) {
        const links = extractLinks(note.body);
        tagNotes.push({
            ...note,
            tags: noteTagsMap.get(note.id) || [],
            links,
        });
    }

    return tagNotes;
}