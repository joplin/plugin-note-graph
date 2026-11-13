import { renderHeader } from './components/Header';
import { renderLegend } from './components/Legend';
import { renderStatsBar } from './components/StatsBar';
import { renderGraphControls } from './components/GraphControls';

const renderPanelHtml = (): string => {
	return `
		<div class="panel-root">
			${renderHeader()}
			${renderLegend()}
			<div id="graph-container">
				${renderGraphControls()}
				<div id="graph-view-bar" class="graph-view-bar" hidden>
					<button id="graph-view-back" class="graph-view-bar__back" type="button" hidden></button>
					<span id="graph-view-title" class="graph-view-bar__title"></span>
					<label id="graph-depth-control" class="graph-view-bar__depth" title="How many steps out from this note to show" hidden>
						<span>Depth</span>
						<input id="graph-depth-slider" type="range" min="1" max="3" step="1" value="2" />
						<span id="graph-depth-value" class="graph-view-bar__depth-value">2</span>
					</label>
				</div>
				<span id="graph-status">Loading graph...</span>
				<div id="graph-toast" class="graph-toast" role="status" hidden></div>
			</div>
			${renderStatsBar()}
		</div>
	`;
};

export { renderPanelHtml };