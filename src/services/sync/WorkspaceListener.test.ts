import joplin from 'api';
import { WorkspaceListener } from './WorkspaceListener';
import { IncrementalUpdater } from './IncrementalUpdater';

jest.mock('./IncrementalUpdater');

const MockIncrementalUpdater = IncrementalUpdater as jest.MockedClass<typeof IncrementalUpdater>;

describe('WorkspaceListener', () => {
	it('registers all three workspace events and forwards them to the matching updater method', async () => {
		const updater = new MockIncrementalUpdater(
			{} as never,
			{} as never,
			jest.fn()
		) as jest.Mocked<IncrementalUpdater>;
		updater.handleSyncComplete.mockResolvedValue(undefined);
		const listener = new WorkspaceListener(updater);

		await listener.register();

		expect(joplin.workspace.onNoteChange).toHaveBeenCalledTimes(1);
		expect(joplin.workspace.onNoteSelectionChange).toHaveBeenCalledTimes(1);
		expect(joplin.workspace.onSyncComplete).toHaveBeenCalledTimes(1);

		const noteChangeCallback = (joplin.workspace.onNoteChange as jest.Mock).mock.calls[0][0];
		noteChangeCallback({ id: 'a', event: 1 });
		expect(updater.handleNoteChange).toHaveBeenCalledWith({ id: 'a', event: 1 });

		const selectionCallback = (joplin.workspace.onNoteSelectionChange as jest.Mock).mock
			.calls[0][0];
		selectionCallback({ value: ['a'] });
		expect(updater.handleSelectionChange).toHaveBeenCalledWith({ value: ['a'] });

		const syncCompleteCallback = (joplin.workspace.onSyncComplete as jest.Mock).mock.calls[0][0];
		syncCompleteCallback();
		expect(updater.handleSyncComplete).toHaveBeenCalledTimes(1);
	});

	it('does not let a handleSyncComplete rejection become an unhandled rejection', async () => {
		const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		const updater = new MockIncrementalUpdater(
			{} as never,
			{} as never,
			jest.fn()
		) as jest.Mocked<IncrementalUpdater>;
		updater.handleSyncComplete.mockRejectedValue(new Error('full reload also failed'));
		const listener = new WorkspaceListener(updater);
		await listener.register();

		const syncCompleteCallback = (joplin.workspace.onSyncComplete as jest.Mock).mock.calls[0][0];
		syncCompleteCallback();
		await Promise.resolve();
		await Promise.resolve();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Sync-complete handling failed:',
			expect.any(Error)
		);
		consoleErrorSpy.mockRestore();
	});
});
