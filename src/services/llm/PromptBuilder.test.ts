import { buildBatchPrompt, MAX_BODY_EXCERPT_LENGTH } from './PromptBuilder';

describe('buildBatchPrompt', () => {
	it('sends a system message and a JSON user payload with notes, pairs and existing categories', () => {
		const messages = buildBatchPrompt(
			[{ id: 'n1', title: 'Gardening tips', body: 'Watering advice' }],
			[{ from: 'n1', to: 'n2' }],
			['Gardening']
		);

		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe('system');
		expect(messages[1].role).toBe('user');

		const payload = JSON.parse(messages[1].content);
		expect(payload).toEqual({
			notes: [{ id: 'n1', title: 'Gardening tips', body: 'Watering advice' }],
			pairs: [{ from: 'n1', to: 'n2' }],
			existingCategories: ['Gardening'],
		});
	});

	it('truncates a note body to MAX_BODY_EXCERPT_LENGTH', () => {
		const longBody = 'x'.repeat(MAX_BODY_EXCERPT_LENGTH + 100);

		const messages = buildBatchPrompt([{ id: 'n1', title: 'A', body: longBody }], [], []);

		const payload = JSON.parse(messages[1].content);
		expect(payload.notes[0].body).toBe(longBody.slice(0, MAX_BODY_EXCERPT_LENGTH));
		expect(payload.notes[0].body.length).toBe(MAX_BODY_EXCERPT_LENGTH);
	});
});
