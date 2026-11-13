import joplin from 'api';
import { VectorDatabase } from './VectorDatabase';

interface FakeDatabaseState {
	statements: string[];
	userVersion: number;
	failOn?: string;
}

function installFakeSqlite(state: FakeDatabaseState, options: { asyncRun?: boolean } = {}): void {
	class FakeDatabase {
		public constructor(_path: string, callback: (err: Error | null) => void) {
			setTimeout(() => callback(null), 0);
		}

		public run(sql: string, _params: unknown[], callback: (err: Error | null) => void): void {
			const execute = (): void => {
				if (state.failOn && sql.includes(state.failOn)) {
					callback(new Error('statement failed'));
					return;
				}
				state.statements.push(sql);
				const versionMatch = /PRAGMA user_version = (\d+)/.exec(sql);
				if (versionMatch) state.userVersion = Number(versionMatch[1]);
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
			callback(null, [{ user_version: state.userVersion }]);
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
	it('creates the schema and applies every migration on a new database', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0 };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', ['CREATE A'], ['MIGRATE 1', 'MIGRATE 2']).open();

		expect(state.statements).toContain('CREATE A');
		expect(state.statements).toContain('MIGRATE 1');
		expect(state.statements).toContain('MIGRATE 2');
		expect(state.userVersion).toBe(2);
	});

	it('applies only the migrations a database has not had yet', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 1 };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', [], ['MIGRATE 1', 'MIGRATE 2']).open();

		expect(state.statements).not.toContain('MIGRATE 1');
		expect(state.statements).toContain('MIGRATE 2');
		expect(state.userVersion).toBe(2);
	});

	it('does nothing on an up-to-date database', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 2 };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', [], ['MIGRATE 1', 'MIGRATE 2']).open();

		expect(state.statements).not.toContain('MIGRATE 1');
		expect(state.statements).not.toContain('MIGRATE 2');
	});

	it('does not record a migration that failed, so it runs again next time', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0, failOn: 'MIGRATE 1' };
		installFakeSqlite(state);

		await expect(new VectorDatabase('test.sqlite', [], ['MIGRATE 1']).open()).rejects.toThrow(
			'statement failed'
		);

		expect(state.userVersion).toBe(0);
	});

	it('sets a busy timeout, so concurrent writes wait instead of failing', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0 };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', []).open();

		expect(state.statements.some((sql) => sql.startsWith('PRAGMA busy_timeout'))).toBe(true);
	});

	it('applies each migration and its version bump in one transaction', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0 };
		installFakeSqlite(state);

		await new VectorDatabase('test.sqlite', [], ['MIGRATE 1']).open();

		const start = state.statements.indexOf('BEGIN TRANSACTION');
		expect(state.statements.slice(start, start + 4)).toEqual([
			'BEGIN TRANSACTION',
			'MIGRATE 1',
			'PRAGMA user_version = 1',
			'COMMIT',
		]);
	});

	it('rolls back a migration that failed', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0, failOn: 'MIGRATE 1' };
		installFakeSqlite(state);

		await expect(new VectorDatabase('test.sqlite', [], ['MIGRATE 1']).open()).rejects.toThrow();

		expect(state.statements).toContain('ROLLBACK');
	});

	it('makes a second caller wait until the schema and migrations are in place', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0 };
		installFakeSqlite(state, { asyncRun: true });
		const db = new VectorDatabase('test.sqlite', ['CREATE A'], ['MIGRATE 1']);

		const first = db.open();
		await new Promise((resolve) => setTimeout(resolve, 2));
		await db.open();

		expect(state.statements).toContain('CREATE A');
		expect(state.statements).toContain('MIGRATE 1');
		await first;
	});

	it('opens only once however many times it is asked', async () => {
		const state: FakeDatabaseState = { statements: [], userVersion: 0 };
		installFakeSqlite(state);
		const db = new VectorDatabase('test.sqlite', ['CREATE A']);

		await Promise.all([db.open(), db.open()]);
		await db.open();

		expect(state.statements.filter((sql) => sql === 'CREATE A')).toHaveLength(1);
	});
});
