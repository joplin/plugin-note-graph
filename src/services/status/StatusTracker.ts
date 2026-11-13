export interface Progress {
	current: number;
	total: number;
}

export type NoteLoadStage = 'not-started' | 'loading' | 'loaded' | 'failed';

export interface TrackedStatus {
	noteLoad: NoteLoadStage;
	noteLoadDetail: string | null;
	notesComplete: boolean;
	loadedFromCache: boolean;
	aiProgress: Progress | null;
	aiCancelled: boolean;
	aiFallbackReason: string | null;
	labelProgress: Progress | null;
	labelsCancelled: boolean;
	lastGraphShownAt: number | null;
}

/** Remembers what the plugin is doing and how its last attempts went, for the status panel. */
export class StatusTracker {
	private state: TrackedStatus = {
		noteLoad: 'not-started',
		noteLoadDetail: null,
		notesComplete: true,
		loadedFromCache: false,
		aiProgress: null,
		aiCancelled: false,
		aiFallbackReason: null,
		labelProgress: null,
		labelsCancelled: false,
		lastGraphShownAt: null,
	};

	public constructor(private readonly now: () => number = Date.now) {}

	public snapshot(): TrackedStatus {
		return { ...this.state };
	}

	public noteLoadStarted(): void {
		this.state.noteLoad = 'loading';
		this.state.noteLoadDetail = null;
	}

	public noteLoadProgressed(detail: string): void {
		this.state.noteLoadDetail = detail;
	}

	public notesLoaded(complete: boolean, fromCache: boolean): void {
		this.state.noteLoad = 'loaded';
		this.state.noteLoadDetail = null;
		this.state.notesComplete = complete;
		this.state.loadedFromCache = fromCache;
	}

	public noteLoadFailed(): void {
		if (this.state.noteLoad !== 'loaded') this.state.noteLoad = 'failed';
		this.state.noteLoadDetail = null;
	}

	public aiStarted(): void {
		this.state.aiProgress = null;
		this.state.aiCancelled = false;
	}

	public aiProgressed(progress: Progress): void {
		this.state.aiProgress = progress;
	}

	public aiFinished(fallbackReason: string | null): void {
		this.state.aiProgress = null;
		this.state.aiFallbackReason = fallbackReason;
	}

	public labelsProgressed(progress: Progress): void {
		this.state.labelProgress = progress.current >= progress.total ? null : progress;
		this.state.labelsCancelled = false;
	}

	public cancelled(step: 'ai' | 'labels'): void {
		if (step === 'labels') {
			this.state.labelsCancelled = true;
			this.state.labelProgress = null;
		} else {
			this.state.aiCancelled = true;
			this.state.aiProgress = null;
		}
	}

	public graphShown(): void {
		this.state.lastGraphShownAt = this.now();
	}
}
