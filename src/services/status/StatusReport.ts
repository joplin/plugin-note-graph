import { AiIndexStatus } from '../embeddings/providers/JoplinNativeProvider';
import { LoggedProblem } from './RecordingLogger';
import { TrackedStatus } from './StatusTracker';

export type StatusLevel = 'ok' | 'working' | 'attention' | 'off';
export type StatusAction = 'reload-notes' | 'retry-ai' | 'retry-labels';

export interface StatusItem {
	title: string;
	level: StatusLevel;
	text: string;
	action?: { id: StatusAction; label: string };
}

export interface StatusReport {
	level: StatusLevel;
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
	if (!tracked.notesComplete) {
		return {
			title,
			level: 'attention',
			text: `${count(
				noteCount
			)} notes loaded, but some notes or tags could not be read, so some connections are missing.`,
			action: reload,
		};
	}
	const source = tracked.loadedFromCache
		? ' Opened from the saved graph, then checked for changes.'
		: '';
	return { title, level: 'ok', text: `${count(noteCount)} notes loaded.${source}` };
}

function aiItem({ tracked, noteCount, ai }: StatusInputs): StatusItem {
	const title = 'Similar notes (AI)';
	const retry = { id: 'retry-ai' as const, label: 'Run again' };
	if (!ai.enabled) {
		return {
			title,
			level: 'off',
			text: 'Off. Turn on "Enable AI-based semantic analysis" in Settings → Note Graph to connect notes about similar things.',
		};
	}
	if (ai.running) {
		const progress = tracked.aiProgress;
		return {
			title,
			level: 'working',
			text: progress
				? `Reading AI data: ${count(progress.current)} of ${count(progress.total)} notes.`
				: 'Starting AI analysis...',
		};
	}
	if (tracked.aiCancelled) {
		return {
			title,
			level: 'attention',
			text: 'Stopped because it was cancelled.',
			action: retry,
		};
	}
	if (ai.unavailableReason) {
		return {
			title,
			level: 'attention',
			text: "Joplin AI isn't available. It needs Joplin 3.7 or later, with AI turned on in Settings → AI.",
		};
	}
	const state = ai.index?.state;
	if (state === 'disabled' || state === 'unavailable') {
		return {
			title,
			level: 'attention',
			text: "Joplin AI's note index is off. Turn it on in Settings → AI, then run this again.",
			action: retry,
		};
	}
	if (state === 'preparing') {
		return {
			title,
			level: 'working',
			text: 'Joplin AI is getting ready. Similar-note connections are added on their own once it is, within a few minutes.',
		};
	}
	if (ai.embeddedNotes === 0) {
		return tracked.aiFallbackReason
			? {
					title,
					level: 'attention',
					text: `Not used yet: ${tracked.aiFallbackReason}`,
					action: retry,
			  }
			: { title, level: 'working', text: 'Waiting for AI data.' };
	}

	const embedded = `${count(ai.embeddedNotes)} of ${count(noteCount)} notes have AI data.`;
	if (state === 'indexing') {
		return {
			title,
			level: 'working',
			text: `${embedded} Joplin is still indexing the rest, and they are added on their own.`,
		};
	}
	return { title, level: 'ok', text: embedded };
}

function labelsItem({ tracked, ai, labels }: StatusInputs): StatusItem {
	const title = 'Connection explanations (AI)';
	if (!labels.enabled) {
		return {
			title,
			level: 'off',
			text: 'Off. Turn on "Enable LLM analysis" in Settings → Note Graph to explain why similar notes are connected.',
		};
	}
	if (!ai.enabled) {
		return {
			title,
			level: 'off',
			text: 'Needs "Enable AI-based semantic analysis" to be on as well.',
		};
	}
	if (labels.running) {
		const progress = tracked.labelProgress;
		return {
			title,
			level: 'working',
			text: progress
				? `Explaining connections: batch ${count(progress.current)} of ${count(
						progress.total
				  )}.`
				: 'Explaining connections...',
		};
	}
	if (labels.semanticEdges === 0) {
		return { title, level: 'ok', text: 'Waiting for similar-note connections to explain.' };
	}
	if (tracked.labelsCancelled) {
		return {
			title,
			level: 'attention',
			text: 'Stopped because it was cancelled.',
			action: { id: 'retry-labels', label: 'Run again' },
		};
	}

	const explained = `${count(labels.labeledEdges)} of ${count(
		labels.semanticEdges
	)} similar-note connections are explained.`;
	const unlabeled = labels.semanticEdges - labels.labeledEdges;
	if (unlabeled <= 0) return { title, level: 'ok', text: explained };

	const limitReached = labels.budgetUsed >= labels.budgetLimit;
	const more = Math.min(labels.budgetLimit, unlabeled);
	return {
		title,
		level: 'ok',
		text: limitReached
			? `${explained} Up to ${count(
					labels.budgetLimit
			  )} are explained per session, to limit AI requests.`
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

/** Describes, in plain words, what the plugin is doing and anything the user can do about it. */
export function buildStatusReport(inputs: StatusInputs): StatusReport {
	const items = [
		notesItem(inputs),
		aiItem(inputs),
		labelsItem(inputs),
		updatesItem(inputs),
	].filter((item): item is StatusItem => item !== null);
	return {
		level: overallLevel(items),
		items,
		problems: inputs.problems,
		lastGraphShownAt: inputs.tracked.lastGraphShownAt,
	};
}
