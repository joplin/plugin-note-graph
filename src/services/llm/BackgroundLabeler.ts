import { Logger, consoleLogger } from '../../utils/Logger';

/** Pause between rounds, so labeling a large vault is spread out rather than sent all at once. */
export const ROUND_PAUSE_MS = 2 * 60 * 1000;

/** Rounds in a row that label nothing, such as during an outage, before it stops until asked again. */
export const MAX_IDLE_ROUNDS = 3;

export interface BackgroundLabelerOptions {
	isEnabled: () => Promise<boolean>;
	/** Similar-note connections in the current graph that have no label yet. */
	countUnlabeled: () => number;
	/** True while a labeling run is in progress, so a round doesn't start on top of it. */
	isLabeling: () => boolean;
	/** Labels one more round of connections, up to the enricher's per-round limit. */
	labelRound: () => Promise<void>;
	pauseMs?: number;
	logger?: Logger;
}

/**
 * Keeps explaining similar-note connections after the first round, one round at a
 * time with a pause in between, until every connection has a label. A round that
 * labels nothing doubles the pause, and a few of those in a row stop it.
 */
export class BackgroundLabeler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private stopped = false;
	private idleRounds = 0;

	private readonly pauseMs: number;
	private readonly logger: Logger;

	public constructor(private readonly options: BackgroundLabelerOptions) {
		this.pauseMs = options.pauseMs ?? ROUND_PAUSE_MS;
		this.logger = options.logger ?? consoleLogger;
	}

	/** Starts the next round after a pause, unless one is already due or running. */
	public schedule(): void {
		if (this.stopped || this.timer || this.running) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runRound();
		}, this.pauseMs * 2 ** Math.min(this.idleRounds, MAX_IDLE_ROUNDS));
	}

	/** For when the user cancels labeling. */
	public stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** For when the user asks for labels again. */
	public resume(): void {
		this.stopped = false;
		this.idleRounds = 0;
		this.schedule();
	}

	private async runRound(): Promise<void> {
		if (this.stopped) return;
		if (this.options.isLabeling()) {
			this.schedule();
			return;
		}
		this.running = true;
		let carryOn = false;
		try {
			carryOn = await this.labelIfNeeded();
		} catch (e) {
			this.logger.error('Background labeling round failed:', e);
			carryOn = this.recordIdleRound();
		} finally {
			this.running = false;
		}
		if (carryOn) this.schedule();
	}

	/** @returns whether another round should follow. */
	private async labelIfNeeded(): Promise<boolean> {
		if (!(await this.options.isEnabled())) return false;

		const before = this.options.countUnlabeled();
		if (before === 0) return false;

		await this.options.labelRound();
		const after = this.options.countUnlabeled();
		if (after === 0) return false;
		if (after < before) {
			this.idleRounds = 0;
			return true;
		}
		return this.recordIdleRound();
	}

	private recordIdleRound(): boolean {
		this.idleRounds++;
		if (this.idleRounds < MAX_IDLE_ROUNDS) return true;

		this.logger.info(
			`LLM enrichment: ${MAX_IDLE_ROUNDS} background rounds in a row labeled nothing; stopping until labels are asked for again.`
		);
		return false;
	}
}
