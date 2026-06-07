import { renderHeader } from './components/Header';

const renderPanelHtml = (): string => {
	return `
		<div class="panel-root">
			${renderHeader()}
		</div>
	`;
};

export { renderPanelHtml };
