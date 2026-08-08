const renderAnalysisProgress = (): string => {
	return `
		<div id="analysis-progress" class="analysis-progress" style="display:none;">
			<div class="analysis-progress__track">
				<div id="analysis-progress-fill" class="analysis-progress__fill"></div>
			</div>
			<span id="analysis-progress-label" class="analysis-progress__label"></span>
		</div>
	`;
};

export { renderAnalysisProgress };
