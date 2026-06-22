import { renderHeader } from './components/Header';

const renderPanelHtml = (): string => {
	return `
		<div class="panel-root">
			${renderHeader()}
			<div id="graph-container">
				<span id="graph-status">Loading graph...</span>
			</div>
		</div>
	`;
};

export { renderPanelHtml };
