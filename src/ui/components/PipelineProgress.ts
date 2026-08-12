const CancelSvg = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;

const renderPipelineProgress = (): string => {
	return `
		<span id="pipeline-progress" class="pipeline-progress" style="display:none;">
			<span class="pipeline-progress__spinner"></span>
			<span class="pipeline-progress__track">
				<span id="pipeline-progress-fill" class="pipeline-progress__fill"></span>
			</span>
			<span id="pipeline-progress-label" class="pipeline-progress__label"></span>
			<button id="pipeline-progress-cancel" class="pipeline-progress__cancel-btn" type="button" aria-label="Cancel analysis">${CancelSvg}</button>
		</span>
	`;
};

export { renderPipelineProgress };
