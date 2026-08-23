import { parseEnrichmentResponse } from './ResponseParser';

const knownNodeIds = new Set(['n1', 'n2']);
const edgeIdByPair = new Map([['n1::n2', 'n1::n2::semantic']]);

describe('parseEnrichmentResponse', () => {
	it('parses a fully valid combined response', () => {
		const raw = JSON.stringify({
			notes: [
				{ id: 'n1', category: 'Gardening', centralityAdjustment: 2 },
				{ id: 'n2', category: 'Cooking', centralityAdjustment: -1 },
			],
			relationships: [{ from: 'n1', to: 'n2', label: 'inspired by' }],
		});

		const result = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair);

		expect(result?.nodes).toEqual(
			new Map([
				['n1', { category: 'Gardening', centralityAdjustment: 2 }],
				['n2', { category: 'Cooking', centralityAdjustment: -1 }],
			])
		);
		expect(result?.edges).toEqual(new Map([['n1::n2::semantic', { relationshipLabel: 'inspired by' }]]));
	});

	it('matches a relationship pair regardless of from/to order', () => {
		const raw = JSON.stringify({
			notes: [],
			relationships: [{ from: 'n2', to: 'n1', label: 'inspired by' }],
		});

		const result = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair);

		expect(result?.edges).toEqual(new Map([['n1::n2::semantic', { relationshipLabel: 'inspired by' }]]));
	});

	it('returns null for unparsable JSON', () => {
		expect(parseEnrichmentResponse('not json at all', knownNodeIds, edgeIdByPair)).toBeNull();
	});

	it('returns null when the relationships array is missing', () => {
		const raw = JSON.stringify({ notes: [] });
		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)).toBeNull();
	});

	it('returns null when the notes array is missing', () => {
		const raw = JSON.stringify({ relationships: [] });
		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)).toBeNull();
	});

	it('drops a note item with an unknown id but keeps the others', () => {
		const raw = JSON.stringify({
			notes: [
				{ id: 'n1', category: 'Gardening' },
				{ id: 'hallucinated', category: 'Nope' },
			],
			relationships: [],
		});

		const result = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair);

		expect(result?.nodes).toEqual(new Map([['n1', { category: 'Gardening' }]]));
	});

	it('drops a relationship whose pair was not asked about', () => {
		const raw = JSON.stringify({
			notes: [],
			relationships: [{ from: 'n1', to: 'unknown-note', label: 'related to' }],
		});

		const result = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair);

		expect(result?.edges.size).toBe(0);
	});

	it('drops only the out-of-range centralityAdjustment field, keeping a valid category', () => {
		const raw = JSON.stringify({
			notes: [{ id: 'n1', category: 'Gardening', centralityAdjustment: 5 }],
			relationships: [],
		});

		const result = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair);

		expect(result?.nodes).toEqual(new Map([['n1', { category: 'Gardening' }]]));
	});

	it('truncates an oversized relationship label instead of dropping it', () => {
		const raw = JSON.stringify({
			notes: [],
			relationships: [{ from: 'n1', to: 'n2', label: 'x'.repeat(81) }],
		});

		const label = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.edges.get('n1::n2::semantic')
			?.relationshipLabel;
		expect(label).toHaveLength(80);
		expect(label).toBe('x'.repeat(79) + '…');
	});

	it('drops a centralityAdjustment below the minimum', () => {
		const raw = JSON.stringify({
			notes: [{ id: 'n1', category: 'Gardening', centralityAdjustment: -5 }],
			relationships: [],
		});

		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.nodes).toEqual(
			new Map([['n1', { category: 'Gardening' }]])
		);
	});

	it('drops a non-integer centralityAdjustment', () => {
		const raw = JSON.stringify({
			notes: [{ id: 'n1', category: 'Gardening', centralityAdjustment: 1.5 }],
			relationships: [],
		});

		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.nodes).toEqual(
			new Map([['n1', { category: 'Gardening' }]])
		);
	});

	it('truncates an oversized category instead of dropping it', () => {
		const raw = JSON.stringify({
			notes: [{ id: 'n1', category: 'x'.repeat(61), centralityAdjustment: 1 }],
			relationships: [],
		});

		const category = parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.nodes.get('n1')?.category;
		expect(category).toHaveLength(60);
		expect(category).toBe('x'.repeat(59) + '…');
	});

	it('drops an empty or whitespace-only category', () => {
		const raw = JSON.stringify({
			notes: [{ id: 'n1', category: '   ', centralityAdjustment: 1 }],
			relationships: [],
		});

		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.nodes).toEqual(
			new Map([['n1', { centralityAdjustment: 1 }]])
		);
	});

	it('drops an empty or whitespace-only relationship label', () => {
		const raw = JSON.stringify({
			notes: [],
			relationships: [{ from: 'n1', to: 'n2', label: '   ' }],
		});

		expect(parseEnrichmentResponse(raw, knownNodeIds, edgeIdByPair)?.edges.size).toBe(0);
	});
});
