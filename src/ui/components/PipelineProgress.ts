const renderPipelineProgress = (): string => {
	return `
		<span id="pipeline-progress" class="pipeline-progress" style="display:none;">
			<span class="pipeline-progress__spinner"></span>
			<span class="pipeline-progress__track">
				<span id="pipeline-progress-fill" class="pipeline-progress__fill"></span>
			</span>
			<span id="pipeline-progress-label" class="pipeline-progress__label"></span>
		</span>
	`;
};

export { renderPipelineProgress };
