/** Only a direct link bypasses this floor — tags alone can never create an edge below it. */
export const SEMANTIC_FLOOR = 0.3;

export const DEFAULT_THRESHOLD = 0.7;

export const TOP_K = 5;

/** Vault size above which joplin.ai.search() is used instead of O(n²) cosine. */
export const LARGE_VAULT_THRESHOLD = 300;

/** Scaled by Jaccard tag overlap between two notes. */
export const TAG_BONUS = 0.1;

/** Smaller than TAG_BONUS on purpose — a link already renders its own edge via EdgeFactory, so this only affects redundant semantic edges. */
export const LINK_BONUS = 0.05;

/** Tags on more than this fraction of notes (e.g. "inbox") are excluded as organizational noise. */
export const ORGANIZATIONAL_TAG_RATIO = 0.3;

/** Score boost when two notes were created within a day of each other. */
export const TEMPORAL_BONUS_1_DAY = 0.1;

/** Score boost when two notes were created within a week of each other. */
export const TEMPORAL_BONUS_7_DAYS = 0.05;

export const MS_PER_DAY = 1000 * 60 * 60 * 24;
