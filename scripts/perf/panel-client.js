/* Runs in the browser next to the real panel. Stands in for Joplin's webviewApi and drives a scenario. */
(function () {
	var onMessageHandler = null;
	var errors = [];
	var longTasks = [];
	var largestResponse = 0;
	var highestVersion = 0;

	window.addEventListener('error', function (e) {
		errors.push('Panel error: ' + e.message);
	});
	window.addEventListener('unhandledrejection', function (e) {
		errors.push(
			'Panel rejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)
		);
	});
	var realConsoleError = console.error;
	console.error = function () {
		errors.push('Panel console.error: ' + Array.prototype.join.call(arguments, ' '));
		realConsoleError.apply(console, arguments);
	};

	new PerformanceObserver(function (list) {
		list.getEntries().forEach(function (entry) {
			longTasks.push({ at: entry.startTime, duration: Math.round(entry.duration) });
		});
	}).observe({ entryTypes: ['longtask'] });

	window.webviewApi = {
		postMessage: function (message) {
			return fetch('/rpc', { method: 'POST', body: JSON.stringify(message) }).then(function (
				r
			) {
				return r.text().then(function (text) {
					largestResponse = Math.max(largestResponse, text.length);
					var response = JSON.parse(text);
					if (response && response.version)
						highestVersion = Math.max(highestVersion, response.version);
					return response;
				});
			});
		},
		onMessage: function (handler) {
			onMessageHandler = handler;
			(function poll() {
				fetch('/events')
					.then(function (r) {
						return r.json();
					})
					.then(function (messages) {
						messages.forEach(function (message) {
							if (message.version)
								highestVersion = Math.max(highestVersion, message.version);
							// Joplin wraps what the plugin posts in this same way.
							onMessageHandler({ message: message });
						});
						poll();
					})
					.catch(function () {
						setTimeout(poll, 500);
					});
			})();
		},
	};

	function action(body) {
		return fetch('/action', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
			return r.json();
		});
	}

	function wait(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	function waitFor(label, condition, timeoutMs) {
		var started = performance.now();
		return new Promise(function (resolve, reject) {
			(function check() {
				var value;
				try {
					value = condition();
				} catch (e) {
					value = false;
				}
				if (value) {
					resolve(value);
				} else if (performance.now() - started > (timeoutMs || 240000)) {
					reject(new Error('Timed out waiting for: ' + label));
				} else {
					setTimeout(check, 50);
				}
			})();
		});
	}

	function getCy() {
		var container = document.getElementById('graph-container');
		return container && container._cyreg ? container._cyreg.cy : null;
	}

	function text(id) {
		var el = document.getElementById(id);
		if (!el) return '';
		return id.indexOf('stat-') === 0 ? el.textContent.replace(/\D/g, '') : el.textContent;
	}

	var steps = [];

	/** @param expectsPause - a one-off action that produces something, where a brief pause is acceptable and is reported but doesn't count against the budget. */
	function step(name, run, expectsPause) {
		var started = performance.now();
		return action({ type: 'stepStart' })
			.then(run)
			.then(function () {
				return wait(120);
			})
			.then(function () {
				var ended = performance.now();
				var blocks = longTasks.filter(function (task) {
					return task.at >= started && task.at <= ended;
				});
				steps.push({
					name: name,
					expectsPause: !!expectsPause,
					tookMs: Math.round(ended - started - 120),
					worstBlock: blocks.reduce(function (worst, task) {
						return Math.max(worst, task.duration);
					}, 0),
				});
				return action({ type: 'stepEnd', name: name });
			});
	}

	function snapshot(name) {
		var cy = getCy();
		return fetch('/image?name=' + name, {
			method: 'POST',
			body: cy.png({ full: false, bg: '#ffffff', scale: 1 }),
		});
	}

	function measureFrameRate() {
		var cy = getCy();
		var frames = 0;
		var started = performance.now();
		var startZoom = cy.zoom();
		return new Promise(function (resolve) {
			(function frame() {
				frames++;
				var elapsed = performance.now() - started;
				cy.zoom(startZoom * (1 + 0.5 * Math.sin(elapsed / 300)));
				if (elapsed < 2000) {
					requestAnimationFrame(frame);
				} else {
					cy.zoom(startZoom);
					resolve(Math.round((frames * 1000) / elapsed));
				}
			})();
		});
	}

	/**
	 * Delivers a patch straight after a redraw starts, while only part of the graph
	 * is on screen. The patch refers to the last two notes, which aren't drawn yet.
	 */
	function patchDuringDrawing(cy) {
		var nodes = noteNodes(cy).toArray();
		var a = nodes[nodes.length - 1].json();
		var b = nodes[nodes.length - 2].json();
		var edgeId = a.data.id + '::' + b.data.id + '::patched';
		var data = { nodes: [], edges: [] };
		nodes.forEach(function (n) {
			data.nodes.push({ data: n.data(), position: n.position() });
		});

		var version = highestVersion + 1;
		onMessageHandler({
			message: {
				type: 'graph-data',
				nodes: data.nodes,
				edges: data.edges,
				version: version,
				layoutRevision: -1,
				view: patchTestView(),
			},
		});
		expectTrue(
			'Drawing is still under way when the patch arrives',
			cy.nodes().length < data.nodes.length
		);
		onMessageHandler({
			message: {
				type: 'graph-patch',
				version: version + 1,
				view: patchTestView(),
				upsertedNodes: [],
				upsertedEdges: [
					{ data: { id: edgeId, source: a.data.id, target: b.data.id, type: 'link' } },
				],
				removedNodeIds: [],
				removedEdgeIds: [],
			},
		});
		highestVersion = version + 1;

		return waitFor(
			'the patch to be applied after drawing',
			function () {
				return (
					cy.getElementById(edgeId).length === 1 &&
					cy.nodes().length === data.nodes.length
				);
			},
			20000
		)
			.then(function () {
				return catchUpWithPlugin(a.data.id);
			})
			.then(function () {
				return waitFor(
					'the real graph to return',
					function () {
						return cy.getElementById(edgeId).length === 0 && noteNodes(cy).length > 0;
					},
					20000
				);
			});
	}

	/** The made-up versions above ran ahead of the plugin's, so move between views until its versions pass them. */
	function catchUpWithPlugin(noteId) {
		var openOverview = { type: 'open-view', request: { kind: 'auto' } };
		var openNote = { type: 'open-view', request: { kind: 'neighborhood', noteId: noteId } };
		return window.webviewApi
			.postMessage(openOverview)
			.then(function () {
				return window.webviewApi.postMessage(openNote);
			})
			.then(function () {
				return window.webviewApi.postMessage(openOverview);
			});
	}

	function patchTestView() {
		return {
			key: 'patch-test',
			kind: 'notebook',
			summary: 'Patch test',
			totals: { notes: Number(text('stat-notes')), explicit: 0, semantic: 0, tags: 0 },
			isLarge: true,
			isPartial: true,
			canGoBack: false,
			scopeLabel: text('graph-scope-label'),
			notebookTitles: {},
			tagOptions: [],
			activeTag: null,
		};
	}

	function clickById(id) {
		document.getElementById(id).click();
	}

	/** Every control in the panel, against whatever note view is on screen. */
	function testControls(cy) {
		var firstNodeId = noteNodes(cy)[0].id();
		var startPosition = function () {
			return JSON.stringify(cy.getElementById(firstNodeId).position());
		};

		return step('Fit button', function () {
			cy.zoom(cy.zoom() * 3);
			var zoomed = cy.zoom();
			clickById('graph-fit');
			expectTrue('Fit zooms back out', cy.zoom() < zoomed);
			return wait(100);
		})
			.then(function () {
				return step('Hide and show tag edges', function () {
					var toggle = document.querySelector('[data-edge="tag"]');
					var shown = cy.edges('[type="tag"]').length;
					toggle.click();
					expectEqual('Tag edges are hidden', cy.edges('[type="tag"]:visible').length, 0);
					toggle.click();
					expectEqual(
						'Tag edges come back',
						cy.edges('[type="tag"]:visible').length,
						shown
					);
					return wait(50);
				});
			})
			.then(function () {
				return step('Hover cards for a note and for each kind of edge', function () {
					var tooltip = document.querySelector('.graph-tooltip');
					var hover = function (ele) {
						var p = ele.isNode() ? ele.renderedPosition() : ele.renderedMidpoint();
						var box = document
							.getElementById('graph-container')
							.getBoundingClientRect();
						ele.emit({
							type: 'mouseover',
							originalEvent: { clientX: box.left + p.x, clientY: box.top + p.y },
						});
						var shown = tooltip.classList.contains('is-visible');
						var kind = (tooltip.querySelector('.graph-tooltip__kind') || {})
							.textContent;
						ele.emit({ type: 'mouseout' });
						return shown ? kind : null;
					};
					expectTrue('A note shows a hover card', !!hover(noteNodes(cy)[0]));
					['link', 'tag', 'semantic'].forEach(function (type) {
						var edge = cy.edges('[type="' + type + '"]')[0];
						if (edge)
							expectTrue('A ' + type + ' edge shows a hover card', !!hover(edge));
					});
					return wait(50);
				});
			})
			.then(function () {
				return step("What's happening panel", function () {
					var titles = function () {
						return Array.prototype.map.call(
							document.querySelectorAll('#graph-info-items .info-item__title'),
							function (el) {
								return el.textContent;
							}
						);
					};
					clickById('graph-info-btn');
					return waitFor('the status items', function () {
						return titles().length >= 3;
					})
						.then(function () {
							expectEqual(
								'It lists notes, AI and explanations',
								titles().slice(0, 3).join(' | '),
								'Notes | Similar notes (AI) | Connection explanations (AI)'
							);
							expectTrue(
								'It says how many notes are loaded',
								/notes loaded/.test(
									document.querySelector('#graph-info-items .info-item__text')
										.textContent
								)
							);
							return snapshot('4-whats-happening');
						})
						.then(function () {
							document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
							expectTrue(
								'Escape closes it',
								document.getElementById('graph-info-panel').hidden
							);
						});
				});
			})
			.then(function () {
				return step(
					'Focus mode on and off',
					function () {
						var hub = noteNodes(cy).max(function (n) {
							return n.degree();
						}).ele;
						cy.elements().unselect();
						hub.select();
						clickById('graph-focus');
						expectTrue('Focus keeps the selected note visible', hub.visible());
						expectTrue(
							'Focus is on only because it was asked for',
							cy.nodes(':hidden').length > 0
						);
						expectEqual(
							'The panel says why notes are hidden',
							text('graph-view-title').indexOf('Focus is on') !== -1,
							cy.nodes(':hidden').length > 0
						);
						return wait(500).then(function () {
							clickById('graph-focus');
							expectEqual(
								'Leaving focus shows every note',
								cy.nodes(':hidden').length,
								0
							);
							expectEqual(
								'The focus notice goes away',
								text('graph-view-title').indexOf('Focus is on'),
								-1
							);
							cy.elements().unselect();
							return wait(100);
						});
					},
					true
				);
			})
			.then(function () {
				return step(
					'Group by community on',
					function () {
						clickById('graph-group-toggle');
						return waitFor(
							'community boxes',
							function () {
								return cy.nodes('[?isCommunityParent]').length > 0;
							},
							60000
						);
					},
					true
				);
			})
			.then(function () {
				return step(
					'Group by community off',
					function () {
						clickById('graph-group-toggle');
						return waitFor(
							'the boxes to go',
							function () {
								return (
									cy.nodes('[?isCommunityParent]').length === 0 &&
									noteNodes(cy).length > 0
								);
							},
							60000
						);
					},
					true
				);
			})
			.then(function () {
				var before = startPosition();
				return step('Switch to hierarchical layout', function () {
					document.querySelector('[data-layout="hierarchical"]').click();
					return waitFor(
						'new positions',
						function () {
							return (
								cy.getElementById(firstNodeId).length === 1 &&
								startPosition() !== before
							);
						},
						60000
					);
				});
			})
			.then(function () {
				return step('Switch back to fCoSE', function () {
					var hierarchical = startPosition();
					document.querySelector('[data-layout="fcose"]').click();
					return waitFor(
						'the layout to change back',
						function () {
							return (
								cy.getElementById(firstNodeId).length === 1 &&
								startPosition() !== hierarchical
							);
						},
						60000
					);
				});
			})
			.then(function () {
				return step(
					'Export PNG, SVG and JSON',
					function () {
						['png', 'svg', 'json'].forEach(function (format) {
							document
								.querySelector('.export-menu__item[data-format="' + format + '"]')
								.click();
						});
						return wait(200);
					},
					true
				);
			})
			.then(function () {
				if (!window.__AI_ENABLED) return null;
				return step('Confidence slider', function () {
					var slider = document.getElementById('graph-density-slider');
					slider.value = '100';
					slider.dispatchEvent(new Event('input'));
					expectEqual(
						'Full confidence hides weaker semantic edges',
						cy.edges('[type="semantic"][score < 1]:visible').length,
						0
					);
					slider.value = '0';
					slider.dispatchEvent(new Event('input'));
					return wait(50);
				});
			});
	}

	/** Moves through the scopes with the same messages the scope menu sends. Nothing should need reloading. */
	function testScopeChange() {
		var start = Number(text('stat-notes'));
		var setScope = function (mode, ids) {
			return window.webviewApi.postMessage({
				type: 'set-scope',
				mode: mode,
				selectedIds: ids,
			});
		};
		return window.webviewApi.postMessage({ type: 'request-folders' }).then(function (response) {
			return step('Pick another notebook', function () {
				return setScope('selected', [response.folders[1].id]).then(function () {
					return waitFor('the other notebook', function () {
						return text('graph-scope-label') === response.folders[1].title;
					});
				});
			})
				.then(function () {
					return step('Choose all notebooks', function () {
						return setScope('all', []).then(function () {
							if (window.__VAULT_NOTES > 1500) {
								return waitFor('the reason it shows less', function () {
									return (
										text('graph-view-title').indexOf('too large') !== -1 &&
										cy().nodes().length <= 1500
									);
								});
							}
							return waitFor('every note', function () {
								return Number(text('stat-notes')) === window.__VAULT_NOTES + 0;
							});
						});
					});
				})
				.then(function () {
					return step('Back to the current notebook', function () {
						return setScope('current', []).then(function () {
							return waitFor('the first notebook again', function () {
								return (
									Number(text('stat-notes')) === start &&
									text('graph-scope-label') === 'Notebook 0'
								);
							});
						});
					});
				});
		});
	}

	function cy() {
		return getCy();
	}

	function currentNoteCount() {
		return noteNodes(getCy()).length;
	}

	function chooseSelectOption(id, value) {
		var select = document.getElementById(id);
		select.value = value;
		select.dispatchEvent(new Event('change'));
	}

	function setDepth(value) {
		var slider = document.getElementById('graph-depth-slider');
		slider.value = String(value);
		slider.dispatchEvent(new Event('input'));
		slider.dispatchEvent(new Event('change'));
	}

	function goBack() {
		document.getElementById('graph-view-back').click();
		return waitFor('the main view', function () {
			return document.getElementById('graph-view-back').hidden && currentNoteCount() > 0;
		});
	}

	function searchFor(query) {
		var input = document.getElementById('graph-search');
		input.value = query;
		input.dispatchEvent(new Event('input'));
	}

	function testMainViewDetails(graph) {
		var isLarge = window.__VAULT_NOTES > 1500;
		expectTrue('Nodes on screen are within the limit', graph.nodes().length <= 1500);
		expectTrue('Edges on screen are within the limit', graph.edges().length <= 3000);
		expectEqual(
			'The scope is named after the notebook',
			text('graph-scope-label'),
			'Notebook 0'
		);
		expectEqual(
			'All notebooks is offered only on a vault small enough',
			document.querySelector('[data-scope-mode="all"]').hidden,
			isLarge
		);
		expectEqual(
			'Categories stay hidden',
			getComputedStyle(document.getElementById('graph-category-filter')).display,
			'none'
		);
		expectEqual(
			'Group stays hidden',
			getComputedStyle(document.getElementById('graph-group-toggle')).display,
			'none'
		);
		expectTrue(
			'Depth is only offered for connections',
			document.getElementById('graph-depth-control').hidden
		);
		expectEqual(
			'Focus starts off, so the whole notebook shows',
			graph.nodes(':hidden').length,
			0
		);
		expectEqual(
			'The footer has numbers once a graph is showing',
			document.getElementById('stats-bar').classList.contains('stats-bar--empty'),
			false
		);
		expectEqual(
			'The footer sits under the graph, inside the panel',
			document.getElementById('stats-bar').getBoundingClientRect().bottom <= innerHeight + 1,
			true
		);
		expectTrue(
			'The graph fills the space left',
			document.getElementById('graph-container').offsetHeight > 200 && graph.height() > 200
		);
		expectTrue(
			'Notes from other notebooks are on screen',
			graph.nodes('[?outsideScope]').length > 0
		);
		expectEqual(
			'The whole notebook counts, including nested notebooks',
			Number(text('stat-notes')) >=
				currentNoteCount() - graph.nodes('[?outsideScope]').length,
			true
		);
	}

	function testTagFilter(graph) {
		var select = document.getElementById('graph-tag-filter');
		expectTrue('Tags are offered', !select.hidden && select.options.length > 1);
		var tag = select.options[1].value;

		return step('Filter by tag', function () {
			chooseSelectOption('graph-tag-filter', tag);
			return waitFor(
				'only notes with that tag',
				function () {
					var nodes = noteNodes(graph);
					return (
						nodes.length > 0 &&
						nodes.every(function (n) {
							return (n.data('tagNames') || '').split('\n').indexOf(tag) !== -1;
						})
					);
				},
				60000
			);
		}).then(function () {
			expectEqual('The filter stays chosen', select.value, tag);
			expectTrue('The summary names the tag', text('graph-view-title').indexOf(tag) !== -1);
			return step('Clear the tag filter', function () {
				var filtered = currentNoteCount();
				chooseSelectOption('graph-tag-filter', '');
				return waitFor(
					'the notes without that tag',
					function () {
						return currentNoteCount() > filtered;
					},
					60000
				);
			});
		});
	}

	function testColors(graph) {
		var inside = function () {
			return graph.nodes('[!outsideScope]')[0];
		};
		var outside = function () {
			return graph.nodes('[?outsideScope]')[0];
		};
		var communityColor = inside().style('background-color');

		return step('Colour by notebook', function () {
			chooseSelectOption('graph-color-by', 'notebook');
			expectTrue(
				'Different notebooks get different colours',
				inside().style('background-color') !== outside().style('background-color')
			);
			return wait(50);
		})
			.then(function () {
				return step('Colour by search', function () {
					chooseSelectOption('graph-color-by', 'search');
					searchFor(inside().data('label').substring(0, 40));
					return waitFor('the match to be coloured', function () {
						return graph.nodes().some(function (n) {
							return n.style('background-color') === 'rgb(255,165,0)';
						});
					}).then(function () {
						expectEqual(
							'Colouring by search dims nothing',
							noteNodes(graph).filter(function (n) {
								return n.style('opacity') !== '1';
							}).length,
							0
						);
						clearSearchBox();
						return wait(500);
					});
				});
			})
			.then(function () {
				return step('Colour by connections', function () {
					chooseSelectOption('graph-color-by', 'community');
					expectEqual(
						'The original colours come back',
						inside().style('background-color'),
						communityColor
					);
					return wait(50);
				});
			});
	}

	function clearSearchBox() {
		searchFor('');
	}

	function testOutsideNote(graph) {
		return step('Click a note from another notebook', function () {
			return waitFor('a note from another notebook', function () {
				return graph.nodes('[?outsideScope]').length > 0;
			}).then(function () {
				graph.nodes('[?outsideScope]')[0].emit('tap');
				return waitFor('its connections', function () {
					return text('graph-view-title').indexOf('Connections of') === 0;
				});
			});
		}).then(function () {
			expectEqual(
				'Its connections are not marked outside',
				graph.nodes('[?outsideScope]').length,
				0
			);
			return step('Back to the notebook', goBack);
		});
	}

	function testMovingNotebooks() {
		var start = Number(text('stat-notes'));
		var callsBefore = 0;
		return action({ type: 'none' })
			.then(function (result) {
				callsBefore = result.calls;
				return step('Move to another notebook', function () {
					return action({ type: 'selectNotebook', index: 1 }).then(function () {
						return waitFor('the other notebook', function () {
							return (
								text('graph-scope-label') === 'Notebook 1' &&
								Number(text('stat-notes')) !== start
							);
						});
					});
				});
			})
			.then(function () {
				return action({ type: 'none' });
			})
			.then(function (result) {
				expectTrue(
					'Moving notebooks reads no notes again, only ' +
						(result.calls - callsBefore) +
						' calls',
					result.calls - callsBefore < 40
				);
				return step('Move back', function () {
					return action({ type: 'selectNotebook', index: 0 }).then(function () {
						return waitFor('the first notebook', function () {
							return text('graph-scope-label') === 'Notebook 0';
						});
					});
				});
			});
	}

	function testOpenNoteHighlight(graph) {
		var candidates = noteNodes(graph).filter(function (n) {
			return !n.data('outsideScope');
		});
		var noteId = candidates[candidates.length - 1].id();
		return step('Open another note in Joplin', function () {
			return action({ type: 'selectNote', noteId: noteId }).then(function () {
				return waitFor('the note to be highlighted', function () {
					var selected = graph.nodes(':selected');
					return selected.length === 1 && selected[0].id() === noteId;
				});
			});
		}).then(function () {
			expectEqual('Opening a note hides nothing', graph.nodes(':hidden').length, 0);
		});
	}

	function testToast() {
		return step('A status over the graph is a passing notice', function () {
			onMessageHandler({ message: { type: 'status', text: 'Passing notice' } });
			var toast = document.getElementById('graph-toast');
			expectEqual('It shows as a toast', toast.hidden, false);
			expectEqual('It says what was sent', toast.textContent, 'Passing notice');
			expectTrue(
				'It does not sit over the notes',
				getComputedStyle(document.getElementById('graph-status')).display === 'none' ||
					text('graph-status') !== 'Passing notice'
			);
			toast.hidden = true;
			return wait(50);
		});
	}

	function testDepth(graph) {
		return step('Depth 1', function () {
			var atTwo = graph.nodes().length;
			setDepth(1);
			return waitFor('fewer notes', function () {
				return graph.nodes().length <= atTwo && text('graph-depth-value') === '1';
			}).then(function () {
				return wait(1000);
			});
		})
			.then(function () {
				var atOne = graph.nodes().length;
				return step('Depth 3', function () {
					setDepth(3);
					return waitFor(
						'more notes',
						function () {
							return graph.nodes().length > atOne;
						},
						30000
					);
				});
			})
			.then(function () {
				expectTrue('Depth 3 stays within the limit', graph.nodes().length <= 300);
				return step('Depth back to 2', function () {
					setDepth(2);
					return wait(1000);
				});
			});
	}

	function testContextMenu(graph) {
		return step('Right-click, then Show connections', function () {
			var node = noteNodes(graph)[0];
			node.emit({
				type: 'cxttap',
				originalEvent: { preventDefault: function () {}, clientX: 40, clientY: 40 },
			});
			var menu = document.querySelector('.graph-context-menu');
			expectTrue('The menu opens', !menu.hidden);
			menu.querySelector('[data-action="connections"]').click();
			return waitFor('its connections', function () {
				return text('graph-view-title').indexOf('Connections of') === 0;
			});
		}).then(function () {
			return step('Back from the connections', goBack);
		});
	}

	function testPanelUsability(graph) {
		return step('Keyboard and picker', function () {
			var escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
			clickById('graph-scope-btn');
			expectEqual(
				'The scope menu opens',
				document.getElementById('graph-scope-menu').hidden,
				false
			);
			clickById('graph-scope-select-toggle');
			return waitFor('the notebook list', function () {
				return document.querySelectorAll('.panel-header__scope-checkbox-row').length > 0;
			}).then(function () {
				expectEqual(
					'A nested notebook is indented',
					Array.prototype.some.call(
						document.querySelectorAll('.panel-header__scope-checkbox-row'),
						function (row) {
							return parseInt(row.style.paddingLeft, 10) > 9;
						}
					),
					true
				);
				expectEqual(
					'Nothing chosen means nothing to apply',
					document.getElementById('graph-scope-apply').disabled,
					true
				);
				var filter = document.getElementById('graph-scope-filter');
				filter.value = 'Notebook 3';
				filter.dispatchEvent(new Event('input'));
				expectEqual(
					'The filter narrows the list',
					document.querySelectorAll('.panel-header__scope-checkbox-row').length,
					1
				);
				filter.value = '';
				filter.dispatchEvent(new Event('input'));
				document.dispatchEvent(escape);
				expectEqual(
					'Escape closes the menu',
					document.getElementById('graph-scope-menu').hidden,
					true
				);

				var pill = document.querySelector('[data-edge="tag"]');
				pill.click();
				expectEqual(
					'A toggle reports its state',
					pill.getAttribute('aria-pressed'),
					'false'
				);
				pill.click();

				if (!window.__AI_ENABLED) {
					expectEqual(
						'Similar is not offered without AI',
						getComputedStyle(document.querySelector('[data-edge="semantic"]')).display,
						'none'
					);
				}
				return wait(50);
			});
		})
			.then(function () {
				return step('Enter straight after typing opens the top result', function () {
					searchFor('Note 30 about');
					document
						.getElementById('graph-search')
						.dispatchEvent(
							new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
						);
					return waitFor('the connections', function () {
						return text('graph-view-title').indexOf('Connections of') === 0;
					});
				});
			})
			.then(function () {
				return step('Back after the quick Enter', goBack);
			})
			.then(function () {
				return step('Enter opens the top search result', function () {
					searchFor('Note 20 about');
					return waitFor('results', function () {
						return visibleSearchResults() > 0;
					}).then(function () {
						document
							.getElementById('graph-search')
							.dispatchEvent(
								new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
							);
						return waitFor('the connections', function () {
							return text('graph-view-title').indexOf('Connections of') === 0;
						});
					});
				});
			})
			.then(function () {
				return step('Back after Enter', goBack);
			})
			.then(function () {
				return graph;
			});
	}

	/** The last search's results stay in the page while hidden, so only visible ones count. */
	function visibleSearchResults() {
		var list = document.querySelector('.graph-search-results');
		return list && !list.hidden
			? list.querySelectorAll('.graph-search-results__item').length
			: 0;
	}

	function expectEqual(label, actual, expected) {
		if (actual !== expected) errors.push(label + ': expected ' + expected + ', got ' + actual);
	}

	function expectTrue(label, value) {
		if (!value) errors.push(label + ' was not true');
	}

	function noteNodes(cy) {
		return cy.nodes().filter(function (n) {
			return !n.data('isCommunityParent');
		});
	}

	function positionsOf(cy) {
		var positions = {};
		cy.nodes().forEach(function (n) {
			positions[n.id()] = JSON.stringify(n.position());
		});
		return positions;
	}

	window.__runScenario = function () {
		var cy;
		var expectedNotes;
		var frameRate;

		step('First graph on screen', function () {
			return waitFor('the first graph', function () {
				var c = getCy();
				return c && c.edges().length > 0 && Number(text('stat-notes')) > 0;
			}).then(function () {
				cy = getCy();
				expectedNotes = Number(text('stat-notes'));
			});
		})
			.then(function () {
				return snapshot('1-first-graph');
			})
			.then(function () {
				if (!window.__AI_ENABLED) return null;
				return step('Semantic edges arrive', function () {
					return waitFor('semantic edges', function () {
						return Number(text('stat-semantic')) > 0;
					});
				}).then(function () {
					return snapshot('1b-with-semantic');
				});
			})
			.then(function () {
				testMainViewDetails(cy);

				var nodes = cy.nodes().toArray();
				var spread = {};
				nodes.forEach(function (n) {
					spread[Math.round(n.position().x) + ',' + Math.round(n.position().y)] = true;
				});
				expectTrue(
					'Nodes have distinct positions',
					Object.keys(spread).length > nodes.length * 0.9
				);

				return measureFrameRate().then(function (fps) {
					frameRate = fps;
				});
			})
			.then(function () {
				if (cy.nodes().length <= 300) return null;
				return step('Patch arrives while drawing', function () {
					return patchDuringDrawing(cy);
				});
			})
			.then(function () {
				return snapshot('2-notebook');
			})
			.then(function () {
				return step('Search across all notes', function () {
					searchFor('Note 10 about');
					return waitFor('search results', function () {
						return visibleSearchResults() > 0;
					});
				});
			})
			.then(function () {
				return step('Open a search result', function () {
					document.querySelector('.graph-search-results__item').click();
					return waitFor('the connections', function () {
						return (
							text('graph-view-title').indexOf('Connections of') === 0 &&
							noteNodes(cy).length > 0
						);
					});
				});
			})
			.then(function () {
				expectTrue(
					'Results close after choosing one',
					document.querySelector('.graph-search-results').hidden
				);
				expectEqual(
					'Choosing a result clears the search',
					document.getElementById('graph-search').value,
					''
				);
				expectTrue('The chosen note is selected', cy.nodes(':selected').length === 1);
				expectEqual(
					'Nothing is left dimmed by the search',
					noteNodes(cy).filter(function (n) {
						return n.style('opacity') !== '1';
					}).length,
					0
				);
				expectTrue(
					'Depth is offered for connections',
					!document.getElementById('graph-depth-control').hidden
				);
				expectTrue(
					'The tag filter is not offered for connections',
					document.getElementById('graph-tag-filter').hidden
				);
				return snapshot('3-connections');
			})
			.then(function () {
				return testDepth(cy);
			})
			.then(function () {
				return step('Open a note by clicking', function () {
					noteNodes(cy)[0].emit('tap');
					return wait(100);
				});
			})
			.then(function () {
				return step('Back to the notebook', goBack);
			})
			.then(function () {
				expectEqual(
					'The back button hides again',
					document.getElementById('graph-view-back').hidden,
					true
				);
				return testOutsideNote(cy);
			})
			.then(function () {
				return testContextMenu(cy);
			})
			.then(function () {
				return testPanelUsability(cy);
			})
			.then(function () {
				return testOpenNoteHighlight(cy);
			})
			.then(function () {
				return testToast();
			})
			.then(function () {
				return testTagFilter(cy);
			})
			.then(function () {
				return testColors(cy);
			})
			.then(function () {
				return snapshot('4-after-colours');
			})
			.then(function () {
				return testMovingNotebooks();
			})
			.then(function () {
				return testControls(cy);
			})
			.then(function () {
				var before = positionsOf(cy);
				var nodeCount = cy.nodes().length;
				return step('Edit note text only', function () {
					return action({ type: 'editNote', index: 5, kind: 'text' }).then(function () {
						return wait(1500);
					});
				}).then(function () {
					expectEqual('A text edit keeps the node count', cy.nodes().length, nodeCount);
					expectEqual(
						'A text edit moves nothing',
						JSON.stringify(positionsOf(cy)),
						JSON.stringify(before)
					);
				});
			})
			.then(function () {
				var before = positionsOf(cy);
				return step('Rename a note', function () {
					return action({ type: 'editNote', index: 6, kind: 'title' }).then(function () {
						return wait(4000);
					});
				}).then(function () {
					var after = positionsOf(cy);
					var moved = Object.keys(before).filter(function (id) {
						return after[id] && after[id] !== before[id];
					});
					expectEqual('A rename moves no node already shown', moved.length, 0);
				});
			})
			.then(function () {
				return step('Create a note', function () {
					return action({ type: 'createNote', index: 1 }).then(function () {
						return waitFor(
							'the new note in the totals',
							function () {
								return Number(text('stat-notes')) === expectedNotes + 1;
							},
							30000
						);
					});
				});
			})
			.then(function () {
				return step('Delete a note', function () {
					return action({ type: 'deleteNote', index: -1 }).then(function () {
						return waitFor(
							'the deleted note in the totals',
							function () {
								return Number(text('stat-notes')) === expectedNotes;
							},
							30000
						);
					});
				});
			})
			.then(function () {
				return wait(300);
			})
			.then(function () {
				return testScopeChange();
			})
			.then(function () {
				return wait(300);
			})
			.then(function () {
				return snapshot('5-final');
			})
			.catch(function (e) {
				errors.push('Scenario failed: ' + e.message);
			})
			.then(function () {
				return fetch('/report', {
					method: 'POST',
					body: JSON.stringify({
						steps: steps,
						errors: errors,
						frameRate: frameRate,
						largestResponse: largestResponse,
						longTasks: longTasks,
					}),
				});
			});
	};
})();
