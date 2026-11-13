import { buildStatusReport, StatusInputs, StatusItem } from './StatusReport';
import { StatusTracker } from './StatusTracker';

function inputs(overrides: {
	tracker?: (tracker: StatusTracker) => void;
	noteCount?: number;
	ai?: Partial<StatusInputs['ai']>;
	labels?: Partial<StatusInputs['labels']>;
}): StatusInputs {
	const tracker = new StatusTracker(() => 1000);
	tracker.notesLoaded(true, false);
	overrides.tracker?.(tracker);
	return {
		tracked: tracker.snapshot(),
		noteCount: overrides.noteCount ?? 500,
		ai: {
			enabled: true,
			index: {
				state: 'ready',
				ready: true,
				modelId: 'm',
				notesIndexed: 500,
				totalNotes: 500,
			},
			unavailableReason: null,
			embeddedNotes: 500,
			running: false,
			...overrides.ai,
		},
		labels: {
			enabled: false,
			semanticEdges: 0,
			labeledEdges: 0,
			budgetUsed: 0,
			budgetLimit: 200,
			running: false,
			...overrides.labels,
		},
		problems: [],
	};
}

const item = (report: { items: StatusItem[] }, title: string): StatusItem => {
	const found = report.items.find((i) => i.title === title);
	if (!found) throw new Error(`No status item called ${title}`);
	return found;
};

const NOTES = 'Notes';
const AI = 'Similar notes (AI)';
const LABELS = 'Connection explanations (AI)';

describe('buildStatusReport', () => {
	it('is all fine when everything has loaded', () => {
		const report = buildStatusReport(
			inputs({ noteCount: 10537, ai: { embeddedNotes: 10537 } })
		);

		expect(report.level).toBe('ok');
		expect(item(report, NOTES).text).toBe('10,537 notes loaded.');
		expect(item(report, AI).text).toBe('10,537 of 10,537 notes have AI data.');
	});

	it('shows note loading progress', () => {
		const report = buildStatusReport(
			inputs({
				tracker: (t) => {
					t.noteLoadStarted();
					t.noteLoadProgressed('Reading tags: 300 of 10537 notes...');
				},
			})
		);

		expect(item(report, NOTES)).toMatchObject({
			level: 'working',
			text: 'Reading tags: 300 of 10537 notes...',
		});
		expect(report.items.map((i) => i.title)).not.toContain('Keeping up to date');
	});

	it('asks for attention, with a way to load again, when notes are missing', () => {
		const report = buildStatusReport(inputs({ tracker: (t) => t.notesLoaded(false, false) }));

		expect(report.level).toBe('attention');
		expect(item(report, NOTES).action).toEqual({ id: 'reload-notes', label: 'Load again' });
	});

	it('explains that Joplin AI is getting ready, without asking for anything', () => {
		const report = buildStatusReport(
			inputs({
				tracker: (t) =>
					t.aiFinished('Joplin AI index is not usable yet (state: preparing).'),
				ai: {
					index: {
						state: 'preparing',
						ready: false,
						modelId: null,
						notesIndexed: 0,
						totalNotes: 0,
					},
					embeddedNotes: 0,
				},
			})
		);

		expect(item(report, AI).level).toBe('working');
		expect(item(report, AI).text).toContain('getting ready');
		expect(item(report, AI).action).toBeUndefined();
	});

	it('says how far Joplin has got while it is still indexing', () => {
		const report = buildStatusReport(
			inputs({
				ai: {
					index: {
						state: 'indexing',
						ready: false,
						modelId: 'm',
						notesIndexed: 95,
						totalNotes: 10537,
					},
					embeddedNotes: 95,
				},
				noteCount: 10537,
			})
		);

		expect(item(report, AI)).toMatchObject({
			level: 'working',
			text: '95 of 10,537 notes have AI data. Joplin is still indexing the rest, and they are added on their own.',
		});
	});

	it('shows embedding progress while a run is going', () => {
		const report = buildStatusReport(
			inputs({
				tracker: (t) => {
					t.aiStarted();
					t.aiProgressed({ current: 2000, total: 10537 });
				},
				ai: { running: true },
			})
		);

		expect(item(report, AI).text).toBe('Reading AI data: 2,000 of 10,537 notes.');
	});

	it('offers to run AI again after it was cancelled', () => {
		const report = buildStatusReport(inputs({ tracker: (t) => t.cancelled('ai') }));

		expect(item(report, AI)).toMatchObject({
			level: 'attention',
			action: { id: 'retry-ai', label: 'Run again' },
		});
		expect(item(report, LABELS).level).toBe('off');
	});

	it('does not offer to run AI before the notes are loaded', () => {
		const tracker = new StatusTracker(() => 1000);
		tracker.noteLoadFailed();
		const base = inputs({});
		const report = buildStatusReport({
			...base,
			tracked: tracker.snapshot(),
			ai: { ...base.ai, index: { ...(base.ai.index as NonNullable<typeof base.ai.index>), state: 'disabled' } },
		});

		expect(item(report, AI).level).toBe('attention');
		expect(item(report, AI).action).toBeUndefined();
	});

	it('gives the reason and a retry when AI was not used', () => {
		const report = buildStatusReport(
			inputs({
				tracker: (t) => t.aiFinished('Embedding fetch failed'),
				ai: { embeddedNotes: 0 },
			})
		);

		expect(item(report, AI)).toMatchObject({
			level: 'attention',
			text: 'Not used yet: Embedding fetch failed',
			action: { id: 'retry-ai' },
		});
	});

	it('says when Joplin AI is not available at all', () => {
		const report = buildStatusReport(
			inputs({
				ai: {
					index: null,
					unavailableReason: 'joplin.ai is not available.',
					embeddedNotes: 0,
				},
			})
		);

		expect(item(report, AI).text).toContain('Joplin 3.7 or later');
	});

	it('marks both AI parts as off when the settings are off', () => {
		const report = buildStatusReport(inputs({ ai: { enabled: false } }));

		expect(item(report, AI).level).toBe('off');
		expect(item(report, LABELS).level).toBe('off');
		expect(report.level).toBe('ok');
	});

	it('counts explained connections, says the rest follow in the background, and offers more now', () => {
		const report = buildStatusReport(
			inputs({
				labels: {
					enabled: true,
					semanticEdges: 900,
					labeledEdges: 200,
					budgetUsed: 200,
				},
			})
		);

		expect(item(report, LABELS)).toMatchObject({
			level: 'ok',
			text: '200 of 900 similar-note connections are explained. The rest are explained in the background, up to 200 at a time, to limit AI requests.',
			action: { id: 'retry-labels', label: 'Explain 200 more' },
		});
	});

	it('shows label progress only while labelling is running', () => {
		const running = buildStatusReport(
			inputs({
				tracker: (t) => t.labelsProgressed({ current: 3, total: 50 }),
				labels: { enabled: true, semanticEdges: 900, running: true },
			})
		);
		const finished = buildStatusReport(
			inputs({
				tracker: (t) => t.labelsProgressed({ current: 3, total: 50 }),
				labels: { enabled: true, semanticEdges: 900, labeledEdges: 900 },
			})
		);

		expect(item(running, LABELS).text).toBe('Explaining connections: batch 3 of 50.');
		expect(item(finished, LABELS).text).toBe(
			'900 of 900 similar-note connections are explained.'
		);
	});

	it('reports a cancelled labelling run on its own line, not on AI', () => {
		const report = buildStatusReport(
			inputs({
				tracker: (t) => t.cancelled('labels'),
				labels: { enabled: true, semanticEdges: 900, labeledEdges: 100 },
			})
		);

		expect(item(report, LABELS).action).toEqual({ id: 'retry-labels', label: 'Run again' });
		expect(item(report, AI).level).toBe('ok');
	});
});
