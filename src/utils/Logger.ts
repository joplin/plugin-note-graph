export interface Logger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

export const consoleLogger: Logger = {
	info: (message, ...args) => console.info(message, ...args),
	warn: (message, ...args) => console.warn(message, ...args),
	error: (message, ...args) => console.error(message, ...args),
};
