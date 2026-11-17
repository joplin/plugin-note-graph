import { CheckSvg, ChevronSvg } from './Icons';

const CloseSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;

const NotebookSvg = `<svg viewBox="0 0 12 16" width="10" height="13.5" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect x="0.75" y="0.75" width="10.5" height="14.5" rx="1.75" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M3.75 4.5h4.5"/></svg>`;

const SearchSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.2 16.2L21 21"/></svg>`;

const renderScopeMode = (mode: string, label: string): string => `
	<button class="panel-header__scope-menu-item" data-scope-mode="${mode}" type="button">
		<span>${label}</span>
		<span class="panel-header__scope-menu-check">${CheckSvg}</span>
	</button>
`;

const renderHeader = (): string => {
	return `
		<header class="panel-header">
			<div class="panel-header__scope">
				<button id="graph-scope-btn" class="panel-header__scope-btn" type="button" aria-haspopup="true" aria-expanded="false" title="Choose what the graph shows">
					${NotebookSvg}
					<span id="graph-scope-label" class="panel-header__scope-label">All notebooks</span>
					${ChevronSvg}
				</button>
				<div id="graph-scope-menu" class="panel-header__scope-menu menu-card" hidden>
					<div class="panel-header__scope-menu-title">Show notes from</div>
					${renderScopeMode('current', 'Current notebook')}
					${renderScopeMode('all', 'All notebooks')}
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
			<div class="panel-header__end">
				<button id="graph-info-btn" class="status-pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="graph-info-panel" aria-label="Graph status" title="Graph status">
					<span class="status-pill__state"><span class="status-pill__dot"></span><span class="spinner"></span></span>
					<span id="graph-info-label" class="status-pill__label">Up to date</span>
					<span class="status-pill__chevron">${ChevronSvg}</span>
				</button>
				<div id="graph-info-panel" class="info-panel" role="dialog" aria-label="Graph status" hidden>
					<div class="info-panel__head">
						<span class="info-panel__title">Graph status</span>
						<span id="graph-info-updated" class="info-panel__updated"></span>
					</div>
					<ul id="graph-info-items" class="info-panel__items"></ul>
					<div id="graph-info-problems-item" class="info-item info-item--problems">
						<span id="graph-info-problems-icon" class="info-item__icon"></span>
						<div class="info-item__body">
							<div class="info-item__head">
								<span class="info-item__title">Recent problems</span>
								<button id="graph-info-clear" class="info-panel__link" type="button" hidden>Clear</button>
							</div>
							<ul id="graph-info-problems" class="info-panel__problems"></ul>
						</div>
					</div>
				</div>
				<button id="graph-close" class="panel-header__icon-btn" type="button" aria-label="Close panel" title="Close">${CloseSvg}</button>
			</div>
		</header>
	`;
};

export { renderHeader };
