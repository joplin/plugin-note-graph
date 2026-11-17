import { CheckSvg, ChevronSvg } from './Icons';

const ExportSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v13M6.5 10.5L12 16l5.5-5.5M4 21h16"/></svg>`;

const FocusSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

const GroupSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

const TagSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7.1a2 2 0 0 1 1.4.6l8 8a2 2 0 0 1 0 2.8l-6.6 6.6a2 2 0 0 1-2.8 0l-8-8A2 2 0 0 1 3 11.6z"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/></svg>`;

const ColorBySvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="7.5" cy="7.5" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="7.5" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="16.5" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

const LayoutSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="5" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="19" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 7.5v9M15.5 8.5c-5 .5-9.5 2-9.5 8"/></svg>`;

const renderEdgeToggle = (
	edge: string,
	kind: string,
	label: string,
	countId: string,
	title: string
): string => `
	<button class="legend-panel__pill legend-panel__pill--${kind}" data-edge="${edge}" type="button" title="${title}" aria-pressed="true">
		<i class="edge-swatch edge-swatch--${edge}"></i>
		<span class="legend-panel__pill-label">${label}</span>
		<span id="${countId}" class="legend-panel__pill-count">0</span>
	</button>
`;

const renderDropdown = (select: string, icon: string, title: string): string => `
	<div class="graph-dropdown">
		${select}
		<button class="legend-panel__action-btn graph-dropdown__button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="${title}" title="${title}">
			${icon}
			<span class="graph-dropdown__value"></span>
			<span class="legend-panel__chevron">${ChevronSvg}</span>
		</button>
		<div class="graph-dropdown__menu menu-card" role="listbox" hidden></div>
	</div>
`;

const renderLayoutChoice = (layout: string, label: string): string => `
	<button class="graph-dropdown__item" data-layout="${layout}" type="button" role="option">
		<span class="graph-dropdown__label">${label}</span>
		<span class="graph-dropdown__check">${CheckSvg}</span>
	</button>
`;

const renderLayoutPicker = (): string => `
	<div class="graph-dropdown">
		<button id="graph-layout-btn" class="legend-panel__action-btn" type="button" aria-haspopup="true" aria-expanded="false" title="How notes are arranged">
			${LayoutSvg}
			<span id="graph-layout-label" class="graph-dropdown__value">Organic</span>
			<span class="legend-panel__chevron">${ChevronSvg}</span>
		</button>
		<div id="graph-layout-menu" class="graph-dropdown__menu graph-dropdown__menu--right menu-card" hidden>
			${renderLayoutChoice('fcose', 'Organic')}
			${renderLayoutChoice('hierarchical', 'Tree')}
		</div>
	</div>
`;

const renderLegend = (): string => {
	return `
		<div id="legend-panel" class="legend-panel">
			<div class="legend-panel__group" role="group" aria-label="Connections to show">
				${renderEdgeToggle('link', 'explicit', 'Links', 'stat-explicit', 'Links you wrote between notes')}
				${renderEdgeToggle(
					'semantic',
					'semantic',
					'Similar',
					'stat-semantic',
					'Notes Joplin AI finds similar'
				)}
				${renderEdgeToggle('tag', 'tags', 'Tags', 'stat-tags', 'Notes that share a tag')}
			</div>
			<div class="legend-panel__controls">
				<select id="graph-category-filter" class="legend-panel__select" aria-label="Filter by category" style="display:none;">
					<option value="">All categories</option>
				</select>
				${renderDropdown(
					`<select id="graph-tag-filter" class="graph-dropdown__native" hidden>
						<option value="">All tags</option>
					</select>`,
					TagSvg,
					'Show only notes with this tag'
				)}
				${renderDropdown(
					`<select id="graph-color-by" class="graph-dropdown__native">
						<option value="none">One color</option>
						<option value="community">Groups</option>
						<option value="notebook">Notebook</option>
						<option value="search">Search</option>
					</select>`,
					ColorBySvg,
					'Color notes by'
				)}
				${renderLayoutPicker()}
				<span class="legend-panel__divider"></span>
				<button id="graph-focus" class="legend-panel__action-btn" type="button" aria-label="Focus on the selected note" title="Show only the notes near the selected one">${FocusSvg}<span>Focus</span></button>
				<button id="graph-group-toggle" class="legend-panel__action-btn" type="button" aria-label="Group notes by community" aria-pressed="false" hidden>${GroupSvg}<span>Group</span></button>
				<button id="graph-export" class="legend-panel__action-btn legend-panel__action-btn--icon" type="button" aria-label="Export graph" title="Export">${ExportSvg}</button>
			</div>
		</div>
	`;
};

export { renderLegend };
