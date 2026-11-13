import joplin from 'api';
import { GraphCacheRepository } from '../../data/Database/GraphCacheRepository';
import { JoplinAiApi, isIndexUsable } from '../embeddings/providers/JoplinNativeProvider';
import { retryWithBackoff } from '../../utils/retryWithBackoff';

/** Small, because the last page can't be passed and is read again on every sweep. */
const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES = 5000;

const INDEX_STATUS_RETRY = { maxAttempts: 3, baseDelayMs: 1000 };

export interface EmbeddingChanges {
	noteIds: string[];
	/** The vectors of every note are now out of date, so a full reload is needed. */
	modelChanged: boolean;
	/** The first sweep over a large index: `noteIds` is everything indexed so far, not what changed. */
	isBaseline: boolean;
}

export type EmbeddingSweepState = Pick<
	GraphCacheRepository,
	| 'loadEmbeddingsCursor'
	| 'saveEmbeddingsCursor'
	| 'clearEmbeddingsCursor'
	| 'loadEmbeddingsModel'
	| 'saveEmbeddingsModel'
>;

/**
 * Finds notes Joplin has re-embedded, by following its chunk stream from where
 * the last sweep stopped. This is the only reliable signal: Joplin re-embeds an
 * edit minutes later, and nothing in the note itself says whether it has yet.
 */
export class EmbeddingChangeDetector {
	public constructor(private readonly state: EmbeddingSweepState) {}

	public async detect(): Promise<EmbeddingChanges> {
		const api = this.getAiApi();
		const modelId = await this.requireUsableIndex(api);

		const storedModel = await this.state.loadEmbeddingsModel();
		const modelChanged = !!storedModel && !!modelId && storedModel !== modelId;
		if (modelChanged) await this.state.clearEmbeddingsCursor();

		const savedCursor = modelChanged ? null : await this.state.loadEmbeddingsCursor();
		const { noteIds, lastCursor } = await this.walkStream(api, savedCursor);

		if (lastCursor) await this.state.saveEmbeddingsCursor(lastCursor);
		if (modelId) await this.state.saveEmbeddingsModel(modelId);

		if (modelChanged) return { noteIds: [], modelChanged: true, isBaseline: false };

		return {
			noteIds,
			modelChanged: false,
			isBaseline: savedCursor === null && lastCursor !== null,
		};
	}

	private async walkStream(
		api: JoplinAiApi,
		startCursor: string | null
	): Promise<{ noteIds: string[]; lastCursor: string | null }> {
		const noteIds = new Set<string>();
		let cursor = startCursor;

		for (let pageCount = 0; pageCount < SWEEP_MAX_PAGES; pageCount++) {
			const page = await api.getEmbeddings({
				cursor: cursor ?? undefined,
				limit: SWEEP_PAGE_SIZE,
			});
			for (const chunk of page.chunks) noteIds.add(chunk.noteId);

			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}

		return { noteIds: Array.from(noteIds), lastCursor: cursor };
	}

	/** Deliberately synchronous: returning the joplin.ai proxy from an async function triggers a phantom `.then` RPC call. */
	private getAiApi(): JoplinAiApi {
		const api = joplin.ai as unknown as JoplinAiApi | undefined;
		if (!api) {
			throw new Error('joplin.ai is not available. Enable AI in Settings → AI.');
		}
		return api;
	}

	private async requireUsableIndex(api: JoplinAiApi): Promise<string | null> {
		const status = await retryWithBackoff(
			'getIndexStatus() call',
			() => api.getIndexStatus(),
			INDEX_STATUS_RETRY
		);
		if (!status || !isIndexUsable(status.state)) {
			throw new Error(
				`Joplin AI index is not usable yet (state: ${status?.state ?? 'unknown'}).`
			);
		}
		return status.modelId ?? null;
	}
}
