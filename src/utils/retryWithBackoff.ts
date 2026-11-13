import { Logger, consoleLogger } from './Logger';

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	logger?: Logger;
}

/** Retry policy for Joplin data API reads, where a failure is usually transient. */
export const DATA_API_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 500 };

export async function retryWithBackoff<T>(
	label: string,
	fn: () => Promise<T>,
	options: RetryOptions
): Promise<T> {
	const logger = options.logger ?? consoleLogger;
	let lastError: unknown;

	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		if (attempt > 1) {
			await delay(options.baseDelayMs * 2 ** (attempt - 2));
		}

		try {
			return await fn();
		} catch (e) {
			lastError = e;
			const willRetry = attempt < options.maxAttempts;
			logger.error(
				`${label} failed on attempt ${attempt}/${options.maxAttempts}${
					willRetry ? '; retrying.' : '; giving up.'
				}`,
				e
			);
		}
	}

	throw lastError;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
