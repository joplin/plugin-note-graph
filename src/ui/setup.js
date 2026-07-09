(() => {
	const bindClose = () => {
		const closeButton = document.getElementById('graph-close');
		if (!closeButton || typeof webviewApi === 'undefined') return;
		closeButton.addEventListener('click', () => {
			void webviewApi.postMessage({ type: 'close-note-graph' });
		});
	};

	const bindAll = () => {
		bindClose();
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindAll);
		return;
	}

	bindAll();
})();
