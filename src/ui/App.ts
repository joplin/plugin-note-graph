import { renderHeader } from './components/Header';
import { renderLegend } from './components/Legend';
import { renderStatsBar } from './components/StatsBar';
import { renderGraphControls } from './components/GraphControls';

const renderPanelHtml = (): string => {
	return `
		<div class="panel-root">
			${renderHeader()}
			${renderLegend()}
			${renderStatsBar()}
			<div id="graph-container">
				${renderGraphControls()}
				<span id="graph-status">Loading graph...</span>
			</div>
		</div>
	`;
};

export { renderPanelHtml };