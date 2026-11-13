import { BackgroundLabeler, MAX_IDLE_ROUNDS } from './BackgroundLabeler';

const PAUSE_MS = 1000;

describe('BackgroundLabeler', () => {
	let unlabeled: number;
	let labeledPerRound: number;
	let enabled: boolean;
	let labelRound: jest.Mock;
	let labeler: BackgroundLabeler;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.spyOn(console, 'info').mockImplementation(() => undefined);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
		unlabeled = 500;
		labeledPerRound = 200;
		enabled = true;
		labelRound = jest.fn(async () => {
			unlabeled = Math.max(0, unlabeled - labeledPerRound);
		});
		labeler = new BackgroundLabeler({
			isEnabled: async () => enabled,
			countUnlabeled: () => unlabeled,
			labelRound,
			pauseMs: PAUSE_MS,
		});
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('waits for the pause before the first round', async () => {
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS - 1);
		expect(labelRound).not.toHaveBeenCalled();

		await jest.advanceTimersByTimeAsync(1);
		expect(labelRound).toHaveBeenCalledTimes(1);
	});

	it('keeps going, one round per pause, until every connection has a label', async () => {
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 10);

		expect(labelRound).toHaveBeenCalledTimes(3);
		expect(unlabeled).toBe(0);
	});

	it('does nothing when every connection already has a label', async () => {
		unlabeled = 0;
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 5);

		expect(labelRound).not.toHaveBeenCalled();
	});

	it('does nothing while labels are turned off', async () => {
		enabled = false;
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 5);

		expect(labelRound).not.toHaveBeenCalled();
	});

	it('only keeps one round due at a time', async () => {
		labeler.schedule();
		labeler.schedule();
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS);

		expect(labelRound).toHaveBeenCalledTimes(1);
	});

	it('doubles the pause after a round that labels nothing', async () => {
		labeledPerRound = 0;
		labeler.schedule();
		await jest.advanceTimersByTimeAsync(PAUSE_MS);
		expect(labelRound).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 2 - 1);
		expect(labelRound).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(1);
		expect(labelRound).toHaveBeenCalledTimes(2);
	});

	it(`stops after ${MAX_IDLE_ROUNDS} rounds in a row that label nothing`, async () => {
		labeledPerRound = 0;
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 100);

		expect(labelRound).toHaveBeenCalledTimes(MAX_IDLE_ROUNDS);
	});

	it('treats a failed round like one that labeled nothing', async () => {
		labelRound.mockRejectedValue(new Error('provider down'));
		labeler.schedule();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 100);

		expect(labelRound).toHaveBeenCalledTimes(MAX_IDLE_ROUNDS);
	});

	it('does not run a round that was due when it was stopped', async () => {
		labeler.schedule();
		labeler.stop();

		await jest.advanceTimersByTimeAsync(PAUSE_MS * 5);

		expect(labelRound).not.toHaveBeenCalled();
	});

	it('ignores scheduling while stopped, and carries on once resumed', async () => {
		labeler.stop();
		labeler.schedule();
		await jest.advanceTimersByTimeAsync(PAUSE_MS * 5);
		expect(labelRound).not.toHaveBeenCalled();

		labeler.resume();
		await jest.advanceTimersByTimeAsync(PAUSE_MS);

		expect(labelRound).toHaveBeenCalledTimes(1);
	});

	it('starts afresh when resumed after it gave up', async () => {
		labeledPerRound = 0;
		labeler.schedule();
		await jest.advanceTimersByTimeAsync(PAUSE_MS * 100);
		labeledPerRound = 200;

		labeler.resume();
		await jest.advanceTimersByTimeAsync(PAUSE_MS);

		expect(labelRound).toHaveBeenCalledTimes(MAX_IDLE_ROUNDS + 1);
	});
});
