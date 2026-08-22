import { GraphBuilder } from './GraphBuilder';
import { LinkExtractor } from '../../data/LinkExtractor';
import { Note } from '../../data/Types';
import { EmbeddedNote } from '../embeddings/Types';

const linkExtractor = new LinkExtractor();

const hex = (digit: string): string => digit.repeat(32);

const A = hex('1');
const B = hex('2');
const C = hex('3');
const D = hex('4');
const E = hex('5');
const F = hex('6');
const OUT_OF_SCOPE = hex('9');

function note(id: string, title: string, body: string, tags: string[] = []): Note {
	return {
		id,
		parent_id: 'parent',
		title,
		body,
		created_time: 0,
		updated_time: 1,
		links: linkExtractor.extractLinks(body),
		tags,
	};
}

describe('graph pipeline (golden set)', () => {
	let builder: GraphBuilder;

	beforeEach(() => {
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		builder = new GraphBuilder();
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('renders the structural graph end-to-end from links, tags, communities and centrality', () => {
		const notes: Note[] = [
			note(A, 'Alpha Note', `See [Beta](:/${B}) and [Gamma](:/${C}).`, ['project', 'todo']),
			note(B, 'Beta', `Related to [Gamma](:/${C}).`, ['project']),
			note(
				C,
				'Gamma',
				`Back to [Alpha](:/${A}).\n\n\`[Beta](:/${B})\` in inline code.\n\n\`\`\`\n[Alpha](:/${A}) fenced\n\`\`\``,
				['urgent']
			),
			note(D, '', `References [Alpha](:/${A}) and <a href=":/${A}">again</a>.`, ['todo']),
			note(E, 'E'.repeat(80), `Links to an [external note](:/${OUT_OF_SCOPE}) not in scope.`),
			note(F, 'Standalone', 'A note with no connections.'),
		];

		expect(builder.build(notes)).toMatchSnapshot();
	});

	it('renders the semantic graph end-to-end from embeddings through thresholding and top-K', async () => {
		const notes: Note[] = [
			note(A, 'Alpha', `[Beta](:/${B})`, ['project']),
			note(B, 'Beta', '', ['project']),
			note(C, 'Gamma', '', []),
		];
		const embeddedNotes: EmbeddedNote[] = [
			{ note: notes[0], embedding: [1, 0] },
			{ note: notes[1], embedding: [1, 0] },
			{ note: notes[2], embedding: [0, 1] },
		];

		await expect(
			builder.buildWithSimilarity(notes, embeddedNotes, 0.5, 5)
		).resolves.toMatchSnapshot();
	});

	it('marks an empty corpus as not very short and a stub-only corpus as very short', () => {
		expect(builder.build([]).allNotesVeryShort).toBe(false);
		expect(builder.build([note(A, 'A', 'stub')]).allNotesVeryShort).toBe(true);
	});

	it('groups disconnected notes by keyword when the graph is too sparse for Louvain', () => {
		const notes: Note[] = [
			note(A, 'Gardening Basics', ''),
			note(B, 'Gardening Tools', ''),
			note(C, 'Cooking Pasta', ''),
			note(D, 'Cooking Pizza', ''),
			note(E, 'Photography', ''),
		];

		expect(builder.build(notes)).toMatchSnapshot();
	});

	it('assigns a flat mid-range size and a single community to a cycle of equal-degree notes', () => {
		const notes: Note[] = [
			note(A, 'Alpha', `[Beta](:/${B})`),
			note(B, 'Beta', `[Gamma](:/${C})`),
			note(C, 'Gamma', `[Alpha](:/${A})`),
		];

		expect(builder.build(notes)).toMatchSnapshot();
	});

	it('merges every shared tag onto a single tag edge', () => {
		const notes: Note[] = [
			note(A, 'Alpha', '', ['alpha', 'beta']),
			note(B, 'Beta', '', ['alpha', 'beta']),
			note(C, 'Gamma', '', ['gamma']),
		];

		expect(builder.build(notes)).toMatchSnapshot();
	});

	it('keeps a sub-floor linked pair as a link edge without manufacturing a semantic edge', async () => {
		const notes: Note[] = [note(A, 'Alpha', `[Beta](:/${B})`), note(B, 'Beta', '')];
		const embeddedNotes: EmbeddedNote[] = [
			{ note: notes[0], embedding: [1, 0] },
			{ note: notes[1], embedding: [0, 1] },
		];

		await expect(
			builder.buildWithSimilarity(notes, embeddedNotes, 0.5, 5)
		).resolves.toMatchSnapshot();
	});
});
