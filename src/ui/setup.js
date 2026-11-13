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

	const STATUS_POLL_OPEN_MS = 2000;
	const STATUS_POLL_CLOSED_MS = 15000;

	const formatTime = (time) =>
		new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

	const bindInfoPanel = () => {
		const btn = document.getElementById('graph-info-btn');
		const panel = document.getElementById('graph-info-panel');
		const badge = document.getElementById('graph-info-badge');
		const itemsEl = document.getElementById('graph-info-items');
		const problemsEl = document.getElementById('graph-info-problems');
		const clearBtn = document.getElementById('graph-info-clear');
		const updatedEl = document.getElementById('graph-info-updated');
		if (
			!btn ||
			!panel ||
			!badge ||
			!itemsEl ||
			!problemsEl ||
			typeof webviewApi === 'undefined'
		) {
			return;
		}

		let report = null;
		let lastSeenProblemTime = 0;
		let pollTimer = null;

		const newestProblemTime = () =>
			report && report.problems.length > 0 ? report.problems[0].time : 0;

		const updateBadge = () => {
			const needsAttention =
				!!report &&
				(report.level === 'attention' || newestProblemTime() > lastSeenProblemTime);
			badge.hidden = !needsAttention;
			btn.setAttribute(
				'aria-label',
				needsAttention ? "What's happening (needs attention)" : "What's happening"
			);
		};

		const renderItem = (item) => {
			const li = document.createElement('li');
			li.className = 'info-item info-item--' + item.level;
			const dot = document.createElement('span');
			dot.className = 'info-item__dot';
			const body = document.createElement('div');
			body.className = 'info-item__body';
			const title = document.createElement('div');
			title.className = 'info-item__title';
			title.textContent = item.title;
			const text = document.createElement('div');
			text.className = 'info-item__text';
			text.textContent = item.text;
			body.append(title, text);
			if (item.action) {
				const action = document.createElement('button');
				action.type = 'button';
				action.className = 'info-item__action';
				action.textContent = item.action.label;
				action.addEventListener('click', () => runAction(item.action.id));
				body.append(action);
			}
			li.append(dot, body);
			return li;
		};

		const renderProblem = (problem) => {
			const li = document.createElement('li');
			li.className = 'info-problem info-problem--' + problem.level;
			const time = document.createElement('span');
			time.className = 'info-problem__time';
			time.textContent = formatTime(problem.time);
			const text = document.createElement('span');
			text.className = 'info-problem__text';
			text.textContent = problem.text;
			li.append(time, text);
			if (problem.count > 1) {
				const repeats = document.createElement('span');
				repeats.className = 'info-problem__count';
				repeats.textContent = '×' + problem.count;
				repeats.title = 'Happened ' + problem.count + ' times in a row';
				li.append(repeats);
			}
			return li;
		};

		const render = () => {
			if (!report) return;
			itemsEl.replaceChildren(...report.items.map(renderItem));
			if (report.problems.length > 0) {
				problemsEl.replaceChildren(...report.problems.map(renderProblem));
			} else {
				const empty = document.createElement('li');
				empty.className = 'info-problem info-problem--none';
				empty.textContent = 'Nothing has gone wrong.';
				problemsEl.replaceChildren(empty);
			}
			if (clearBtn) clearBtn.hidden = report.problems.length === 0;
			if (updatedEl) {
				updatedEl.textContent = report.lastGraphShownAt
					? 'Graph updated ' + formatTime(report.lastGraphShownAt)
					: '';
			}
		};

		const isOpen = () => !panel.hidden;

		const refresh = () =>
			webviewApi
				.postMessage({ type: 'get-status' })
				.then((response) => {
					if (!response || response.type !== 'status-report') return;
					report = response.report;
					if (isOpen()) {
						render();
						lastSeenProblemTime = newestProblemTime();
					}
					updateBadge();
				})
				.catch(() => undefined);

		const schedule = () => {
			clearTimeout(pollTimer);
			pollTimer = setTimeout(
				() => {
					void refresh().then(schedule);
				},
				isOpen() ? STATUS_POLL_OPEN_MS : STATUS_POLL_CLOSED_MS
			);
		};

		const runAction = (action) => {
			void webviewApi
				.postMessage({ type: 'status-action', action })
				.catch(() => undefined)
				.then(() => new Promise((resolve) => setTimeout(resolve, 300)))
				.then(refresh);
		};

		const open = () => {
			panel.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
			render();
			void refresh();
			schedule();
		};

		const close = () => {
			panel.hidden = true;
			btn.setAttribute('aria-expanded', 'false');
			schedule();
		};

		btn.addEventListener('click', () => (isOpen() ? close() : open()));

		if (clearBtn) {
			clearBtn.addEventListener('click', () => runAction('clear-problems'));
		}

		document.addEventListener('click', (e) => {
			if (isOpen() && !panel.contains(e.target) && !btn.contains(e.target)) close();
		});

		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape' || !isOpen()) return;
			close();
			btn.focus();
		});

		void refresh();
		schedule();
	};

	const init = () => {
		bindClose();
		bindScopePicker();
		enhanceSelects();
		bindInfoPanel();
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
		return;
	}

	init();
})();
