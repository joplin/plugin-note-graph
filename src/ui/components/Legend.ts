const ExportSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11M8 11l4 4 4-4M4 20h16"/></svg>`;

const FocusSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;

const GroupSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

const renderEdgeToggle = (edge: string, kind: string, label: string, title: string): string => `
	<button class="legend-panel__pill legend-panel__pill--${kind}" data-edge="${edge}" type="button" title="${title}" aria-pressed="true">
		<span class="legend-panel__pill-label">${label}</span>
	</button>
`;

const renderLegend = (): string => {
	return `
		<div id="legend-panel" class="legend-panel">
			<div class="legend-panel__group" role="group" aria-label="Connections to show">
				${renderEdgeToggle('link', 'explicit', 'Links', 'Links you wrote between notes')}
				${renderEdgeToggle('semantic', 'semantic', 'Similar', 'Notes Joplin AI finds similar')}
				${renderEdgeToggle('tag', 'tags', 'Tags', 'Notes that share a tag')}
			</div>
			<div class="legend-panel__controls">
				<select id="graph-category-filter" class="legend-panel__select" aria-label="Filter by category" style="display:none;">
					<option value="">All categories</option>
				</select>
				<select id="graph-tag-filter" class="legend-panel__select legend-panel__select--tag" aria-label="Show only notes with this tag" title="Show only notes with this tag" hidden>
					<option value="">All tags</option>
				</select>
				<select id="graph-color-by" class="legend-panel__select legend-panel__select--color" aria-label="Color notes by" title="Color notes by">
					<option value="community">Groups</option>
					<option value="notebook">Notebook</option>
					<option value="search">Search</option>
				</select>
				<span class="legend-panel__divider"></span>
				<button id="graph-focus" class="legend-panel__action-btn" type="button" aria-label="Focus on the selected note" title="Show only the notes near the selected one">${FocusSvg}<span>Focus</span></button>
				<button id="graph-group-toggle" class="legend-panel__action-btn" type="button" aria-label="Group notes by community" aria-pressed="false" hidden>${GroupSvg}<span>Group</span></button>
				<button id="graph-export" class="legend-panel__action-btn legend-panel__action-btn--icon" type="button" aria-label="Export graph" title="Export">${ExportSvg}</button>
			</div>
		</div>
	`;
};

export { renderLegend };
