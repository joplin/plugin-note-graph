const renderStatsBar = (): string => {
	return `
		<div id="stats-bar" class="stats-bar">
			<span class="stats-bar__stat">
				<span id="stat-notes" class="stats-bar__count">0</span>
				<span class="stats-bar__label">notes</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-explicit" class="stats-bar__count">0</span>
				<span class="stats-bar__label">explicit edges</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-tags" class="stats-bar__count">0</span>
				<span class="stats-bar__label">total tags</span>
			</span>
			<span class="stats-bar__sep"></span>
			<span class="stats-bar__stat">
				<span id="stat-semantic" class="stats-bar__count">0</span>
				<span class="stats-bar__label">semantic edges</span>
			</span>
		</div>
	`;
};

export { renderStatsBar };
