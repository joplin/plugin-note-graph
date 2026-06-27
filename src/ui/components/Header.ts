type HeaderProps = {
	title?: string;
};

const CloseSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12l-4.89 4.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z"></path></svg>`;

const renderHeader = (props: HeaderProps = {}): string => {
	return `
		<header class="panel-header">
			<div class="panel-header__title">${props.title ?? 'Note Graph'}</div>
			<button id="graph-close" class="graph-panel_close" type="button" aria-label="Close Note Graph">${CloseSvg}</button>
		</header>
	`;
};

export { renderHeader };
