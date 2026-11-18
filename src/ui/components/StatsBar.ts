import { renderPipelineProgress } from './PipelineProgress';

const renderStatsBar = (): string => {
	return `
		<footer id="stats-bar" class="stats-bar stats-bar--empty">
			<span class="stats-bar__stat">
				<i class="note-dot"></i>
				<span id="stat-notes" class="stats-bar__count">0</span>
				<span id="stat-notes-label" class="stats-bar__label">notes</span>
			</span>
			<span class="stats-bar__stat" hidden>
				<i class="note-dot note-dot--outside"></i>
				<span id="stat-outside" class="stats-bar__count">0</span>
				<span class="stats-bar__label">connected from other notebooks</span>
			</span>
			<label id="graph-density-control" class="stats-bar__density" style="display:none;" title="Hide similar-note connections weaker than this">
				<span class="stats-bar__label">Min. similarity</span>
				<input id="graph-density-slider" class="stats-bar__slider" type="range" min="0" max="100" value="0" step="5" aria-label="Minimum similarity" />
				<span id="graph-density-value" class="stats-bar__density-value">0%</span>
			</label>
			${renderPipelineProgress()}
		</footer>
	`;
};

export { renderStatsBar };
