(() => {
	const bindClose = () => {
		const closeButton = document.getElementById('graph-close');
		if (!closeButton || typeof webviewApi === 'undefined') return;
		closeButton.addEventListener('click', () => {
			void webviewApi.postMessage({ type: 'close-note-graph' });
		});
	};

	const bindScopePicker = () => {
		const btn = document.getElementById('graph-scope-btn');
		const menu = document.getElementById('graph-scope-menu');
		const label = document.getElementById('graph-scope-label');
		const selectToggleBtn = document.getElementById('graph-scope-select-toggle');
		const selectPanel = document.getElementById('graph-scope-select-panel');
		const notebookListEl = document.getElementById('graph-scope-notebook-list');
		const applyBtn = document.getElementById('graph-scope-apply');
		if (!btn || !menu || !label || typeof webviewApi === 'undefined') return;

		let folders = null;
		let selectedIds = new Set();

		const closeSelectPanel = () => {
			if (!selectPanel || !selectToggleBtn) return;
			selectPanel.hidden = true;
			selectToggleBtn.setAttribute('aria-expanded', 'false');
		};

		const closeMenu = () => {
			menu.hidden = true;
			btn.setAttribute('aria-expanded', 'false');
			closeSelectPanel();
		};

		const openMenu = () => {
			menu.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		};

		const openSelectPanel = () => {
			if (!selectPanel || !selectToggleBtn) return;
			selectPanel.hidden = false;
			selectToggleBtn.setAttribute('aria-expanded', 'true');
			if (!folders) loadFolders();
		};

		const updateLabel = (mode, ids) => {
			if (mode === 'current') {
				label.textContent = 'Current notebook';
			} else if (mode === 'selected') {
				label.textContent = ids.length
					? ids.length + ' selected'
					: 'Select notebooks';
			} else {
				label.textContent = 'All notebooks';
			}
		};

		const renderNotebookList = () => {
			notebookListEl.innerHTML = '';
			(folders || []).forEach((folder) => {
				const row = document.createElement('label');
				row.className = 'panel-header__scope-checkbox-row';
				const checkbox = document.createElement('input');
				checkbox.type = 'checkbox';
				checkbox.value = folder.id;
				checkbox.checked = selectedIds.has(folder.id);
				checkbox.addEventListener('change', function () {
					if (this.checked) {
						selectedIds.add(folder.id);
					} else {
						selectedIds.delete(folder.id);
					}
				});
				const span = document.createElement('span');
				span.textContent = folder.title;
				row.appendChild(checkbox);
				row.appendChild(span);
				notebookListEl.appendChild(row);
			});
		};

		function loadFolders() {
			webviewApi
				.postMessage({ type: 'request-folders' })
				.then((response) => {
					folders = (response && response.folders) || [];
					renderNotebookList();
				})
				.catch((e) => {
					console.error('Note Graph: failed to load notebooks:', e);
				});
		}

		const applyScope = (mode) => {
			const ids = mode === 'selected' ? Array.from(selectedIds) : [];
			webviewApi
				.postMessage({ type: 'set-scope', mode: mode, selectedIds: ids })
				.catch((e) => {
					console.error('Note Graph: failed to set scope:', e);
				});
			updateLabel(mode, ids);
			closeMenu();
		};

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (menu.hidden) {
				openMenu();
			} else {
				closeMenu();
			}
		});

		document.addEventListener('click', (e) => {
			if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) {
				closeMenu();
			}
		});

		menu.querySelectorAll('[data-scope-mode]').forEach((item) => {
			item.addEventListener('click', () => {
				applyScope(item.getAttribute('data-scope-mode'));
			});
		});

		if (selectToggleBtn && selectPanel) {
			selectToggleBtn.addEventListener('click', () => {
				if (selectPanel.hidden) {
					openSelectPanel();
				} else {
					closeSelectPanel();
				}
			});
		}

		if (applyBtn) {
			applyBtn.addEventListener('click', () => {
				applyScope('selected');
			});
		}

		webviewApi
			.postMessage({ type: 'get-scope-state' })
			.then((response) => {
				if (!response) return;
				const mode = response.mode || 'all';
				selectedIds = new Set(response.selectedNotebookIds || []);
				updateLabel(mode, Array.from(selectedIds));
			})
			.catch((e) => {
				console.error('Note Graph: failed to load scope state:', e);
			});
	};

	const init = () => {
		bindClose();
		bindScopePicker();
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
		return;
	}

	init();
})();
