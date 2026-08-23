export const MAX_CATEGORY_LENGTH = 60;
export const MAX_RELATIONSHIP_LABEL_LENGTH = 80;
export const MIN_CENTRALITY_ADJUSTMENT = -2;
export const MAX_CENTRALITY_ADJUSTMENT = 2;

export interface NodeEnrichment {
	category?: string;
	centralityAdjustment?: number;
}

export interface EdgeEnrichment {
	relationshipLabel: string;
}

export interface ParsedEnrichment {
	nodes: Map<string, NodeEnrichment>;
	edges: Map<string, EdgeEnrichment>;
}

export function parseEnrichmentResponse(
	raw: string,
	knownNodeIds: ReadonlySet<string>,
	edgeIdByPair: ReadonlyMap<string, string>
): ParsedEnrichment | null {
	const parsed = safeParseJson(raw);
	if (!isRecord(parsed) || !Array.isArray(parsed.notes) || !Array.isArray(parsed.relationships)) {
		return null;
	}

	const nodes = new Map<string, NodeEnrichment>();
	for (const item of parsed.notes) {
		if (!isRecord(item) || typeof item.id !== 'string' || !knownNodeIds.has(item.id)) {
			continue;
		}

		const enrichment: NodeEnrichment = {};
		if (isNonEmptyString(item.category)) {
			enrichment.category = truncate(item.category.trim(), MAX_CATEGORY_LENGTH);
		}
		if (isValidCentralityAdjustment(item.centralityAdjustment)) {
			enrichment.centralityAdjustment = item.centralityAdjustment;
		}
		if (enrichment.category !== undefined || enrichment.centralityAdjustment !== undefined) {
			nodes.set(item.id, enrichment);
		}
	}

	const edges = new Map<string, EdgeEnrichment>();
	for (const item of parsed.relationships) {
		if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
			continue;
		}

		const edgeId = edgeIdByPair.get(pairKey(item.from, item.to));
		if (!edgeId || !isNonEmptyString(item.label)) {
			continue;
		}
		edges.set(edgeId, { relationshipLabel: truncate(item.label.trim(), MAX_RELATIONSHIP_LABEL_LENGTH) });
	}

	return { nodes, edges };
}

export function pairKey(a: string, b: string): string {
	return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength - 1).trimEnd() + '…' : value;
}

function isValidCentralityAdjustment(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= MIN_CENTRALITY_ADJUSTMENT &&
		value <= MAX_CENTRALITY_ADJUSTMENT
	);
}
