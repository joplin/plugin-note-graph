const CloseSvg = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;

const NotebookSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 3h13v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18"/></svg>`;

const ChevronSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;

const SearchSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 15.5L21 21"/></svg>`;

const renderHeader = (): string => {
	return `
		<header class="panel-header">
			<div class="panel-header__scope">
				<button id="graph-scope-btn" class="panel-header__scope-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Choose what the graph shows">
					${NotebookSvg}
					<span id="graph-scope-label" class="panel-header__scope-label">All notebooks</span>
					${ChevronSvg}
				</button>
				<div id="graph-scope-menu" class="panel-header__scope-menu" hidden>
					<button class="panel-header__scope-menu-item" data-scope-mode="current" type="button">Current notebook</button>
					<button class="panel-header__scope-menu-item" data-scope-mode="all" type="button">All notebooks</button>
					<button id="graph-scope-select-toggle" class="panel-header__scope-menu-item panel-header__scope-menu-item--expandable" type="button" aria-expanded="false">
						<span>Select notebooks</span>
						${ChevronSvg}
					</button>
					<div id="graph-scope-select-panel" class="panel-header__scope-select-panel" hidden>
						<input id="graph-scope-filter" class="panel-header__scope-filter" type="text" placeholder="Filter notebooks" aria-label="Filter notebooks" autocomplete="off" />
						<div id="graph-scope-notebook-list" class="panel-header__scope-notebook-list"></div>
						<button id="graph-scope-apply" class="panel-header__scope-apply-btn" type="button">Apply</button>
					</div>
				</div>
			</div>
			<div class="panel-search">
				<span class="panel-search__icon">${SearchSvg}</span>
				<input id="graph-search" class="panel-search__input" type="text" placeholder="Search notes" aria-label="Search notes" autocomplete="off" />
			</div>
			<button id="graph-close" class="panel-header__icon-btn" type="button" aria-label="Close panel" title="Close">${CloseSvg}</button>
		</header>
	`;
};

export { renderHeader };
