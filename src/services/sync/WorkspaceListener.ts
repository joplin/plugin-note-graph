import joplin from 'api';
import { IncrementalUpdater } from './IncrementalUpdater';
import { Logger, consoleLogger } from '../../utils/Logger';

export class WorkspaceListener {
	public constructor(
		private readonly updater: IncrementalUpdater,
		private readonly logger: Logger = consoleLogger
	) {}

	public async register(): Promise<void> {
		await joplin.workspace.onNoteChange((event) => this.updater.handleNoteChange(event));
		await joplin.workspace.onNoteSelectionChange((event) =>
			this.updater.handleSelectionChange(event)
		);
		await joplin.workspace.onSyncComplete(() => {
			this.updater.handleSyncComplete().catch((e) => {
				this.logger.error('Sync-complete handling failed:', e);
			});
		});
	}
}
