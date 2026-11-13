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
		const filterInput = document.getElementById('graph-scope-filter');
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

		const markActiveItem = (mode) => {
			menu.querySelectorAll('[data-scope-mode]').forEach((item) => {
				item.classList.toggle(
					'panel-header__scope-menu-item--active',
					item.getAttribute('data-scope-mode') === mode
				);
			});
			if (selectToggleBtn) {
				selectToggleBtn.classList.toggle(
					'panel-header__scope-menu-item--active',
					mode === 'selected'
				);
			}
		};

		const updateLabel = (mode, ids) => {
			markActiveItem(mode);
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

		const updateApplyAvailability = () => {
			if (applyBtn) applyBtn.disabled = selectedIds.size === 0;
		};

		const inTreeOrder = (list) => {
			const known = new Set(list.map((folder) => folder.id));
			const childrenOf = new Map();
			list.forEach((folder) => {
				const parent = known.has(folder.parentId) ? folder.parentId : '';
				childrenOf.set(parent, [...(childrenOf.get(parent) || []), folder]);
			});
			const ordered = [];
			const visit = (parent, depth) => {
				(childrenOf.get(parent) || [])
					.sort((a, b) => a.title.localeCompare(b.title))
					.forEach((folder) => {
						ordered.push({ folder, depth });
						visit(folder.id, depth + 1);
					});
			};
			visit('', 0);
			return ordered;
		};

		const renderNotebookRow = (folder, depth) => {
			const row = document.createElement('label');
			row.className = 'panel-header__scope-checkbox-row';
			row.style.paddingLeft = 9 + depth * 14 + 'px';
			row.title = 'Includes any notebooks inside it';
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
				updateApplyAvailability();
			});
			const span = document.createElement('span');
			span.textContent = folder.title;
			row.appendChild(checkbox);
			row.appendChild(span);
			return row;
		};

		const renderNotebookList = () => {
			const query = filterInput ? filterInput.value.trim().toLowerCase() : '';
			const rows = inTreeOrder(folders || []).filter(
				({ folder }) => !query || folder.title.toLowerCase().includes(query)
			);
			notebookListEl.innerHTML = '';
			rows.forEach(({ folder, depth }) => {
				notebookListEl.appendChild(renderNotebookRow(folder, query ? 0 : depth));
			});
			if (rows.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'panel-header__scope-empty';
				empty.textContent = 'No matching notebooks';
				notebookListEl.appendChild(empty);
			}
			updateApplyAvailability();
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

		if (filterInput) {
			filterInput.addEventListener('input', renderNotebookList);
		}

		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape' || menu.hidden) return;
			closeMenu();
			btn.focus();
		});

		if (applyBtn) {
			applyBtn.addEventListener('click', () => {
				applyScope('selected');
			});
		}

		webviewApi
			.postMessage({ type: 'get-scope-state' })
			.then((response) => {
				if (!response) return;
				const mode = response.mode || 'current';
				selectedIds = new Set(response.selectedNotebookIds || []);
				updateLabel(mode, Array.from(selectedIds));
			})
			.catch((e) => {
				console.error('Note Graph: failed to load scope state:', e);
			});
	};

	const CHECK_SVG =
		'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
	const FILTER_FROM_OPTIONS = 10;

	/**
	 * Draws a native <select> as a menu in the panel's own style. The <select> stays
	 * the source of truth, so code that sets its value or options keeps working.
	 */
	const enhanceSelect = (select) => {
		const wrapper = document.createElement('div');
		wrapper.className = 'graph-dropdown';
		select.parentNode.insertBefore(wrapper, select);
		wrapper.appendChild(select);
		select.classList.add('graph-dropdown__native');
		select.tabIndex = -1;
		select.setAttribute('aria-hidden', 'true');

		const button = document.createElement('button');
		button.type = 'button';
		button.className =
			select.className.replace('graph-dropdown__native', '') + ' graph-dropdown__button';
		button.title = select.title;
		button.setAttribute('aria-haspopup', 'listbox');
		button.setAttribute('aria-expanded', 'false');
		button.setAttribute('aria-label', select.getAttribute('aria-label') || '');
		wrapper.appendChild(button);

		const menu = document.createElement('div');
		menu.className = 'graph-dropdown__menu';
		menu.setAttribute('role', 'listbox');
		menu.hidden = true;
		wrapper.appendChild(menu);

		const sync = () => {
			const selected = select.options[select.selectedIndex] || select.options[0];
			button.textContent = selected ? selected.textContent : '';
			wrapper.hidden = select.hidden;
		};

		const items = () => Array.from(menu.querySelectorAll('.graph-dropdown__item'));

		const choose = (value) => {
			close();
			button.focus();
			if (select.value === value) return;
			select.value = value;
			select.dispatchEvent(new Event('change'));
		};

		const renderItems = (filter) => {
			const list = menu.querySelector('.graph-dropdown__list');
			list.innerHTML = '';
			const query = (filter || '').trim().toLowerCase();
			Array.from(select.options)
				.filter((option) => !query || option.textContent.toLowerCase().includes(query))
				.forEach((option) => {
					const item = document.createElement('button');
					item.type = 'button';
					item.className = 'graph-dropdown__item';
					item.setAttribute('role', 'option');
					const isSelected = option.value === select.value;
					item.setAttribute('aria-selected', String(isSelected));
					item.innerHTML = `<span class="graph-dropdown__check">${
						isSelected ? CHECK_SVG : ''
					}</span>`;
					const label = document.createElement('span');
					label.className = 'graph-dropdown__label';
					label.textContent = option.textContent;
					item.appendChild(label);
					if (option.dataset.count) {
						const count = document.createElement('span');
						count.className = 'graph-dropdown__count';
						count.textContent = option.dataset.count;
						item.appendChild(count);
					}
					item.addEventListener('click', () => choose(option.value));
					list.appendChild(item);
				});
			if (!list.children.length) {
				const empty = document.createElement('div');
				empty.className = 'graph-dropdown__empty';
				empty.textContent = 'Nothing matches';
				list.appendChild(empty);
			}
		};

		const open = () => {
			menu.innerHTML = '';
			if (select.options.length > FILTER_FROM_OPTIONS) {
				const filter = document.createElement('input');
				filter.type = 'text';
				filter.className = 'graph-dropdown__filter';
				filter.placeholder = 'Filter';
				filter.setAttribute('aria-label', 'Filter the list');
				filter.addEventListener('input', () => renderItems(filter.value));
				menu.appendChild(filter);
			}
			const list = document.createElement('div');
			list.className = 'graph-dropdown__list';
			menu.appendChild(list);
			renderItems('');
			menu.hidden = false;
			menu.classList.remove('graph-dropdown__menu--right');
			if (menu.getBoundingClientRect().right > window.innerWidth - 8) {
				menu.classList.add('graph-dropdown__menu--right');
			}
			button.setAttribute('aria-expanded', 'true');
			const first =
				menu.querySelector('.graph-dropdown__filter') ||
				menu.querySelector('[aria-selected="true"]') ||
				items()[0];
			if (first) first.focus();
		};

		const close = () => {
			menu.hidden = true;
			button.setAttribute('aria-expanded', 'false');
		};

		button.addEventListener('click', (e) => {
			e.stopPropagation();
			if (menu.hidden) open();
			else close();
		});
		button.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown' && menu.hidden) {
				e.preventDefault();
				open();
			}
		});
		menu.addEventListener('click', (e) => e.stopPropagation());
		menu.addEventListener('keydown', (e) => {
			const all = items();
			const at = all.indexOf(document.activeElement);
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				(all[at + 1] || all[0] || button).focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				(at > 0 ? all[at - 1] : all[all.length - 1] || button).focus();
			} else if (e.key === 'Escape') {
				e.stopPropagation();
				close();
				button.focus();
			} else if (e.key === 'Tab') {
				close();
			}
		});
		document.addEventListener('click', () => {
			if (!menu.hidden) close();
		});

		select.addEventListener('change', sync);
		new MutationObserver(sync).observe(select, {
			childList: true,
			attributes: true,
			attributeFilter: ['hidden'],
		});
		sync();
	};

	const enhanceSelects = () => {
		['graph-tag-filter', 'graph-color-by'].forEach((id) => {
			const select = document.getElementById(id);
			if (select) enhanceSelect(select);
		});
	};

	const init = () => {
		bindClose();
		bindScopePicker();
		enhanceSelects();
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
		return;
	}

	init();
})();
