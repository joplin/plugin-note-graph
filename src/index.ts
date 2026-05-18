import joplin from 'api';
import { fetchAllNotes } from './notesFetcher';

joplin.plugins.register({
	onStart: async function() {
		try { const notes = await fetchAllNotes();
			// eslint-disable-next-line no-console
			console.info(`Note Graph Plugin started. Total notes fetched: ${notes.length}`);
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Error fetching notes:', error);
		}
	},
});
