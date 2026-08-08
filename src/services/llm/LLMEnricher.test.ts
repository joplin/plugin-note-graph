import joplin from 'api';
import { LLMEnricher, LLMEnricherConfig, EnrichmentInput, EnrichmentEdgeInput } from './LLMEnricher';

function createEnricher(config: LLMEnricherConfig = {}): LLMEnricher {
	return new LLMEnricher(config);
}

type ChatPayload = {
	notes: Array<{ id: string; title: string; body: string }>;
	pairs: Array<{ from: string; to: string }>;
	existingCategories: string[];
};
type ChatMock = jest.Mock<Promise<string>, [Array<{ role: string; content: string }>, unknown?]>;

function getChatMock(): ChatMock {
	return (joplin.ai as unknown as { chat: ChatMock }).chat;
}

function readPayload(messages: Array<{ role: string; content: string }>): ChatPayload {
	return JSON.parse(messages[1].content) as ChatPayload;
}

function respondValid(messages: Array<{ role: string; content: string }>): string {
	const payload = readPayload(messages);
	return JSON.stringify({
		notes: payload.notes.map((n) => ({ id: n.id, category: `category-${n.id}` })),
		relationships: payload.pairs.map((p) => ({ from: p.from, to: p.to, label: `label-${p.from}-${p.to}` })),
	});
}

function nodes(...ids: string[]): EnrichmentInput['nodes'] {
	return new Map(ids.map((id) => [id, { title: `Title ${id}`, body: '', updatedTime: 1 }]));
}

function edge(source: string, target: string, updatedTime = 1): EnrichmentEdgeInput {
	return { id: `${source}::${target}::semantic`, source, target, updatedTime };
}

const NOT_STALE = () => false;

describe('LLMEnricher', () => {
	it('never calls joplin.ai when there are no edges to enrich', async () => {
		const enricher = createEnricher();

		const result = await enricher.enrich({ nodes: nodes('n1'), edges: [] }, NOT_STALE);

		expect(result.nodeEnrichments.size).toBe(0);
		expect(result.edgeEnrichments.size).toBe(0);
		expect(getChatMock()).not.toHaveBeenCalled();
	});

	it('enriches both notes and their relationship from one combined response', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));

		const result = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		expect(result.nodeEnrichments.get('n1')).toEqual({ category: 'category-n1' });
		expect(result.nodeEnrichments.get('n2')).toEqual({ category: 'category-n2' });
		expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
	});

	it('passes each note body through to the chat request unmodified', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const input: EnrichmentInput = {
			nodes: new Map([
				['n1', { title: 'Title n1', body: 'a real note body', updatedTime: 1 }],
				['n2', { title: 'Title n2', body: '', updatedTime: 1 }],
			]),
			edges: [edge('n1', 'n2')],
		};

		await enricher.enrich(input, NOT_STALE);

		const payload = readPayload(getChatMock().mock.calls[0][0]);
		expect(payload.notes.find((n) => n.id === 'n1')?.body).toBe('a real note body');
	});

	it('keeps the first edge when two edges in a batch share the same note pair, instead of losing both silently', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const duplicatePairEdge: EnrichmentEdgeInput = { id: 'n1::n2::link', source: 'n1', target: 'n2', updatedTime: 1 };

		const result = await enricher.enrich(
			{ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2'), duplicatePairEdge] },
			NOT_STALE
		);

		expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
		expect(result.edgeEnrichments.has('n1::n2::link')).toBe(false);
	});

	it('sends only one pair to the model when two edges share a note pair, even in reverse order', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const reversedPairEdge: EnrichmentEdgeInput = { id: 'n2::n1::link', source: 'n2', target: 'n1', updatedTime: 1 };

		await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2'), reversedPairEdge] }, NOT_STALE);

		const payload = readPayload(getChatMock().mock.calls[0][0]);
		expect(payload.pairs).toHaveLength(1);
	});

	it('keeps the first batch\'s category for a hub note that appears in a later batch too', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		let callCount = 0;
		getChatMock().mockImplementation(async (messages) => {
			callCount++;
			const payload = readPayload(messages);
			return JSON.stringify({
				notes: payload.notes.map((n) => ({ id: n.id, category: `run${callCount}-${n.id}` })),
				relationships: payload.pairs.map((p) => ({ from: p.from, to: p.to, label: `label-${p.from}-${p.to}` })),
			});
		});

		const input: EnrichmentInput = {
			nodes: nodes('hub', 'n1', 'n2'),
			edges: [edge('hub', 'n1'), edge('hub', 'n2')],
		};
		const result = await enricher.enrich(input, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(2);
		expect(result.nodeEnrichments.get('hub')).toEqual({ category: 'run1-hub' });
	});

	it('falls back silently when joplin.ai is unavailable', async () => {
		const enricher = createEnricher();
		const originalAi = joplin.ai;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(joplin as any).ai = undefined;

		try {
			const result = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);
			expect(result.edgeEnrichments.size).toBe(0);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(joplin as any).ai = originalAi;
		}
	});

	it('skips a batch that keeps throwing, leaving other batches unaffected', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1, maxAttemptsPerBatch: 1 });
		getChatMock().mockImplementation(async (messages) => {
			const payload = readPayload(messages);
			if (payload.pairs.some((p) => p.from === 'n0')) {
				throw new Error('network blip');
			}
			return respondValid(messages);
		});
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2', 'n3'),
			edges: [edge('n0', 'n1'), edge('n2', 'n3')],
		};
		const result = await enricher.enrich(input, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(2);
		expect(result.edgeEnrichments.has('n0::n1::semantic')).toBe(false);
		expect(result.edgeEnrichments.has('n2::n3::semantic')).toBe(true);
		expect(result.nodeEnrichments.has('n0')).toBe(false);
		expect(result.nodeEnrichments.has('n2')).toBe(true);
		errorSpy.mockRestore();
	});

	it('accepts a well-formed response that is missing a relationship as a partial result, without retrying', async () => {
		const enricher = createEnricher({ edgesPerBatch: 2, maxAttemptsPerBatch: 2 });
		const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
		getChatMock().mockImplementation(async (messages) => {
			const payload = readPayload(messages);
			const pairs = payload.pairs.slice(0, 1);
			return JSON.stringify({
				notes: [],
				relationships: pairs.map((p) => ({ from: p.from, to: p.to, label: `label-${p.from}-${p.to}` })),
			});
		});

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2'),
			edges: [edge('n0', 'n1'), edge('n0', 'n2')],
		};
		const result = await enricher.enrich(input, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(result.edgeEnrichments.get('n0::n1::semantic')).toEqual({ relationshipLabel: 'label-n0-n1' });
		expect(result.edgeEnrichments.has('n0::n2::semantic')).toBe(false);
		infoSpy.mockRestore();
	});

	it('includes categories assigned by an earlier batch as existingCategories for later batches in the same run', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		const payloadsSeen: ChatPayload[] = [];
		getChatMock().mockImplementation(async (messages) => {
			payloadsSeen.push(readPayload(messages));
			return respondValid(messages);
		});

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2', 'n3'),
			edges: [edge('n0', 'n1'), edge('n2', 'n3')],
		};
		await enricher.enrich(input, NOT_STALE);

		expect(payloadsSeen[0].existingCategories).toEqual([]);
		expect(payloadsSeen[1].existingCategories).toEqual(
			expect.arrayContaining(['category-n0', 'category-n1'])
		);
	});

	it('seeds existingCategories from categories already cached from a previous run', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		let secondRunPayload: ChatPayload | undefined;
		getChatMock().mockImplementation(async (messages) => {
			secondRunPayload = readPayload(messages);
			return respondValid(messages);
		});
		await enricher.enrich(
			{ nodes: nodes('n1', 'n2', 'n3', 'n4'), edges: [edge('n1', 'n2'), edge('n3', 'n4')] },
			NOT_STALE
		);

		expect(secondRunPayload?.existingCategories).toEqual(
			expect.arrayContaining(['category-n1', 'category-n2'])
		);
	});

	it('surfaces a category cached for a note outside the current run\'s scope, as happens on an incremental update', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		let secondRunPayload: ChatPayload | undefined;
		getChatMock().mockImplementation(async (messages) => {
			secondRunPayload = readPayload(messages);
			return respondValid(messages);
		});
		await enricher.enrich({ nodes: nodes('n3', 'n4'), edges: [edge('n3', 'n4')] }, NOT_STALE);

		expect(secondRunPayload?.existingCategories).toEqual(
			expect.arrayContaining(['category-n1', 'category-n2'])
		);
	});

	it('caps existingCategories at the most recently cached labels once the vault has accumulated more than that', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const noteIds = Array.from({ length: 42 }, (_, i) => `a${i}`);
		const seedEdges = [];
		for (let i = 0; i < noteIds.length; i += 2) {
			seedEdges.push(edge(noteIds[i], noteIds[i + 1]));
		}
		await enricher.enrich({ nodes: nodes(...noteIds), edges: seedEdges }, NOT_STALE);

		let secondRunPayload: ChatPayload | undefined;
		getChatMock().mockImplementation(async (messages) => {
			secondRunPayload = readPayload(messages);
			return respondValid(messages);
		});
		await enricher.enrich({ nodes: nodes('b0', 'b1'), edges: [edge('b0', 'b1')] }, NOT_STALE);

		expect(secondRunPayload?.existingCategories).toHaveLength(40);
		expect(secondRunPayload?.existingCategories).not.toContain('category-a0');
		expect(secondRunPayload?.existingCategories).toContain('category-a41');
	});

	it('reports progress immediately at 0, then once per batch, in order, with the correct total', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const onProgress = jest.fn();

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2', 'n3'),
			edges: [edge('n0', 'n1'), edge('n2', 'n3')],
		};
		await enricher.enrich(input, NOT_STALE, onProgress);

		expect(onProgress).toHaveBeenCalledTimes(3);
		expect(onProgress).toHaveBeenNthCalledWith(1, { current: 0, total: 2 });
		expect(onProgress).toHaveBeenNthCalledWith(2, { current: 1, total: 2 });
		expect(onProgress).toHaveBeenNthCalledWith(3, { current: 2, total: 2 });
	});

	it('does not report progress for a batch skipped because the run went stale', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const onProgress = jest.fn();
		let staleCheckCount = 0;
		const isStale = () => {
			staleCheckCount++;
			return staleCheckCount > 1;
		};

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2', 'n3'),
			edges: [edge('n0', 'n1'), edge('n2', 'n3')],
		};
		await enricher.enrich(input, isStale, onProgress);

		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenNthCalledWith(1, { current: 0, total: 2 });
		expect(onProgress).toHaveBeenNthCalledWith(2, { current: 1, total: 2 });
	});

	it('unwraps a { text: string } chat() response, the real runtime shape behind the documented Promise<string>', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => ({ text: respondValid(messages) } as unknown as string));

		const result = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
	});

	it('treats a chat() response with no usable text as unrecognized', async () => {
		const enricher = createEnricher({ maxAttemptsPerBatch: 1 });
		getChatMock().mockResolvedValue({ unexpected: true } as unknown as string);
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(result.edgeEnrichments.size).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unrecognized response shape'));

		errorSpy.mockRestore();
	});

	it('treats an empty or whitespace-only response as no result for that batch', async () => {
		const enricher = createEnricher({ maxAttemptsPerBatch: 1 });
		getChatMock().mockResolvedValue('   \n  ');
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

		const result = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(result.edgeEnrichments.size).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('empty response'));

		errorSpy.mockRestore();
	});

	describe('retry on failure', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('retries once after chat() throws, and succeeds if the retry works', async () => {
			const enricher = createEnricher();
			let calls = 0;
			getChatMock().mockImplementation(async (messages) => {
				calls++;
				if (calls === 1) throw new Error('network blip');
				return respondValid(messages);
			});
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);
			await jest.advanceTimersByTimeAsync(0);
			expect(getChatMock()).toHaveBeenCalledTimes(1);

			await jest.advanceTimersByTimeAsync(1000);
			const result = await resultPromise;

			expect(getChatMock()).toHaveBeenCalledTimes(2);
			expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
			errorSpy.mockRestore();
		});

		it('gives up after exhausting every attempt when chat() keeps throwing', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async () => {
				throw new Error('network blip');
			});
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);
			await jest.advanceTimersByTimeAsync(3000);
			const result = await resultPromise;

			expect(getChatMock()).toHaveBeenCalledTimes(4);
			expect(result.edgeEnrichments.size).toBe(0);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('giving up for this run'), expect.anything());
			errorSpy.mockRestore();
		});

		it('gives up on a batch whose response stays malformed across every attempt', async () => {
			const enricher = createEnricher();
			getChatMock().mockResolvedValue('not valid json');
			const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

			const resultPromise = enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);
			await jest.advanceTimersByTimeAsync(3000);
			const result = await resultPromise;

			expect(getChatMock()).toHaveBeenCalledTimes(4);
			expect(result.edgeEnrichments.size).toBe(0);
			errorSpy.mockRestore();
		});

		it('does not retry a batch once the run has gone stale', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async () => {
				throw new Error('network blip');
			});
			let staleCheckCount = 0;
			const isStale = () => {
				staleCheckCount++;
				return staleCheckCount > 1;
			};

			const resultPromise = enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, isStale);
			await jest.advanceTimersByTimeAsync(1000);
			const result = await resultPromise;

			expect(getChatMock()).toHaveBeenCalledTimes(1);
			expect(result.edgeEnrichments.size).toBe(0);
		});
	});

	it('calls chat() with no options, leaving temperature and max tokens up to the provider default', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));

		await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] }, NOT_STALE);

		expect(getChatMock().mock.calls[0][1]).toBeUndefined();
	});

	it('stops issuing chat() calls once isStale() reports true between batches, keeping the already-merged batch', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		getChatMock().mockImplementation(async (messages) => respondValid(messages));

		let staleCheckCount = 0;
		const isStale = () => {
			staleCheckCount++;
			return staleCheckCount > 1;
		};

		const input: EnrichmentInput = {
			nodes: nodes('n0', 'n1', 'n2', 'n3'),
			edges: [edge('n0', 'n1'), edge('n2', 'n3')],
		};
		const result = await enricher.enrich(input, isStale);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(result.edgeEnrichments.has('n0::n1::semantic')).toBe(true);
		expect(result.edgeEnrichments.has('n2::n3::semantic')).toBe(false);
	});

	it('skips chat() entirely on a cache hit (same edge id + updatedTime as a prior enrich() call)', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));

		const input: EnrichmentInput = { nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] };
		const first = await enricher.enrich(input, NOT_STALE);
		expect(first.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
		expect(getChatMock()).toHaveBeenCalledTimes(1);

		const second = await enricher.enrich(input, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(second.nodeEnrichments.get('n1')).toEqual({ category: 'category-n1' });
		expect(second.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
	});

	it('does not carry a cached centralityAdjustment into a later run, since it only means something for the batch it came from', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => {
			const payload = readPayload(messages);
			return JSON.stringify({
				notes: payload.notes.map((n) => ({ id: n.id, category: `category-${n.id}`, centralityAdjustment: 2 })),
				relationships: payload.pairs.map((p) => ({ from: p.from, to: p.to, label: `label-${p.from}-${p.to}` })),
			});
		});

		const input: EnrichmentInput = { nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] };
		const first = await enricher.enrich(input, NOT_STALE);
		expect(first.nodeEnrichments.get('n1')).toEqual({ category: 'category-n1', centralityAdjustment: 2 });

		const second = await enricher.enrich(input, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(1);
		expect(second.nodeEnrichments.get('n1')).toEqual({ category: 'category-n1' });
	});

	it('treats a changed edge updatedTime as a cache miss and re-enriches', async () => {
		const enricher = createEnricher();
		getChatMock().mockImplementation(async (messages) => respondValid(messages));

		await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] }, NOT_STALE);
		expect(getChatMock()).toHaveBeenCalledTimes(1);

		const second = await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 200)] }, NOT_STALE);

		expect(getChatMock()).toHaveBeenCalledTimes(2);
		expect(second.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
	});

	describe('clearCache', () => {
		it('makes a previously cached edge a cache miss again, re-querying chat()', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async (messages) => respondValid(messages));
			const input: EnrichmentInput = { nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] };
			await enricher.enrich(input, NOT_STALE);
			expect(getChatMock()).toHaveBeenCalledTimes(1);

			enricher.clearCache();
			const result = await enricher.enrich(input, NOT_STALE);

			expect(getChatMock()).toHaveBeenCalledTimes(2);
			expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
		});
	});

	describe('seedCache', () => {
		it('treats a seeded node/edge as a cache hit, skipping chat() for it', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async (messages) => respondValid(messages));

			enricher.seedCache(
				[{ id: 'n1', updatedTime: 1, enrichment: { category: 'seeded-category' } }],
				[{ id: 'n1::n2::semantic', updatedTime: 100, enrichment: { relationshipLabel: 'seeded-label' } }]
			);

			const result = await enricher.enrich(
				{ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] },
				NOT_STALE
			);

			expect(getChatMock()).not.toHaveBeenCalled();
			expect(result.nodeEnrichments.get('n1')).toEqual({ category: 'seeded-category' });
			expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'seeded-label' });
		});

		it('ignores a seed whose updatedTime does not match the current note/edge', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async (messages) => respondValid(messages));

			enricher.seedCache(
				[],
				[{ id: 'n1::n2::semantic', updatedTime: 50, enrichment: { relationshipLabel: 'stale-seed' } }]
			);

			const result = await enricher.enrich(
				{ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] },
				NOT_STALE
			);

			expect(getChatMock()).toHaveBeenCalledTimes(1);
			expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
		});

		it('does not let a seed overwrite a label this instance already produced itself', async () => {
			const enricher = createEnricher();
			getChatMock().mockImplementation(async (messages) => respondValid(messages));
			await enricher.enrich({ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] }, NOT_STALE);

			enricher.seedCache(
				[],
				[{ id: 'n1::n2::semantic', updatedTime: 100, enrichment: { relationshipLabel: 'stale-seed' } }]
			);

			const result = await enricher.enrich(
				{ nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2', 100)] },
				NOT_STALE
			);

			expect(getChatMock()).toHaveBeenCalledTimes(1);
			expect(result.edgeEnrichments.get('n1::n2::semantic')).toEqual({ relationshipLabel: 'label-n1-n2' });
		});
	});

	it('never throws when the nodes map fails to iterate', async () => {
		const enricher = createEnricher();
		const poisonedNodes = {
			[Symbol.iterator]: () => {
				throw new Error('nodes iteration failed');
			},
		} as unknown as EnrichmentInput['nodes'];

		await expect(enricher.enrich({ nodes: poisonedNodes, edges: [] }, NOT_STALE)).resolves.toEqual({
			nodeEnrichments: new Map(),
			edgeEnrichments: new Map(),
		});
	});

	it('never throws when the edges array fails to iterate', async () => {
		const enricher = createEnricher();
		const poisonedEdges = {
			[Symbol.iterator]: () => {
				throw new Error('edges iteration failed');
			},
		} as unknown as EnrichmentEdgeInput[];

		await expect(enricher.enrich({ nodes: nodes('n1'), edges: poisonedEdges }, NOT_STALE)).resolves.toEqual({
			nodeEnrichments: new Map(),
			edgeEnrichments: new Map(),
		});
	});

	it('never throws when isStale() itself throws mid-run', async () => {
		const enricher = createEnricher({ edgesPerBatch: 1 });
		getChatMock().mockImplementation(async (messages) => respondValid(messages));
		const isStale = () => {
			throw new Error('unexpected staleness-check failure');
		};

		const input: EnrichmentInput = { nodes: nodes('n1', 'n2'), edges: [edge('n1', 'n2')] };

		await expect(enricher.enrich(input, isStale)).resolves.toEqual({
			nodeEnrichments: new Map(),
			edgeEnrichments: new Map(),
		});
	});
});
