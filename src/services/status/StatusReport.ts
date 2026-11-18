import { AiIndexStatus } from '../embeddings/providers/JoplinNativeProvider';
import { LoggedProblem } from './RecordingLogger';
import { TrackedStatus } from './StatusTracker';

export type StatusLevel = 'ok' | 'working' | 'attention' | 'off';
export type StatusAction = 'reload-notes' | 'retry-ai' | 'retry-labels';

export interface StatusMetric {
	value: string;
	label: string;
	fraction?: number;
}

export interface StatusItem {
	title: string;
	level: StatusLevel;
	text: string;
	usesAi?: boolean;
	metric?: StatusMetric;
	continuesInBackground?: boolean;
	action?: { id: StatusAction; label: string };
}

export interface StatusReport {
	level: StatusLevel;
	summary: string;
	items: StatusItem[];
	problems: LoggedProblem[];
	lastGraphShownAt: number | null;
}

export interface StatusInputs {
	tracked: TrackedStatus;
	noteCount: number;
	ai: {
		enabled: boolean;
		/** Null when the index status couldn't be read. */
		index: AiIndexStatus | null;
		/** Why Joplin AI can't be used at all, such as an older Joplin. */
		unavailableReason: string | null;
		embeddedNotes: number;
		running: boolean;
	};
	labels: {
		enabled: boolean;
		semanticEdges: number;
		labeledEdges: number;
		budgetUsed: number;
		budgetLimit: number;
		running: boolean;
	};
	problems: LoggedProblem[];
}

const count = (n: number): string => n.toLocaleString('en-US');

function partOf(done: number, total: number): StatusMetric {
	return {
		value: count(done),
		label: `of ${count(total)}`,
		fraction: total > 0 ? Math.min(1, done / total) : 0,
	};
}

function notesItem({ tracked, noteCount }: StatusInputs): StatusItem {
	const title = 'Notes';
	const reload = { id: 'reload-notes' as const, label: 'Load again' };
	switch (tracked.noteLoad) {
		case 'not-started':
			return { title, level: 'working', text: 'Waiting to load your notes.' };
		case 'loading':
			return {
				title,
				level: 'working',
				text: tracked.noteLoadDetail ?? 'Loading your notes...',
			};
		case 'failed':
			return {
				title,
				level: 'attention',
				text: 'Could not load your notes. Trying again shortly.',
				action: reload,
			};
	}
	const metric = { value: count(noteCount), label: 'loaded' };
	if (!tracked.notesComplete) {
		return {
			title,
			level: 'attention',
			metric,
			text: 'Some notes or tags could not be read, so some connections are missing.',
			action: reload,
		};
	}
	return {
		title,
		level: 'ok',
		metric,
		text: tracked.loadedFromCache
			? 'Opened from the saved graph, then checked for changes.'
			: 'Read from your notebooks.',
	};
}

function aiItem(inputs: StatusInputs): StatusItem {
	return { ...aiState(inputs), title: 'Similar notes', usesAi: true };
}

function aiState({ tracked, noteCount, ai }: StatusInputs): Omit<StatusItem, 'title'> {
	// Nothing to run on until the notes are loaded, and running on none would commit an empty graph.
	const retry =
		tracked.noteLoad === 'loaded' ? { id: 'retry-ai' as const, label: 'Run again' } : undefined;
	if (!ai.enabled) {
		return {
			level: 'off',
			text: 'Off. Turn on "Enable AI-based semantic analysis" in Settings → Note Graph to connect notes about similar things.',
		};
	}
	if (ai.running) {
		const progress = tracked.aiProgress;
		return progress
			? {
					level: 'working',
					metric: partOf(progress.current, progress.total),
					text: 'Reading AI data for your notes.',
			  }
			: { level: 'working', text: 'Starting AI analysis...' };
	}
	if (tracked.aiCancelled) {
		return {
			level: 'attention',
			text: 'Stopped because it was cancelled.',
			action: retry,
		};
	}
	if (ai.unavailableReason) {
		return {
			level: 'attention',
			text: "Joplin AI isn't available. It needs Joplin 3.7 or later, with AI turned on in Settings → AI.",
		};
	}
	const state = ai.index?.state;
	if (state === 'disabled' || state === 'unavailable') {
		return {
			level: 'attention',
			text: "Joplin AI's note index is off. Turn it on in Settings → AI, then run this again.",
			action: retry,
		};
	}
	if (state === 'preparing') {
		return {
			level: 'working',
			text: 'Joplin AI is getting ready. Similar-note connections are added on their own once it is, within a few minutes.',
		};
	}
	if (ai.embeddedNotes === 0) {
		return tracked.aiFallbackReason
			? {
					level: 'attention',
					text: `Not used yet: ${tracked.aiFallbackReason}`,
					action: retry,
			  }
			: { level: 'working', text: 'Waiting for AI data.' };
	}

	const metric = partOf(ai.embeddedNotes, noteCount);
	const embedded = 'Notes that have AI data.';
	if (state === 'indexing') {
		return {
			level: 'working',
			metric,
			text: `${embedded} Joplin is still indexing the rest, and they are added on their own.`,
		};
	}
	return { level: 'ok', metric, text: embedded };
}

function labelsItem(inputs: StatusInputs): StatusItem {
	return { ...labelsState(inputs), title: 'Connection explanations', usesAi: true };
}

function labelsState({ tracked, ai, labels }: StatusInputs): Omit<StatusItem, 'title'> {
	if (!labels.enabled) {
		return {
			level: 'off',
			text: 'Off. Turn on "Enable LLM analysis" in Settings → Note Graph to explain why similar notes are connected.',
		};
	}
	if (!ai.enabled) {
		return {
			level: 'off',
			text: 'Needs "Enable AI-based semantic analysis" to be on as well.',
		};
	}
	if (labels.running) {
		const progress = tracked.labelProgress;
		return {
			level: 'working',
			text: progress
				? `Explaining connections: batch ${count(progress.current)} of ${count(
						progress.total
				  )}.`
				: 'Explaining connections...',
		};
	}
	if (labels.semanticEdges === 0) {
		return { level: 'ok', text: 'Waiting for similar-note connections to explain.' };
	}
	if (tracked.labelsCancelled) {
		return {
			level: 'attention',
			text: 'Stopped because it was cancelled.',
			action: { id: 'retry-labels', label: 'Run again' },
		};
	}

	const metric = partOf(labels.labeledEdges, labels.semanticEdges);
	const explained = 'Similar-note connections that are explained.';
	const unlabeled = labels.semanticEdges - labels.labeledEdges;
	if (unlabeled <= 0) return { level: 'ok', metric, text: explained };

	const limitReached = labels.budgetUsed >= labels.budgetLimit;
	const more = Math.min(labels.budgetLimit, unlabeled);
	return {
		level: 'ok',
		metric,
		continuesInBackground: limitReached,
		text: limitReached
			? `The rest are explained in the background, up to ${count(
					labels.budgetLimit
			  )} at a time, to limit AI requests.`
			: explained,
		action: { id: 'retry-labels', label: `Explain ${count(more)} more` },
	};
}

function updatesItem({ tracked }: StatusInputs): StatusItem | null {
	if (tracked.noteLoad !== 'loaded') return null;
	return {
		title: 'Keeping up to date',
		level: 'ok',
		text: 'Edits, new notes, moves, deletions and syncs show up on their own.',
	};
}

function overallLevel(items: StatusItem[]): StatusLevel {
	if (items.some((item) => item.level === 'attention')) return 'attention';
	if (items.some((item) => item.level === 'working')) return 'working';
	return 'ok';
}

function summarize(level: StatusLevel, notes: StatusItem, ai: StatusItem): string {
	if (level === 'attention') return 'Needs attention';
	if (level !== 'working') return 'Up to date';
	if (notes.level === 'working') return 'Loading notes';
	return ai.level === 'working' ? 'Building graph' : 'Enriching notes';
}

/** Describes, in plain words, what the plugin is doing and anything the user can do about it. */
export function buildStatusReport(inputs: StatusInputs): StatusReport {
	const notes = notesItem(inputs);
	const ai = aiItem(inputs);
	const items = [notes, ai, labelsItem(inputs), updatesItem(inputs)].filter(
		(item): item is StatusItem => item !== null
	);
	const level = overallLevel(items);
	return {
		level,
		summary: summarize(level, notes, ai),
		items,
		problems: inputs.problems,
		lastGraphShownAt: inputs.tracked.lastGraphShownAt,
	};
}
