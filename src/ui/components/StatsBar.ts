import { renderPipelineProgress } from './PipelineProgress';

const ConfidenceSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 18a8 8 0 0 1 16 0"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 18l4-6"/><circle cx="12" cy="18" r="1.4" fill="currentColor"/></svg>`;

const renderStatsBar = (): string => {
	return `
		<div id="stats-bar" class="stats-bar">
			<span class="stats-bar__stat">
				<span id="stat-notes" class="stats-bar__count">0</span>
				<span class="stats-bar__label">notes</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-explicit" class="stats-bar__count">0</span>
				<span class="stats-bar__label">explicit edges</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-tags" class="stats-bar__count">0</span>
				<span class="stats-bar__label">total tags</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-semantic" class="stats-bar__count">0</span>
				<span class="stats-bar__label">semantic edges</span>
			</span>
			<span id="graph-density-control" class="stats-bar__density" style="display:none;">
				<span class="stats-bar__density-icon">${ConfidenceSvg}</span>
				<span class="stats-bar__label">confidence</span>
				<input id="graph-density-slider" class="stats-bar__slider" type="range" min="0" max="100" value="0" step="5" aria-label="Minimum semantic confidence" />
				<span id="graph-density-value" class="stats-bar__density-value">0%</span>
			</span>
			${renderPipelineProgress()}
		</div>
	`;
};

export { renderStatsBar };
