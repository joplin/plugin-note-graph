import { renderPipelineProgress } from './PipelineProgress';

const renderStat = (id: string, label: string): string => `
	<span class="stats-bar__stat">
		<span id="${id}" class="stats-bar__count">0</span>
		<span class="stats-bar__label">${label}</span>
	</span>
`;

const renderStatsBar = (): string => {
	return `
		<footer id="stats-bar" class="stats-bar stats-bar--empty">
			${renderStat('stat-notes', 'notes')}
			${renderStat('stat-explicit', 'links')}
			${renderStat('stat-tags', 'tags')}
			${renderStat('stat-semantic', 'similar')}
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
