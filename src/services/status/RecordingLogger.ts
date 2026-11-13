import { Logger, consoleLogger } from '../../utils/Logger';

const MAX_ENTRIES = 20;
const MAX_TEXT_LENGTH = 300;

export interface LoggedProblem {
	time: number;
	level: 'warn' | 'error';
	text: string;
	/** How many times this happened while it was in the list, counting messages that differ only in their numbers. */
	count: number;
}

const sameProblem = (a: string, b: string): boolean =>
	a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');

function describe(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Passes everything on, and keeps the latest warnings and errors so the panel can show what went wrong. */
export class RecordingLogger implements Logger {
	private readonly problems: LoggedProblem[] = [];

	public constructor(
		private readonly inner: Logger = consoleLogger,
		private readonly now: () => number = Date.now
	) {}

	public info(message: string, ...args: unknown[]): void {
		this.inner.info(message, ...args);
	}

	public warn(message: string, ...args: unknown[]): void {
		this.inner.warn(message, ...args);
		this.record('warn', message, args);
	}

	public error(message: string, ...args: unknown[]): void {
		this.inner.error(message, ...args);
		this.record('error', message, args);
	}

	/** Newest first. */
	public recentProblems(): LoggedProblem[] {
		return [...this.problems].reverse();
	}

	public clearProblems(): void {
		this.problems.length = 0;
	}

	private record(level: LoggedProblem['level'], message: string, args: unknown[]): void {
		const details = args.map(describe).filter((text) => text.length > 0);
		const text = [message, ...details].join(' ').slice(0, MAX_TEXT_LENGTH);
		const earlier = this.problems.findIndex(
			(problem) => problem.level === level && sameProblem(problem.text, text)
		);
		const count = earlier === -1 ? 1 : this.problems.splice(earlier, 1)[0].count + 1;
		this.problems.push({ time: this.now(), level, text, count });
		if (this.problems.length > MAX_ENTRIES) this.problems.shift();
	}
}
