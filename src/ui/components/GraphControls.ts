const ZoomInSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`;

const ZoomOutSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 12h14"/></svg>`;

const FitSvg = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;

const LayoutSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="9" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8.4 6.6l7.2 1.8M7 8.3l1.3 7.3"/></svg>`;

const renderGraphControls = (): string => {
	return `
		<div class="graph-controls-bottom-left">
			<button id="graph-layout-btn" class="graph-pill-btn" type="button" aria-haspopup="true" aria-expanded="false" title="How notes are arranged">
				${LayoutSvg}
				<span id="graph-layout-label">Organic</span>
			</button>
			<div id="graph-layout-menu" class="graph-pill-menu" hidden>
				<button class="graph-pill-menu-item" data-layout="fcose" type="button">Organic</button>
				<button class="graph-pill-menu-item" data-layout="hierarchical" type="button">Tree</button>
			</div>
		</div>
		<div class="graph-zoom" role="group" aria-label="Zoom">
			<button id="graph-zoom-in" class="graph-zoom__btn" type="button" aria-label="Zoom in" title="Zoom in">${ZoomInSvg}</button>
			<button id="graph-zoom-out" class="graph-zoom__btn" type="button" aria-label="Zoom out" title="Zoom out">${ZoomOutSvg}</button>
			<span class="graph-zoom__divider"></span>
			<button id="graph-fit" class="graph-zoom__btn" type="button" aria-label="Fit the graph in the panel" title="Fit">${FitSvg}</button>
		</div>
	`;
};

export { renderGraphControls };
