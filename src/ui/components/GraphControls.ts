const ZoomInSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`;

const ZoomOutSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 12h14"/></svg>`;

const FitSvg = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;

const renderGraphControls = (): string => {
	return `
		<div class="graph-zoom" role="group" aria-label="Zoom">
			<button id="graph-zoom-in" class="graph-zoom__btn" type="button" aria-label="Zoom in" title="Zoom in">${ZoomInSvg}</button>
			<button id="graph-zoom-out" class="graph-zoom__btn" type="button" aria-label="Zoom out" title="Zoom out">${ZoomOutSvg}</button>
			<button id="graph-fit" class="graph-zoom__btn" type="button" aria-label="Fit the graph in the panel" title="Fit">${FitSvg}</button>
		</div>
	`;
};

export { renderGraphControls };
