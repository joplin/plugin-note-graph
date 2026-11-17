import { renderHeader } from './components/Header';
import { renderLegend } from './components/Legend';
import { renderStatsBar } from './components/StatsBar';
import { renderGraphControls } from './components/GraphControls';

const BackSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M19 12H5M11 6l-6 6 6 6"/></svg>`;

const LessSvg = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 12h14"/></svg>`;

const MoreSvg = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`;

const renderDepthControl = (): string => `
	<div id="graph-depth-control" class="graph-view-bar__depth" title="How many steps out from this note to show" hidden>
		<span>Depth</span>
		<input id="graph-depth-slider" type="range" min="1" max="3" step="1" value="2" aria-label="Depth" hidden />
		<div class="graph-view-bar__stepper">
			<button id="graph-depth-less" class="graph-view-bar__step" type="button" aria-label="Show fewer steps">${LessSvg}</button>
			<span id="graph-depth-value" class="graph-view-bar__depth-value">2</span>
			<button id="graph-depth-more" class="graph-view-bar__step" type="button" aria-label="Show more steps">${MoreSvg}</button>
		</div>
	</div>
`;

const renderPanelHtml = (): string => {
	return `
		<div class="panel-root">
			${renderHeader()}
			${renderLegend()}
			<div id="graph-container">
				${renderGraphControls()}
				<div id="graph-view-bar" class="graph-view-bar" hidden>
					<button id="graph-view-back" class="graph-view-bar__back" type="button" hidden>${BackSvg}<span id="graph-view-back-label"></span></button>
					<span id="graph-view-title" class="graph-view-bar__title"></span>
					${renderDepthControl()}
				</div>
				<span id="graph-status">Loading graph...</span>
				<div id="graph-toast" class="graph-toast" role="status" hidden></div>
			</div>
			${renderStatsBar()}
		</div>
	`;
};

export { renderPanelHtml };
