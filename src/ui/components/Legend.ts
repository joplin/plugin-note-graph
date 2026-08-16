const ExportSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v12M8 12l4 4 4-4M4 20h16"/></svg>`;

const FitSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;

const FocusSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`;

const SearchSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15 15l5.5 5.5"/></svg>`;

const GroupSvg = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><circle cx="17" cy="17" r="1.5" fill="currentColor"/></svg>`;

const renderLegend = (): string => {
	return `
		<div id="legend-panel" class="legend-panel">
			<div class="legend-panel__row">
				<div class="legend-panel__group">
					<span class="legend-panel__group-label">Edges</span>
					<button class="legend-panel__pill legend-panel__pill--explicit" data-edge="link" type="button">
						<span class="legend-panel__swatch legend-panel__swatch--explicit"></span>
						<span class="legend-panel__pill-label">Explicit</span>
					</button>
					<button class="legend-panel__pill legend-panel__pill--semantic" data-edge="semantic" type="button">
						<span class="legend-panel__swatch legend-panel__swatch--semantic"></span>
						<span class="legend-panel__pill-label">Semantic</span>
					</button>
					<button class="legend-panel__pill legend-panel__pill--tags" data-edge="tag" type="button">
						<span class="legend-panel__swatch legend-panel__swatch--tags"></span>
						<span class="legend-panel__pill-label">Tags</span>
					</button>
				</div>
				<div class="legend-panel__search">
					<span class="legend-panel__search-icon">${SearchSvg}</span>
					<input id="graph-search" class="legend-panel__search-input" type="text" placeholder="Search notes..." autocomplete="off" />
				</div>
			</div>
			<div class="legend-panel__row">
				<div class="legend-panel__controls">
					<select id="graph-category-filter" class="legend-panel__select" aria-label="Filter by category" style="display:none;">
						<option value="">All categories</option>
					</select>
					<button id="graph-focus" class="legend-panel__action-btn" type="button" aria-label="Focus mode">${FocusSvg}<span>Focus</span></button>
					<button id="graph-group-toggle" class="legend-panel__action-btn" type="button" aria-label="Group notes by community" aria-pressed="false">${GroupSvg}<span>Group</span></button>
				</div>
				<div class="legend-panel__actions">
					<button id="graph-export" class="legend-panel__action-btn" type="button" aria-label="Export graph">${ExportSvg}<span>Export</span></button>
					<button id="graph-fit" class="legend-panel__action-btn" type="button" aria-label="Fit graph">${FitSvg}<span>Fit</span></button>
				</div>
			</div>
		</div>
	`;
};

export { renderLegend };
