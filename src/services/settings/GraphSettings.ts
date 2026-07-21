import joplin from 'api';
import { SettingItemType } from 'api/types';
import { DEFAULT_THRESHOLD, TOP_K } from '../similarity/ThresholdPresets';

const SECTION_NAME = 'noteGraph';
const AI_ANALYSIS_ENABLED_KEY = 'noteGraph.aiAnalysisEnabled';
const SIMILARITY_THRESHOLD_KEY = 'noteGraph.similarityThreshold';
const MAX_EDGES_PER_NOTE_KEY = 'noteGraph.maxEdgesPerNote';

/**
 * Registers plugin settings. Registration is dynamic (lost on restart), so
 * this must run on every onStart — the stored value itself persists.
 */
export async function registerGraphSettings(): Promise<void> {
	await joplin.settings.registerSection(SECTION_NAME, {
		label: 'Note Graph',
	});

	await joplin.settings.registerSettings({
		[AI_ANALYSIS_ENABLED_KEY]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION_NAME,
			label: 'Enable AI-based semantic analysis',
			description:
				'Adds semantic similarity edges to the note graph using Joplin AI. Requires Joplin AI to be enabled with a ready embedding index (Settings → AI).',
		},
		[SIMILARITY_THRESHOLD_KEY]: {
			value: Math.round(DEFAULT_THRESHOLD * 100),
			type: SettingItemType.Int,
			minimum: 0,
			maximum: 100,
			step: 5,
			public: true,
			section: SECTION_NAME,
			label: 'Similarity threshold (%)',
			description: 'Lower value = more semantic edges. Only applies when AI analysis is enabled.',
		},
		[MAX_EDGES_PER_NOTE_KEY]: {
			value: TOP_K,
			type: SettingItemType.Int,
			minimum: 1,
			maximum: 20,
			step: 1,
			public: true,
			section: SECTION_NAME,
			label: 'Max semantic edges per note (top-K)',
			description: 'Only applies when AI analysis is enabled.',
		},
	});
}

export async function isAiAnalysisEnabled(): Promise<boolean> {
	return await joplin.settings.value(AI_ANALYSIS_ENABLED_KEY);
}

/**
 * Joplin settings have no float/slider type, only Int — the threshold is
 * stored as a 0-100 percentage and converted here to the 0-1 scale
 * SimilarityEngine expects.
 */
export async function getSimilaritySettings(): Promise<{ threshold: number; topK: number }> {
	const values = await joplin.settings.values([SIMILARITY_THRESHOLD_KEY, MAX_EDGES_PER_NOTE_KEY]);
	return {
		threshold: values[SIMILARITY_THRESHOLD_KEY] / 100,
		topK: values[MAX_EDGES_PER_NOTE_KEY],
	};
}
