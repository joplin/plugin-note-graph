import { RecordingLogger } from './RecordingLogger';

describe('RecordingLogger', () => {
	const createInner = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

	it('passes every message on unchanged', () => {
		const inner = createInner();
		const logger = new RecordingLogger(inner);
		const error = new Error('boom');

		logger.info('loaded', 3);
		logger.warn('slow');
		logger.error('failed:', error);

		expect(inner.info).toHaveBeenCalledWith('loaded', 3);
		expect(inner.warn).toHaveBeenCalledWith('slow');
		expect(inner.error).toHaveBeenCalledWith('failed:', error);
	});

	it('keeps warnings and errors, newest first, but not information', () => {
		let time = 100;
		const logger = new RecordingLogger(createInner(), () => time++);

		logger.info('loaded');
		logger.warn('slow');
		logger.error('failed:', new Error('boom'), { noteId: 'a' });

		expect(logger.recentProblems()).toEqual([
			{ time: 101, level: 'error', text: 'failed: boom {"noteId":"a"}', count: 1 },
			{ time: 100, level: 'warn', text: 'slow', count: 1 },
		]);
	});

	it('keeps only the latest twenty', () => {
		const logger = new RecordingLogger(createInner());
		const letters = 'abcdefghijklmnopqrstuvwxy';

		for (const letter of letters) logger.error(`problem ${letter}`);

		const problems = logger.recentProblems();
		expect(problems).toHaveLength(20);
		expect(problems[0].text).toBe('problem y');
		expect(problems[19].text).toBe('problem f');
	});

	it('shows a problem that repeats with different numbers once, with a count and the latest wording', () => {
		let time = 0;
		const logger = new RecordingLogger(createInner(), () => ++time);

		logger.error('chat() call failed on attempt 1/4 for batch 1/50');
		logger.error('chat() call failed on attempt 2/4 for batch 1/50');
		logger.error('chat() call failed on attempt 1/4 for batch 2/50');
		logger.warn('chat() call failed on attempt 1/4 for batch 3/50');

		expect(logger.recentProblems()).toEqual([
			{
				time: 4,
				level: 'warn',
				text: 'chat() call failed on attempt 1/4 for batch 3/50',
				count: 1,
			},
			{
				time: 3,
				level: 'error',
				text: 'chat() call failed on attempt 1/4 for batch 2/50',
				count: 3,
			},
		]);
	});

	it('keeps alternating repeats, such as retries and giving up, to one line each', () => {
		const logger = new RecordingLogger(createInner());

		for (let batch = 1; batch <= 50; batch++) {
			for (let attempt = 1; attempt < 4; attempt++) {
				logger.error(`batch ${batch}/50 failed on attempt ${attempt}/4; retrying.`);
			}
			logger.error(`batch ${batch}/50 failed on attempt 4/4; giving up for this run.`);
		}

		expect(logger.recentProblems().map(({ text, count }) => ({ text, count }))).toEqual([
			{ text: 'batch 50/50 failed on attempt 4/4; giving up for this run.', count: 50 },
			{ text: 'batch 50/50 failed on attempt 3/4; retrying.', count: 150 },
		]);
	});

	it('shortens very long messages', () => {
		const logger = new RecordingLogger(createInner());

		logger.error('x'.repeat(1000));

		expect(logger.recentProblems()[0].text).toHaveLength(300);
	});

	it('forgets what it kept when cleared', () => {
		const logger = new RecordingLogger(createInner());
		logger.error('failed');

		logger.clearProblems();

		expect(logger.recentProblems()).toEqual([]);
	});
});
