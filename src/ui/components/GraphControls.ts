const ZoomInSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`;

const ZoomOutSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 12h14"/></svg>`;

const renderGraphControls = (): string => {
	return `
		<div class="graph-controls-bottom-left">
			<button id="graph-layout-btn" class="graph-pill-btn" type="button" aria-haspopup="true" aria-expanded="false">
				<span id="graph-layout-label">fCoSE</span>
			</button>
			<div id="graph-layout-menu" class="graph-pill-menu" hidden>
				<button class="graph-pill-menu-item" data-layout="fcose" type="button">fCoSE</button>
				<div class="graph-menu-divider"></div>
				<button class="graph-pill-menu-item" data-layout="hierarchical" type="button">Hierarchical</button>
			</div>
		</div>
		<div class="graph-zoom">
			<button id="graph-zoom-in" class="graph-zoom__btn" type="button" aria-label="Zoom in">${ZoomInSvg}</button>
			<button id="graph-zoom-out" class="graph-zoom__btn" type="button" aria-label="Zoom out">${ZoomOutSvg}</button>
		</div>
	`;
};

export { renderGraphControls };
