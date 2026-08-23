type HeaderProps = {
	title?: string;
};

const LogoSvg = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="17" cy="6" r="3" fill="#5b9bd5"/><circle cx="7" cy="7" r="3" fill="#5b9bd5" opacity="0.7"/><circle cx="12" cy="18" r="3" fill="#5b9bd5" opacity="0.85"/><line x1="15.5" y1="8.5" x2="9" y2="9" stroke="#5b9bd5" stroke-width="1.2" stroke-opacity="0.5"/><line x1="9" y1="9" x2="12" y2="15.2" stroke="#5b9bd5" stroke-width="1.2" stroke-opacity="0.5"/></svg>`;

const CloseSvg = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;

const NotebookSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 19.5V5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v15.5M6 3v18M6 21h12a1 1 0 0 0 1-1V4"/></svg>`;

const ChevronSvg = `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;

const renderHeader = (props: HeaderProps = {}): string => {
	return `
		<header class="panel-header">
			<div class="panel-header__brand">
				<span class="panel-header__logo">${LogoSvg}</span>
				<span class="panel-header__title">${props.title ?? 'Note Graph'}</span>
			</div>
			<div class="panel-header__actions">
				<div class="panel-header__scope">
					<button id="graph-scope-btn" class="panel-header__scope-btn" type="button" aria-haspopup="true" aria-expanded="false">
						${NotebookSvg}
						<span id="graph-scope-label">All notebooks</span>
						${ChevronSvg}
					</button>
					<div id="graph-scope-menu" class="panel-header__scope-menu" hidden>
						<button class="panel-header__scope-menu-item" data-scope-mode="all" type="button">All notebooks</button>
						<button class="panel-header__scope-menu-item" data-scope-mode="current" type="button">Current notebook</button>
						<button id="graph-scope-select-toggle" class="panel-header__scope-menu-item panel-header__scope-menu-item--expandable" type="button" aria-expanded="false">
							<span>Select notebooks</span>
							${ChevronSvg}
						</button>
						<div id="graph-scope-select-panel" class="panel-header__scope-select-panel" hidden>
							<div id="graph-scope-notebook-list" class="panel-header__scope-notebook-list"></div>
							<button id="graph-scope-apply" class="panel-header__scope-apply-btn" type="button">Apply</button>
						</div>
					</div>
				</div>
				<span class="panel-header__divider"></span>
				<button id="graph-close" class="panel-header__icon-btn" type="button" aria-label="Close panel">${CloseSvg}</button>
			</div>
		</header>
	`;
};

export { renderHeader };
