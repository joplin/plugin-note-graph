import { retryWithBackoff } from './retryWithBackoff';

const NO_DELAY = { maxAttempts: 3, baseDelayMs: 0 };

describe('retryWithBackoff', () => {
	let consoleErrorSpy: jest.SpyInstance;

	beforeEach(() => {
		consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it('returns the first successful result without retrying', async () => {
		const fn = jest.fn().mockResolvedValue('ok');

		await expect(retryWithBackoff('op', fn, NO_DELAY)).resolves.toBe('ok');

		expect(fn).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).not.toHaveBeenCalled();
	});

	it('retries until an attempt succeeds', async () => {
		const fn = jest.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok');

		await expect(retryWithBackoff('op', fn, NO_DELAY)).resolves.toBe('ok');

		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('throws the last error once attempts are exhausted', async () => {
		const fn = jest
			.fn()
			.mockRejectedValueOnce(new Error('first'))
			.mockRejectedValueOnce(new Error('second'))
			.mockRejectedValueOnce(new Error('third'));

		await expect(retryWithBackoff('op', fn, NO_DELAY)).rejects.toThrow('third');

		expect(fn).toHaveBeenCalledTimes(3);
	});
});
