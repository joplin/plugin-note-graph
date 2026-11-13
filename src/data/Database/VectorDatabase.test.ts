import joplin from 'api';
import { VectorDatabase } from './VectorDatabase';

interface FakeDatabaseState {
	statements: string[];
}

function installFakeSqlite(state: FakeDatabaseState, options: { asyncRun?: boolean } = {}): void {
	class FakeDatabase {
		public constructor(_path: string, callback: (err: Error | null) => void) {
			setTimeout(() => callback(null), 0);
		}

		public run(sql: string, _params: unknown[], callback: (err: Error | null) => void): void {
			const execute = (): void => {
				state.statements.push(sql);
				callback(null);
			};
			if (options.asyncRun) setTimeout(execute, 5);
			else execute();
		}

		public all(
			_sql: string,
			_params: unknown[],
			callback: (err: Error | null, rows: unknown[]) => void
		): void {
			callback(null, []);
		}

		public close(): void {}
	}

	(joplin as unknown as { require: jest.Mock }).require = jest.fn(() => ({
		Database: FakeDatabase,
	}));
	(joplin as unknown as { plugins: { dataDir: jest.Mock } }).plugins = {
		dataDir: jest.fn().mockResolvedValue('/data'),
	};
}

describe('VectorDatabase', () => {
	it('sets a busy timeout, so concurrent writes wait instead of failing', async () => {
		const state: FakeDatabaseState = { statements: [] };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', []).open();

		expect(state.statements.some((sql) => sql.startsWith('PRAGMA busy_timeout'))).toBe(true);
	});

	it('makes a second caller wait until the schema is in place', async () => {
		const state: FakeDatabaseState = { statements: [] };
		installFakeSqlite(state, { asyncRun: true });
		const db = new VectorDatabase('test.sqlite', ['CREATE A']);

		const first = db.open();
		await new Promise((resolve) => setTimeout(resolve, 2));
		await db.open();

		expect(state.statements).toContain('CREATE A');
		await first;
	});

	it('opens only once however many times it is asked', async () => {
		const state: FakeDatabaseState = { statements: [] };
		installFakeSqlite(state);
		const db = new VectorDatabase('test.sqlite', ['CREATE A']);

		await Promise.all([db.open(), db.open()]);
		await db.open();

		expect(state.statements.filter((sql) => sql === 'CREATE A')).toHaveLength(1);
	});
});
