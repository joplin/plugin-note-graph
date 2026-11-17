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
			row.style.paddingLeft = 8 + depth * 12 + 'px';
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
		'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.5l5 5L19.5 7"/></svg>';
	const FILTER_FROM_OPTIONS = 10;

	/**
	 * Draws a native <select> as a menu in the panel's own style. The <select> stays
	 * the source of truth, so code that sets its value or options keeps working.
	 */
	const enhanceSelect = (select) => {
		const wrapper = select.closest('.graph-dropdown');
		const button = wrapper.querySelector('.graph-dropdown__button');
		const valueEl = wrapper.querySelector('.graph-dropdown__value');
		const menu = wrapper.querySelector('.graph-dropdown__menu');
		select.tabIndex = -1;
		select.setAttribute('aria-hidden', 'true');

		const sync = () => {
			const selected = select.options[select.selectedIndex] || select.options[0];
			valueEl.textContent = selected ? selected.textContent : '';
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
					const check = document.createElement('span');
					check.className = 'graph-dropdown__check';
					check.innerHTML = CHECK_SVG;
					item.appendChild(check);
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

	const STATUS_ICONS = {
		ok: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7.5 12.5l3 3 6-6.5"/></svg>',
		attention:
			'<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 7v6M12 16.5v.01"/></svg>',
		off: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M8 12h8"/></svg>',
	};

	const statusIcon = (item) => {
		if (item.level === 'working') return '<span class="spinner"></span>';
		if (item.continuesInBackground) return '<span class="spinner spinner--paused"></span>';
		return STATUS_ICONS[item.level] || STATUS_ICONS.off;
	};

	const element = (tag, className, text) => {
		const el = document.createElement(tag);
		el.className = className;
		if (text !== undefined) el.textContent = text;
		return el;
	};

	const bindInfoPanel = () => {
		const btn = document.getElementById('graph-info-btn');
		const panel = document.getElementById('graph-info-panel');
		const labelEl = document.getElementById('graph-info-label');
		const itemsEl = document.getElementById('graph-info-items');
		const problemsEl = document.getElementById('graph-info-problems');
		const problemsItemEl = document.getElementById('graph-info-problems-item');
		const problemsIconEl = document.getElementById('graph-info-problems-icon');
		const clearBtn = document.getElementById('graph-info-clear');
		const updatedEl = document.getElementById('graph-info-updated');
		if (
			!btn ||
			!panel ||
			!labelEl ||
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

		const updatePill = () => {
			if (!report) return;
			const needsAttention =
				report.level === 'attention' || newestProblemTime() > lastSeenProblemTime;
			const label = needsAttention ? 'Needs attention' : report.summary;
			btn.classList.toggle('status-pill--attention', needsAttention);
			btn.classList.toggle(
				'status-pill--working',
				!needsAttention && report.level === 'working'
			);
			labelEl.textContent = label;
			btn.setAttribute('aria-label', 'Graph status: ' + label);
		};

		const renderMetric = (metric) => {
			const el = element('span', 'info-item__metric');
			el.append(element('b', '', metric.value), ' ' + metric.label);
			return el;
		};

		const renderBar = (fraction) => {
			const bar = element('div', 'info-item__bar');
			const fill = element('span', 'info-item__bar-fill');
			fill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
			bar.append(fill);
			return bar;
		};

		const renderItem = (item) => {
			const li = element('li', 'info-item info-item--' + item.level);
			const icon = element('span', 'info-item__icon');
			icon.innerHTML = statusIcon(item);
			const body = element('div', 'info-item__body');
			const head = element('div', 'info-item__head');
			head.append(element('span', 'info-item__title', item.title));
			if (item.usesAi) head.append(element('span', 'ai-badge', 'AI'));
			if (item.metric) head.append(renderMetric(item.metric));
			body.append(head);
			if (item.metric && typeof item.metric.fraction === 'number') {
				body.append(renderBar(item.metric.fraction));
			}
			body.append(element('div', 'info-item__text', item.text));
			if (item.action) {
				const action = element('button', 'info-item__action', item.action.label);
				action.type = 'button';
				action.addEventListener('click', () => runAction(item.action.id));
				body.append(action);
			}
			li.append(icon, body);
			return li;
		};

		const renderProblem = (problem) => {
			const li = element('li', 'info-problem info-problem--' + problem.level);
			li.append(
				element('span', 'info-problem__time', formatTime(problem.time)),
				element('span', 'info-problem__text', problem.text)
			);
			if (problem.count > 1) {
				const repeats = element('span', 'info-problem__count', '×' + problem.count);
				repeats.title = 'Happened ' + problem.count + ' times in a row';
				li.append(repeats);
			}
			return li;
		};

		const renderProblems = () => {
			const hasProblems = report.problems.length > 0;
			if (hasProblems) {
				problemsEl.replaceChildren(...report.problems.map(renderProblem));
			} else {
				problemsEl.replaceChildren(
					element('li', 'info-problem info-problem--none', 'Nothing has gone wrong.')
				);
			}
			if (problemsItemEl && problemsIconEl) {
				problemsItemEl.classList.toggle('info-item--ok', !hasProblems);
				problemsItemEl.classList.toggle('info-item--attention', hasProblems);
				problemsIconEl.innerHTML = hasProblems ? STATUS_ICONS.attention : STATUS_ICONS.ok;
			}
			if (clearBtn) clearBtn.hidden = !hasProblems;
		};

		const render = () => {
			if (!report) return;
			itemsEl.replaceChildren(...report.items.map(renderItem));
			renderProblems();
			if (updatedEl) {
				updatedEl.textContent = report.lastGraphShownAt
					? 'Updated ' + formatTime(report.lastGraphShownAt)
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
					updatePill();
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

		document.addEventListener('note-graph-activity', () => void refresh());

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
