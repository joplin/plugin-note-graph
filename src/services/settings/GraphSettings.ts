import joplin from 'api';
import { SettingItemType } from 'api/types';
import { DEFAULT_THRESHOLD, TOP_K } from '../similarity/ThresholdPresets';
import { ScopeMode, ScopeSettings } from './NoteScopeResolver';

const SECTION_NAME = 'noteGraph';
export const AI_ANALYSIS_ENABLED_KEY = 'noteGraph.aiAnalysisEnabled';
const SIMILARITY_THRESHOLD_KEY = 'noteGraph.similarityThreshold';
const MAX_EDGES_PER_NOTE_KEY = 'noteGraph.maxEdgesPerNote';
export const LLM_ENRICHMENT_ENABLED_KEY = 'noteGraph.llmEnrichmentEnabled';
export const RETRY_EMBEDDING_KEY = 'noteGraph.retryEmbedding';
export const RETRY_ENRICHMENT_KEY = 'noteGraph.retryEnrichment';
export const SCOPE_MODE_KEY = 'noteGraph.scopeMode';
export const SCOPE_SELECTED_NOTEBOOKS_KEY = 'noteGraph.scopeSelectedNotebooks';

export const SCOPE_SETTING_KEYS = [SCOPE_MODE_KEY, SCOPE_SELECTED_NOTEBOOKS_KEY];

/** All Note Graph setting keys — the single source of truth for anything that needs to check "did one of our settings change?" */
export const NOTE_GRAPH_SETTING_KEYS = [
	AI_ANALYSIS_ENABLED_KEY,
	SIMILARITY_THRESHOLD_KEY,
	MAX_EDGES_PER_NOTE_KEY,
	LLM_ENRICHMENT_ENABLED_KEY,
	RETRY_EMBEDDING_KEY,
	RETRY_ENRICHMENT_KEY,
	...SCOPE_SETTING_KEYS,
];

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
			description:
				'Lower value = more semantic edges. Only applies when AI analysis is enabled.',
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
		[LLM_ENRICHMENT_ENABLED_KEY]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION_NAME,
			label: 'Enable LLM analysis',
			description:
				'Uses Joplin AI chat to add category labels and relationship descriptions to notes/edges already flagged as related by AI analysis. Requires AI-based semantic analysis to be enabled.',
		},
		[RETRY_EMBEDDING_KEY]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION_NAME,
			label: 'Retry AI embedding',
			description:
				'Tick to immediately retry AI-based semantic analysis (e.g. after cancelling it). Unticks itself once the retry starts. No-op if the graph panel has not been opened yet.',
		},
		[RETRY_ENRICHMENT_KEY]: {
			value: false,
			type: SettingItemType.Bool,
			public: true,
			section: SECTION_NAME,
			label: 'Retry AI labels',
			description:
				'Tick to immediately retry LLM analysis for any note/edge still missing a label. Unticks itself once the retry starts. No-op if the graph panel has not been opened yet.',
		},
		[SCOPE_MODE_KEY]: {
			value: 'current',
			type: SettingItemType.String,
			public: false,
			label: 'Analysis scope',
		},
		[SCOPE_SELECTED_NOTEBOOKS_KEY]: {
			value: '',
			type: SettingItemType.String,
			public: false,
			label: 'Selected notebooks',
		},
	});
}

export async function isAiAnalysisEnabled(): Promise<boolean> {
	return await joplin.settings.value(AI_ANALYSIS_ENABLED_KEY);
}

export async function isLlmEnrichmentEnabled(): Promise<boolean> {
	return await joplin.settings.value(LLM_ENRICHMENT_ENABLED_KEY);
}

function parseScopeMode(value: unknown): ScopeMode {
	return value === 'current' || value === 'selected' ? value : 'all';
}

function parseSelectedNotebookIds(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')
			? parsed
			: [];
	} catch {
		return [];
	}
}

export async function getScopeSettings(): Promise<ScopeSettings> {
	const values = await joplin.settings.values([SCOPE_MODE_KEY, SCOPE_SELECTED_NOTEBOOKS_KEY]);
	const mode = parseScopeMode(values[SCOPE_MODE_KEY]);
	const rawIds =
		typeof values[SCOPE_SELECTED_NOTEBOOKS_KEY] === 'string'
			? values[SCOPE_SELECTED_NOTEBOOKS_KEY]
			: '';
	const selectedNotebookIds = parseSelectedNotebookIds(rawIds);

	return { mode, selectedNotebookIds };
}

const THRESHOLD_MIN_PERCENT = 0;
const THRESHOLD_MAX_PERCENT = 100;
const TOP_K_MIN = 1;
const TOP_K_MAX = 20;

function sanitizeInRange(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value === 'boolean' || value === null || value === '') {
		return fallback;
	}
	const num = Number(value);
	if (!Number.isFinite(num)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, num));
}

/**
 * Joplin settings have no float/slider type, only Int — the threshold is
 * stored as a 0-100 percentage and converted here to the 0-1 scale
 * SimilarityEngine expects. Values are clamped defensively since Joplin's
 * `minimum`/`maximum` on a registered setting only constrains the settings-
 * screen spinner, not values arriving via other means (e.g. a direct
 * settings.json edit).
 */
export async function getSimilaritySettings(): Promise<{ threshold: number; topK: number }> {
	const values = await joplin.settings.values([SIMILARITY_THRESHOLD_KEY, MAX_EDGES_PER_NOTE_KEY]);
	const thresholdPercent = sanitizeInRange(
		values[SIMILARITY_THRESHOLD_KEY],
		THRESHOLD_MIN_PERCENT,
		THRESHOLD_MAX_PERCENT,
		Math.round(DEFAULT_THRESHOLD * 100)
	);
	const topK = sanitizeInRange(values[MAX_EDGES_PER_NOTE_KEY], TOP_K_MIN, TOP_K_MAX, TOP_K);

	return {
		threshold: thresholdPercent / 100,
		topK,
	};
}
