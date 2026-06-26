type HeaderProps = {
	title?: string;
};

const LogoSvg = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="17" cy="6" r="3" fill="#5b9bd5"/><circle cx="7" cy="7" r="3" fill="#5b9bd5" opacity="0.7"/><circle cx="12" cy="18" r="3" fill="#5b9bd5" opacity="0.85"/><line x1="15.5" y1="8.5" x2="9" y2="9" stroke="#5b9bd5" stroke-width="1.2" stroke-opacity="0.5"/><line x1="9" y1="9" x2="12" y2="15.2" stroke="#5b9bd5" stroke-width="1.2" stroke-opacity="0.5"/></svg>`;

const SettingsSvg = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const CloseSvg = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;

const renderHeader = (props: HeaderProps = {}): string => {
	return `
		<header class="panel-header">
			<div class="panel-header__brand">
				<span class="panel-header__logo">${LogoSvg}</span>
				<span class="panel-header__title">${props.title ?? 'Note Graph'}</span>
			</div>
			<div class="panel-header__actions">
				<button class="panel-header__icon-btn" type="button" aria-label="Settings">${SettingsSvg}</button>
				<span class="panel-header__action-sep"></span>
				<button id="graph-close" class="panel-header__icon-btn" type="button" aria-label="Close panel">${CloseSvg}</button>
			</div>
		</header>
	`;
};

export { renderHeader };