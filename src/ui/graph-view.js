import cytoscape from 'cytoscape';
import svg from 'cytoscape-svg';
import {
	computeClientPatch,
	decideUpdate,
	isOutdated,
	isWholesaleChange,
} from './graphUpdatePolicy';

cytoscape.use(svg);

var LAYOUT_FCOSE = 'fcose';
var LAYOUT_HIERARCHICAL = 'hierarchical';
var currentLayoutName = LAYOUT_FCOSE;

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var CARD_OFFSET_X = 18;
var CARD_OFFSET_Y = 5;

function positionTooltip(point) {
	if (!tooltipEl) return;
	var width = tooltipEl.offsetWidth;
	var height = tooltipEl.offsetHeight;
	var vw = window.innerWidth;
	var vh = window.innerHeight;

	var left = point.x + CARD_OFFSET_X;
	if (left + width > vw) left = point.x - width - CARD_OFFSET_X;

	var top = point.y + CARD_OFFSET_Y;
	if (top + height > vh) top = point.y - height - CARD_OFFSET_Y;

	tooltipEl.style.left = Math.max(4, Math.min(left, vw - width - 4)) + 'px';
	tooltipEl.style.top = Math.max(4, Math.min(top, vh - height - 4)) + 'px';
}

var cy;
var statusEl;
var tooltipEl;
var nodeStats;
var pipelineProgressEl;
var pipelineProgressFillEl;
var pipelineProgressLabelEl;
var pipelineProgressCancelEl;
var hasRenderedOnce = false;
var lastSeenVersion = 0;
var categoryFilterEl;
var tagFilterEl;
var currentTagOptionsKey = null;
var colorBy = 'none';
var depthControlEl;
var depthSliderEl;
var depthValueEl;
var depthLessEl;
var depthMoreEl;
var currentDepth = 2;
var focusHidesNotes = false;
var toastTimer = null;
var TOAST_DURATION_MS = 6000;
var FOCUS_NOTICE = 'Focus is on: only notes near the selected one show.';
var currentSearchQuery = '';
var searchBorderTimer = null;
var densitySliderEl;
var densityValueEl;
var densityControlEl;
var currentMinConfidence = 0;
var edgeTypeOff = {};
var focusBtnEl;
var focusActive = false;
var pendingFocusNoteId = null;
var openNoteId = null;
var graphNotice = null;
var currentView = null;
var currentTotals = null;
var currentLayoutRevision = null;
var lowDetail = false;
var viewBarEl;
var viewBackEl;
var viewBackLabelEl;
var viewTitleEl;
var centerNoteLabel = '';
var searchResultsEl;
var searchRequestId = 0;
var openTopResultWhenShown = false;
var updateGroupToggleAvailability = function () {};
var showLayoutChoice = function () {};
/** The plugin's copy of the view choices, as this page last had it. */
var sharedChoices = null;

/** Above these, dropping curves, dashes and arrows keeps panning and zooming smooth. */
var LOW_DETAIL_NODES = 800;
var LOW_DETAIL_EDGES = 600;
var ELEMENTS_PER_RENDER_SLICE = 150;
var FIT_PADDING = 70;
/** Keeps a view of only a few notes from filling the whole panel. */
var MAX_FIT_ZOOM = 1.6;
var BASE_LABEL_SIZE = 10;
var MAX_LABEL_SIZE = 30;
var labelSize = BASE_LABEL_SIZE;
var fitZoom = 1;
var lastFit = null;
var MAX_STEADY_GROWTH = 1.8;
var MAX_ARROW_SCALE = 1.6;
var ARROW_SCALE_AT_FULL_ZOOM = 0.8;
var SELECTED_LABEL_RENDERED_SIZE = 11;
var MAX_SELECTED_LABEL_SIZE = 240;
/** Below this much panel area per note, labels would run into each other, so they wait for zooming in. */
var MIN_AREA_PER_LABEL = 6000;
var AREA_PER_FULL_SIZE_LABEL = 17000;
var STEADY_LABEL_PIXELS = 11;
var MIN_STEADY_LABEL_PIXELS = 9;
var LABEL_LINE_CHARS = 18;
var LABEL_MAX_LINES = 3;
var LABEL_WIDTH_IN_FONT_SIZES = 14;
var wrappedLabels = new Map();
var currentRenderId = 0;
var renderInProgress = false;
var patchesAwaitingRender = [];
var elementsAreHidden = false;
var nodeFilterStylesApplied = false;

function focusNeighborhoodOf(node) {
	var hood = node.closedNeighborhood().add(node.neighborhood().nodes().neighborhood());
	return hood.add(hood.ancestors());
}

function applyVisibility() {
	if (!cy) return;

	var focusHood = null;
	if (focusActive) {
		var sel = cy.nodes(':selected');
		if (sel.length > 0) focusHood = focusNeighborhoodOf(sel);
	}

	setFocusHidesNotes(!!focusHood && focusHood.nodes().length < cy.nodes().length);

	var showEverything = !focusHood && currentMinConfidence === 0 && !isAnyEdgeTypeOff();
	if (showEverything && !elementsAreHidden) return;
	elementsAreHidden = !showEverything;

	cy.batch(function () {
		cy.nodes().forEach(function (n) {
			setElementHidden(n, !!focusHood && !focusHood.has(n));
		});

		cy.edges().forEach(function (e) {
			var type = e.data('type');
			var filtered =
				!!edgeTypeOff[type] ||
				(type === 'semantic' &&
					typeof e.data('score') === 'number' &&
					e.data('score') < currentMinConfidence);
			var hiddenByFocus = focusHood ? !focusHood.has(e) : false;
			setElementHidden(e, filtered || hiddenByFocus);
		});
	});
}

/** Restyling an element is costly, so this only touches those whose state really changes. */
function setElementHidden(ele, hidden) {
	if (!!ele.scratch('_noteGraphHidden') === hidden) return;
	ele.scratch('_noteGraphHidden', hidden);
	if (hidden) ele.hide();
	else ele.show();
}

function isAnyEdgeTypeOff() {
	return Object.keys(edgeTypeOff).some(function (type) {
		return edgeTypeOff[type];
	});
}

function focusTarget() {
	var selected = cy.nodes(':selected');
	return selected.length > 0 || !openNoteId ? selected : cy.getElementById(openNoteId);
}

function engageFocusMode() {
	if (!cy || focusActive) return;
	var target = focusTarget();
	if (target.empty()) return;
	target.select();
	focusActive = true;
	showFocusState();
	applyVisibility();
	cy.animate({ fit: { eles: focusNeighborhoodOf(target), padding: 50 }, duration: 400 });
}

function highlightNodeBeforeLayout(noteId) {
	var node = cy.getElementById(noteId);
	if (!node || node.empty()) return false;
	cy.elements().unselect();
	node.select();
	return true;
}

function fitViewportToFocus() {
	if (!cy) return;
	if (focusActive) {
		var sel = cy.nodes(':selected');
		if (sel.length > 0) {
			cy.fit(focusNeighborhoodOf(sel), 40);
			return;
		}
	}
	fitToNodePositions();
}

/** cy.fit would measure every label to find the graph's bounds, which on a large view holds the UI thread for over half a second. Positions are enough. */
function fitToNodePositions() {
	if (!cy) return;
	var target = viewportForNodes(cy.nodes());
	if (target) {
		cy.viewport(target);
		lastFit = target;
		keepSizesSteadyAt(target.zoom, cy.nodes().length);
	}
}

function viewIsAsFitted() {
	if (!lastFit) return false;
	var pan = cy.pan();
	return (
		Math.abs(cy.zoom() - lastFit.zoom) < 0.0001 &&
		Math.abs(pan.x - lastFit.pan.x) < 0.5 &&
		Math.abs(pan.y - lastFit.pan.y) < 0.5
	);
}

/**
 * A fit can land on any zoom: far in for a handful of notes, far out for a full notebook.
 * Dots, lines and names are sized against that zoom, so they look the same in either.
 */
function keepSizesSteadyAt(zoom, noteCount) {
	var areaPerNote = (cy.width() * cy.height()) / Math.max(1, noteCount);
	var wantedLabel =
		lowDetail || areaPerNote < MIN_AREA_PER_LABEL
			? BASE_LABEL_SIZE
			: Math.min(
					MAX_LABEL_SIZE,
					Math.round((steadyLabelPixels(areaPerNote) / zoom) * 10) / 10
			  );
	if (wantedLabel === labelSize && Math.abs(zoom - fitZoom) < 0.01 * fitZoom) return;
	labelSize = wantedLabel;
	fitZoom = zoom;
	(lowDetail ? cy.nodes() : cy.elements()).updateStyle();
}

function steadyLabelPixels(areaPerNote) {
	var share = Math.sqrt(areaPerNote / AREA_PER_FULL_SIZE_LABEL);
	return Math.max(
		MIN_STEADY_LABEL_PIXELS,
		Math.min(STEADY_LABEL_PIXELS, STEADY_LABEL_PIXELS * share)
	);
}

function steady(pixels) {
	return Math.min(pixels * MAX_STEADY_GROWTH, pixels / fitZoom);
}

function steadyLength(pixels) {
	return function () {
		return steady(pixels);
	};
}

function steadyDashes(dash, gap) {
	return function () {
		return [steady(dash), steady(gap)];
	};
}

function arrowScale() {
	return Math.min(MAX_ARROW_SCALE, ARROW_SCALE_AT_FULL_ZOOM / fitZoom);
}

function labelFontSize() {
	return labelSize;
}

function labelMaxWidth() {
	return labelSize * LABEL_WIDTH_IN_FONT_SIZES;
}

function shortenLine(line) {
	return line.length > LABEL_LINE_CHARS ? line.slice(0, LABEL_LINE_CHARS - 1) + '\u2026' : line;
}

function wrapLabel(label) {
	var lines = [];
	var line = '';
	label.split(/\s+/).forEach(function (word) {
		var longer = line ? line + ' ' + word : word;
		if (!line || longer.length <= LABEL_LINE_CHARS) {
			line = longer;
		} else {
			lines.push(line);
			line = word;
		}
	});
	if (line) lines.push(line);
	if (lines.length > LABEL_MAX_LINES) {
		lines = lines.slice(0, LABEL_MAX_LINES);
		lines[LABEL_MAX_LINES - 1] =
			lines[LABEL_MAX_LINES - 1].slice(0, LABEL_LINE_CHARS - 1) + '\u2026';
	}
	return lines.map(shortenLine).join('\n');
}

function nodeLabel(ele) {
	var label = ele.data('label') || '';
	if (!wrappedLabels.has(label)) wrappedLabels.set(label, wrapLabel(label));
	return wrappedLabels.get(label);
}

/** The open note's name stays the same size on screen at any zoom, so its place in the graph is never lost. */
function selectedLabelSize() {
	return Math.min(MAX_SELECTED_LABEL_SIZE, SELECTED_LABEL_RENDERED_SIZE / cy.zoom());
}

function selectedLabelMaxWidth() {
	return selectedLabelSize() * 14;
}

function selectedLabelOutline() {
	return selectedLabelSize() / 5;
}

function viewportForNodes(nodes) {
	return viewportForPositions(
		nodes.map(function (n) {
			return n.position();
		})
	);
}

function viewportForPositions(positions) {
	if (positions.length === 0) return null;

	var minX = Infinity;
	var minY = Infinity;
	var maxX = -Infinity;
	var maxY = -Infinity;
	positions.forEach(function (p) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	});

	// A fixed margin would leave a narrow panel with hardly any room for the graph.
	var padding = Math.min(FIT_PADDING, 16 + Math.min(cy.width(), cy.height()) * 0.08);
	var usableWidth = Math.max(1, cy.width() - padding * 2);
	var usableHeight = Math.max(1, cy.height() - padding * 2);
	var zoom = Math.min(
		MAX_FIT_ZOOM,
		usableWidth / Math.max(1, maxX - minX),
		usableHeight / Math.max(1, maxY - minY)
	);
	return {
		zoom: zoom,
		pan: {
			x: cy.width() / 2 - ((minX + maxX) / 2) * zoom,
			y: cy.height() / 2 - ((minY + maxY) / 2) * zoom,
		},
	};
}

function disengageFocusMode() {
	if (!cy || !focusActive) return;
	focusActive = false;
	showFocusState();
	applyVisibility();
	fitToNodePositions();
	updateFocusAvailability();
}

/** Marks the open note and brings it into view, without hiding the rest of the graph. A focus the user turned on stays where they put it. */
function highlightOpenNote(noteId) {
	if (!cy) return false;
	var node = cy.getElementById(noteId);
	if (!node || node.empty()) return false;
	if (focusActive) return true;
	cy.elements().unselect();
	node.select();
	if (canvasHasSize() && !isOnScreen(node)) {
		cy.animate({ center: { eles: node }, duration: 300 });
	}
	return true;
}

/** Cytoscape's size is zero while the view is hidden, and stays zero until the resize after it is shown, which refits. */
function canvasHasSize() {
	return cy.width() > 0 && cy.height() > 0;
}

function containerHasSize() {
	var container = cy.container();
	return container.clientWidth > 0 && container.clientHeight > 0;
}

function isOnScreen(node) {
	var p = node.renderedPosition();
	return p.x >= 0 && p.y >= 0 && p.x <= cy.width() && p.y <= cy.height();
}

function isConnectionsView() {
	return !!currentView && currentView.kind === 'neighborhood';
}

function showFocusState() {
	if (!focusBtnEl) return;
	focusBtnEl.classList.toggle(
		'legend-panel__action-btn--active',
		focusActive || isConnectionsView()
	);
}

/** Focus needs a note to focus on. */
function updateFocusAvailability() {
	if (!focusBtnEl || !cy) return;
	focusBtnEl.disabled = !focusActive && !isConnectionsView() && focusTarget().empty();
}

function resolvePendingFocus() {
	if (!pendingFocusNoteId || !cy) return;
	var noteId = pendingFocusNoteId;
	if (highlightOpenNote(noteId)) {
		pendingFocusNoteId = null;
	}
}

var COMMUNITY_PARENT_PREFIX = 'community::';
var groupByCommunityEnabled = false;

function communityParentId(community) {
	return COMMUNITY_PARENT_PREFIX + community;
}

function applyCommunityGrouping() {
	if (!cy) return;
	var realNodes = cy.nodes().filter(function (n) {
		return !n.data('isCommunityParent');
	});

	if (!groupByCommunityEnabled) {
		cy.batch(function () {
			realNodes.forEach(function (n) {
				if (n.parent().nonempty()) n.move({ parent: null });
			});
			cy.nodes()
				.filter(function (n) {
					return n.data('isCommunityParent');
				})
				.remove();
		});
		return;
	}

	var communityCounts = {};
	realNodes.forEach(function (n) {
		var community = n.data('community') || 0;
		communityCounts[community] = (communityCounts[community] || 0) + 1;
	});

	var presentParentIds = {};
	cy.batch(function () {
		Object.keys(communityCounts).forEach(function (community) {
			if (communityCounts[community] <= 1) return;
			var parentId = communityParentId(community);
			presentParentIds[parentId] = true;
			var label = 'Cluster (' + communityCounts[community] + ')';
			var existing = cy.getElementById(parentId);
			if (existing && existing.length) {
				existing.data('label', label);
			} else {
				cy.add({ data: { id: parentId, label: label, isCommunityParent: true } });
			}
		});

		cy.nodes()
			.filter(function (n) {
				return n.data('isCommunityParent') && !presentParentIds[n.id()];
			})
			.remove();

		realNodes.forEach(function (n) {
			var community = n.data('community') || 0;
			if (communityCounts[community] <= 1) {
				if (n.parent().nonempty()) n.move({ parent: null });
				return;
			}
			var wantedParentId = communityParentId(community);
			if (n.parent().id() !== wantedParentId) {
				n.move({ parent: wantedParentId });
			}
		});
	});
}

function refreshDensityControlVisibility() {
	if (!densityControlEl) return;
	var hasScore = false;
	cy.edges('[type="semantic"]').forEach(function (e) {
		if (typeof e.data('score') === 'number') hasScore = true;
	});
	densityControlEl.style.display = hasScore ? '' : 'none';
}

/** Categories only exist with LLM analysis on, so the panel doesn't offer them for now. */
var CATEGORIES_SHOWN = false;

var UNCATEGORIZED_FILTER_VALUE = '__uncategorized__';

function refreshCategoryFilterOptions() {
	if (!categoryFilterEl) return;

	var categories = {};
	var hasUncategorized = false;
	cy.nodes().forEach(function (n) {
		if (n.data('isCommunityParent')) return;
		var c = n.data('category');
		if (c) {
			categories[c] = true;
		} else {
			hasUncategorized = true;
		}
	});
	var names = Object.keys(categories).sort();

	var previousValue = categoryFilterEl.value;
	categoryFilterEl.innerHTML = '';
	var allOpt = document.createElement('option');
	allOpt.value = '';
	allOpt.textContent = 'All categories';
	categoryFilterEl.appendChild(allOpt);
	names.forEach(function (name) {
		var opt = document.createElement('option');
		opt.value = name;
		opt.textContent = name;
		categoryFilterEl.appendChild(opt);
	});
	if (hasUncategorized) {
		var uncatOpt = document.createElement('option');
		uncatOpt.value = UNCATEGORIZED_FILTER_VALUE;
		uncatOpt.textContent = 'Uncategorized';
		categoryFilterEl.appendChild(uncatOpt);
	}

	var stillValid =
		previousValue === '' ||
		names.indexOf(previousValue) !== -1 ||
		(previousValue === UNCATEGORIZED_FILTER_VALUE && hasUncategorized);
	categoryFilterEl.value = stillValid ? previousValue : '';
	categoryFilterEl.style.display =
		!CATEGORIES_SHOWN || (names.length === 0 && !hasUncategorized) ? 'none' : '';

	applyNodeFilters();
}

function applyNodeFilters() {
	if (!cy) return;
	// When colouring by search, the matches stand out by colour, so nothing needs dimming.
	var query = colorBy === 'search' ? '' : currentSearchQuery;
	var category = categoryFilterEl ? categoryFilterEl.value : '';

	var filtering = !!query || !!category;
	if (!filtering && !nodeFilterStylesApplied) return;
	nodeFilterStylesApplied = filtering;

	cy.nodes().stop(true, false);

	var matches = cy.collection();
	cy.batch(function () {
		cy.nodes().removeStyle('border-width border-color');

		if (!query && !category) {
			cy.nodes().style('opacity', 1);
			return;
		}

		matches = cy.nodes().filter(function (n) {
			if (n.data('isCommunityParent')) return false;
			var matchesSearch =
				!query || (n.data('label') || '').toLowerCase().indexOf(query) !== -1;
			var c = n.data('category');
			var matchesCategory =
				!category || (category === UNCATEGORIZED_FILTER_VALUE ? !c : c === category);
			return matchesSearch && matchesCategory;
		});

		cy.nodes().style('opacity', 0.15);
		matches.style('opacity', 1);
		cy.nodes('[?isCommunityParent]').style('opacity', 1);

		if (query && matches.length > 0) {
			matches.style('border-width', 3);
			matches.style('border-color', '#ffa500');
		}
	});

	if (query && matches.length > 0) {
		if (searchBorderTimer) clearTimeout(searchBorderTimer);
		searchBorderTimer = setTimeout(function () {
			matches.removeStyle('border-width border-color');
		}, 800);
		var target = viewportForNodes(matches);
		if (target) cy.animate({ zoom: target.zoom, pan: target.pan, duration: 400 });
	}
}

function postToPlugin(message) {
	if (typeof webviewApi === 'undefined') return Promise.resolve(null);
	return webviewApi.postMessage(message).catch(function (e) {
		console.error('Note Graph message failed:', message.type, e);
		return null;
	});
}

function openView(request) {
	postToPlugin({ type: 'open-view', request: request });
}

function hideSearchResults() {
	if (searchResultsEl) searchResultsEl.hidden = true;
}

/** A finished search must not keep dimming or zooming the next view. */
function clearSearch() {
	hideSearchResults();
	currentSearchQuery = '';
	var input = document.getElementById('graph-search');
	if (input) input.value = '';
}

function renderSearchResults(results) {
	if (!searchResultsEl) return;
	searchResultsEl.innerHTML = '';

	results.forEach(function (result) {
		var item = document.createElement('button');
		item.type = 'button';
		item.className = 'graph-search-results__item';
		item.textContent = result.label;
		item.addEventListener('click', function () {
			clearSearch();
			openConnections(result.noteId);
		});
		searchResultsEl.appendChild(item);
	});

	if (results.length === 0) {
		var empty = document.createElement('div');
		empty.className = 'graph-search-results__empty';
		empty.textContent = 'No matching notes';
		searchResultsEl.appendChild(empty);
	}
	searchResultsEl.hidden = false;

	var openTopResult = openTopResultWhenShown;
	openTopResultWhenShown = false;
	if (openTopResult && results.length > 0) searchResultsEl.firstChild.click();
}

/** When some notes aren't on screen, the search goes to the plugin, which has every note. */
function searchAllNotes(query) {
	var requestId = ++searchRequestId;
	if (!query || !currentView || !currentView.isPartial) {
		openTopResultWhenShown = false;
		hideSearchResults();
		return;
	}
	postToPlugin({ type: 'search-notes', query: query }).then(function (response) {
		if (requestId !== searchRequestId || !response) return;
		renderSearchResults(response.results || []);
	});
}

function updateViewBar(view) {
	if (!viewBarEl || !viewBackEl || !viewTitleEl) return;

	var isConnections = view.kind === 'neighborhood';
	var notice = focusHidesNotes ? FOCUS_NOTICE : '';
	var text = [view.summary, notice].filter(Boolean).join(' ');
	viewTitleEl.innerHTML = isConnections ? connectionsTitleHtml(text) : escapeHtml(text);
	viewTitleEl.hidden = !text;
	viewBackEl.hidden = !view.canGoBack;
	if (viewBackLabelEl) viewBackLabelEl.textContent = view.scopeLabel;
	viewBarEl.hidden = !text && !view.canGoBack && !isConnections;
	updateDepthControl(view, isConnections);
}

var CONNECTIONS_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
var CONNECTIONS_PREFIX = 'Connections of ';

function connectionsTitleHtml(text) {
	var opening = CONNECTIONS_PREFIX + centerNoteLabel;
	if (!centerNoteLabel || text.indexOf(opening) !== 0) return CONNECTIONS_ICON + escapeHtml(text);
	var rest = text.slice(opening.length);
	return (
		CONNECTIONS_ICON +
		'<span>' +
		CONNECTIONS_PREFIX +
		'<b>' +
		escapeHtml(centerNoteLabel) +
		'</b>' +
		escapeHtml(rest === '.' ? '' : rest) +
		'</span>'
	);
}

function findCenterNoteLabel(message) {
	var id = message.view.centerNoteId;
	if (!id) return '';
	var incoming = (message.nodes || []).filter(function (node) {
		return node.data && node.data.id === id;
	})[0];
	if (incoming) return incoming.data.label || '';
	var drawn = cy ? cy.getElementById(id) : null;
	return drawn && drawn.length ? drawn.data('label') || '' : centerNoteLabel;
}

/** Focus can hide most of a notebook, which looks like notes went missing unless the panel says why. */
function setFocusHidesNotes(hidden) {
	if (hidden === focusHidesNotes) return;
	focusHidesNotes = hidden;
	if (currentView) updateViewBar(currentView);
}

function updateDepthControl(view, isConnections) {
	if (!depthControlEl || !depthSliderEl) return;
	depthControlEl.hidden = !isConnections;
	if (!isConnections || !view.depth) return;
	currentDepth = view.depth;
	depthSliderEl.value = String(view.depth);
	showDepth();
}

function showDepth() {
	var depth = Number(depthSliderEl.value);
	if (depthValueEl) depthValueEl.textContent = String(depth);
	if (depthLessEl) depthLessEl.disabled = depth <= Number(depthSliderEl.min);
	if (depthMoreEl) depthMoreEl.disabled = depth >= Number(depthSliderEl.max);
}

function stepDepth(change) {
	depthSliderEl.value = String(Number(depthSliderEl.value) + change);
	depthSliderEl.dispatchEvent(new Event('input'));
	depthSliderEl.dispatchEvent(new Event('change'));
}

/** Only rebuilds the list when it really changed, because that would close it while the user is choosing. */
function updateTagFilter(view) {
	if (!tagFilterEl) return;
	var key = JSON.stringify([view.tagOptions, view.activeTag]);
	if (key === currentTagOptionsKey) return;
	currentTagOptionsKey = key;

	tagFilterEl.innerHTML = '';
	addTagOption('', 'All tags');
	view.tagOptions.forEach(function (option) {
		addTagOption(option.name, option.name, option.noteCount);
	});
	var isListed = view.tagOptions.some(function (option) {
		return option.name === view.activeTag;
	});
	if (view.activeTag && !isListed) addTagOption(view.activeTag, view.activeTag);
	tagFilterEl.value = view.activeTag || '';
	tagFilterEl.hidden = view.tagOptions.length === 0 && !view.activeTag;
}

function addTagOption(value, text, count) {
	var option = document.createElement('option');
	option.value = value;
	option.textContent = text;
	if (count !== undefined) option.dataset.count = String(count);
	tagFilterEl.appendChild(option);
}

function updateScopeMenu(view) {
	var label = document.getElementById('graph-scope-label');
	if (label) {
		label.textContent = view.scopeLabel;
		label.dataset.fromView = 'true';
	}
	var allNotebooks = document.querySelector('[data-scope-mode="all"]');
	if (allNotebooks) allNotebooks.hidden = view.isLarge;
}

function applyViewDetails(message) {
	if (message.view) {
		centerNoteLabel = findCenterNoteLabel(message);
		currentView = message.view;
		currentTotals = message.view.totals;
		updateStats(
			currentTotals.notes,
			currentTotals.explicit,
			currentTotals.semantic,
			currentTotals.tags
		);
		updateViewBar(currentView);
		updateTagFilter(currentView);
		updateScopeMenu(currentView);
		updateGroupToggleAvailability();
		showFocusState();
		updateFocusAvailability();
	}
}

function applyDetailLevel(nodeCount, edgeCount) {
	var wanted = nodeCount > LOW_DETAIL_NODES || edgeCount > LOW_DETAIL_EDGES;
	if (wanted === lowDetail) return;
	lowDetail = wanted;
	cy.style().fromJson(buildStylesheet()).update();
}

function showStatus(text) {
	if (statusEl) {
		statusEl.textContent = text;
		statusEl.style.display = '';
		var graphIsDrawn = !!cy && cy.nodes().length > 0;
		statusEl.classList.toggle('graph-status--over-graph', graphIsDrawn);
		statusEl.classList.toggle('graph-status--loading', !graphIsDrawn && !hasRenderedOnce);
	}
}

/** Over a graph, a status is a passing notice, so it mustn't sit on top of the notes. */
function showPluginStatus(text, icon) {
	if (!cy || cy.nodes().length === 0) {
		showStatus(text);
		return;
	}
	var toast = document.getElementById('graph-toast');
	if (!toast) return;
	toast.innerHTML =
		(TOAST_ICONS[icon] || TOAST_ICONS.notice) + '<span>' + escapeHtml(text) + '</span>';
	toast.hidden = false;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(function () {
		toast.hidden = true;
	}, TOAST_DURATION_MS);
}

var TOAST_ICONS = {
	notice: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 11v5.5M12 7.5v.01"/></svg>',
	cancelled:
		'<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M9 9l6 6M15 9l-6 6"/></svg>',
};

function hideStatus() {
	if (!statusEl) return;
	if (graphNotice) {
		showStatus(graphNotice);
	} else {
		statusEl.style.display = 'none';
	}
}

function applyGraphNotice(notice) {
	var next = notice || null;
	if (next === graphNotice) return;
	var wasShowingOldNotice = statusEl && statusEl.textContent === graphNotice;
	graphNotice = next;
	if (next) {
		showStatus(next);
	} else if (wasShowingOldNotice) {
		hideStatus();
	}
}

function showPipelineProgress(label, current, total) {
	if (!pipelineProgressEl || !pipelineProgressFillEl || !pipelineProgressLabelEl) return;
	if (pipelineProgressEl.style.display === 'none') setPipelineProgressShown(true);
	var pct = total > 0 ? Math.round((current / total) * 100) : 0;
	pipelineProgressFillEl.style.width = pct + '%';
	pipelineProgressLabelEl.textContent = label;
	if (pipelineProgressCancelEl) {
		pipelineProgressCancelEl.disabled = false;
	}
}

function hidePipelineProgress() {
	if (!pipelineProgressEl || pipelineProgressEl.style.display === 'none') return;
	setPipelineProgressShown(false);
}

function setPipelineProgressShown(shown) {
	pipelineProgressEl.style.display = shown ? 'inline-flex' : 'none';
	pipelineProgressEl.closest('.stats-bar').classList.toggle('stats-bar--busy', shown);
	announceActivity();
}

function announceActivity() {
	document.dispatchEvent(new CustomEvent('note-graph-activity'));
}

/** Colors for community groups, ordered largest cluster first. First 7 are the Okabe-Ito colorblind-safe palette, 3 more added to reach 10. */
var COMMUNITY_COLORS_DARK = [
	'#e69f00', // orange
	'#56b4e9', // sky blue
	'#1fb589', // bluish green
	'#e6d93a', // yellow
	'#4a9bdb', // blue
	'#e8743b', // vermillion
	'#d98cb6', // reddish purple
	'#8f83e6', // indigo
	'#55bdaa', // teal
	'#c76ab7', // purple
];

/** The same hues, darkened so a small dot still stands out on a white background. */
var COMMUNITY_COLORS_LIGHT = [
	'#b87f00', // orange
	'#1f87c7', // sky blue
	'#008560', // bluish green
	'#928800', // yellow
	'#0072b2', // blue
	'#c95500', // vermillion
	'#b8568e', // reddish purple
	'#4a3da8', // indigo
	'#2c8878', // teal
	'#a03f90', // purple
];

var SEARCH_MATCH_COLOR = '#ffa500';
var SEARCH_OTHER_COLOR_DARK = '#9aa0a6';
var SEARCH_OTHER_COLOR_LIGHT = '#7f868e';

/** Large vaults have far more communities than the palette, so the rest get evenly spread hues. */
function communityColor(ele) {
	var community = ele.data('community') || 0;
	var dark = isDarkTheme();
	var palette = dark ? COMMUNITY_COLORS_DARK : COMMUNITY_COLORS_LIGHT;
	if (community < palette.length) return palette[community];
	return (
		'hsl(' + Math.round((community * 137.508) % 360) + ', 45%, ' + (dark ? '62%' : '36%') + ')'
	);
}

/** The same notebook always gets the same color, in every view. */
function notebookColor(ele) {
	var id = ele.data('notebookId') || '';
	var hash = 0;
	for (var i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	return 'hsl(' + (Math.abs(hash) % 360) + ', 55%, ' + (isDarkTheme() ? '62%' : '36%') + ')';
}

function matchesSearchColor(ele) {
	return (
		!!currentSearchQuery &&
		(ele.data('label') || '').toLowerCase().indexOf(currentSearchQuery) !== -1
	);
}

function nodeColor(ele) {
	if (colorBy === 'none') return graphColors.note;
	if (colorBy === 'notebook') return notebookColor(ele);
	if (colorBy === 'search') {
		if (matchesSearchColor(ele)) return SEARCH_MATCH_COLOR;
		return isDarkTheme() ? SEARCH_OTHER_COLOR_DARK : SEARCH_OTHER_COLOR_LIGHT;
	}
	return communityColor(ele);
}

/** Rebuilding the whole stylesheet holds the UI thread for too long, and only the colors depend on this choice. */
function refreshNodeColors() {
	if (cy) cy.nodes().updateStyle();
}

/** Coloring by search follows this view's own search box, so the other view keeps the last shared coloring. */
function choicesOnScreen() {
	var sharedColorBy = sharedChoices ? sharedChoices.colorBy : 'none';
	return {
		colorBy: colorBy === 'search' ? sharedColorBy : colorBy,
		hiddenEdgeTypes: Object.keys(edgeTypeOff)
			.filter(function (type) {
				return edgeTypeOff[type];
			})
			.sort(),
		minSimilarity: Math.round(currentMinConfidence * 100),
	};
}

function sameChoices(a, b) {
	return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

/** The plugin keeps the view choices and passes a change on to every view, so the panel and popup agree. */
function shareChoices() {
	var choices = choicesOnScreen();
	if (sameChoices(choices, sharedChoices)) return;
	sharedChoices = choices;
	postToPlugin({ type: 'set-view-choices', choices: choices });
}

/** Coloring goes last: its select reports the change, and by then the rest already matches, so nothing is sent back. A view coloring by search keeps its own coloring. */
function applySharedChoices(choices) {
	if (!choices || sameChoices(choices, sharedChoices)) return;
	sharedChoices = choices;
	document.querySelectorAll('.legend-panel__pill[data-edge]').forEach(function (pill) {
		showEdgeType(pill, choices.hiddenEdgeTypes.indexOf(pill.getAttribute('data-edge')) === -1);
	});
	showMinSimilarity(choices.minSimilarity);
	applyVisibility();
	var colorByEl = document.getElementById('graph-color-by');
	if (colorByEl && colorBy !== 'search' && colorByEl.value !== choices.colorBy) {
		colorByEl.value = choices.colorBy;
		colorByEl.dispatchEvent(new Event('change'));
	}
}

function showEdgeType(pill, shown) {
	pill.classList.toggle('legend-panel__pill--off', !shown);
	pill.setAttribute('aria-pressed', String(shown));
	edgeTypeOff[pill.getAttribute('data-edge')] = !shown;
}

function showMinSimilarity(percent) {
	currentMinConfidence = percent / 100;
	if (densitySliderEl) densitySliderEl.value = String(percent);
	if (densityValueEl) densityValueEl.textContent = percent + '%';
}

/** The room GraphLayoutEngine leaves a note, from its 1-10 centrality score. A note is never drawn larger, or it would run into its neighbours. */
function layoutDiameter(size) {
	return 18 + (size - 1) * 3;
}

var SMALLEST_NODE_PIXELS = 7.5;
var NODE_PIXELS_PER_SIZE_STEP = 0.65;
var SELECTED_NODE_PIXELS = 18;

function nodeDiameter(ele) {
	var size = ele.data('size') || 1;
	var pixels = SMALLEST_NODE_PIXELS + NODE_PIXELS_PER_SIZE_STEP * (size - 1);
	return Math.min(layoutDiameter(size), pixels / fitZoom);
}

/** The selected note is the largest dot. On a view drawn small it grows further, or it can't be picked out from the rest. */
function selectedNodeDiameter(ele) {
	if (lowDetail) return nodeDiameter(ele) * 2.5;
	return Math.max(nodeDiameter(ele), steady(SELECTED_NODE_PIXELS));
}

/** Detect whether the current Joplin theme is dark by computing luminance of --joplin-background-color. */
function isDarkTheme() {
	var bg = getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim();
	if (!bg) return false;

	var r = parseInt(bg.slice(1, 3), 16);
	var g = parseInt(bg.slice(3, 5), 16);
	var b = parseInt(bg.slice(5, 7), 16);
	var lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return lum < 128;
}

var lastThemeBackground = '';

function themeBackground() {
	return getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim();
}

/** Joplin can add its theme after the panel has started, so the graph's colours and font are rebuilt once it arrives or changes. */
function refreshThemeIfChanged() {
	var current = themeBackground();
	if (current === lastThemeBackground) return;
	lastThemeBackground = current;
	applyThemeToChrome(isDarkTheme());
	restyleGraph();
}

function applyThemeToChrome(dark) {
	document.documentElement.classList.toggle('theme-dark', dark);
}

function restyleGraph() {
	if (cy) cy.style().fromJson(buildStylesheet()).update();
}

function themeColor(name) {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

var graphColors = {};

function readGraphColors() {
	graphColors = {
		canvas: themeColor('--ng-canvas'),
		note: themeColor('--ng-note'),
		text: themeColor('--ng-text'),
		mutedText: themeColor('--ng-text-3'),
		link: themeColor('--ng-link'),
		linkStrong: themeColor('--ng-link-strong'),
		similar: themeColor('--ng-similar'),
		tag: themeColor('--ng-tag'),
	};
}

var PANEL_FONT = 'Inter Variable';
var STYLES_POLL_MS = 100;

function panelFontLoaded() {
	return Array.from(document.fonts || []).some(function (face) {
		return face.family.replace(/"/g, '') === PANEL_FONT && face.status === 'loaded';
	});
}

function labelFontFamily() {
	var family = getComputedStyle(
		document.querySelector('.panel-root') || document.body
	).fontFamily;
	return panelFontLoaded() ? family : family.replace(/^"?Inter Variable"?,\s*/, '');
}

function restyleGraphOnceStylesArrive() {
	if (document.fonts) document.fonts.addEventListener('loadingdone', restyleGraph);
	if (themeColor('--ng-note')) return;
	var timer = setInterval(function () {
		if (!themeColor('--ng-note')) return;
		clearInterval(timer);
		restyleGraph();
	}, STYLES_POLL_MS);
}

var EDGE_BOW = { link: 0.1, semantic: -0.14, tag: 0.24 };
var MAX_EDGE_BOW = 70;

function edgeBow(edge) {
	var from = edge.source().position();
	var to = edge.target().position();
	var length = Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2));
	var share = EDGE_BOW[edge.data('type')] || EDGE_BOW.link;
	return Math.max(-MAX_EDGE_BOW, Math.min(MAX_EDGE_BOW, length * share));
}

/** Build the Cytoscape stylesheet with theme-aware colours. Links are grey and solid, similar notes purple and dashed, shared tags amber and dotted. */
function buildStylesheet() {
	readGraphColors();
	var colors = graphColors;

	return [
		{
			selector: 'node[!isCommunityParent]',
			style: {
				'background-color': nodeColor,
				label: lowDetail ? 'data(label)' : nodeLabel,
				color: colors.text,
				'font-size': labelFontSize,
				'font-family': labelFontFamily(),
				'font-weight': 500,
				'text-valign': 'bottom',
				'text-halign': 'center',
				'text-margin-y': lowDetail ? 4 : steadyLength(4),
				'text-wrap': lowDetail ? 'none' : 'wrap',
				'text-max-width': labelMaxWidth,
				'line-height': 1.18,
				'text-outline-width': lowDetail ? 0 : steadyLength(1.3),
				'text-outline-color': colors.canvas,
				'min-zoomed-font-size': lowDetail ? 11 : 7,
				width: nodeDiameter,
				height: nodeDiameter,
				'border-width': lowDetail ? 0 : steadyLength(1.6),
				'border-color': colors.canvas,
			},
		},
		{
			selector: 'node[?outsideScope]',
			style: {
				'background-color': colors.canvas,
				'border-width': lowDetail ? 1.5 : steadyLength(1.5),
				'border-style': 'solid',
				'border-color': nodeColor,
				color: colors.mutedText,
				'font-weight': 400,
			},
		},
		{
			selector: 'node[!isCommunityParent]:selected',
			style: {
				'outline-style': 'solid',
				'outline-color': nodeColor,
				'outline-width': steadyLength(1.7),
				'outline-offset': steadyLength(3.4),
				'outline-opacity': 0.4,
				color: colors.text,
				'font-size': selectedLabelSize,
				'text-max-width': selectedLabelMaxWidth,
				'text-outline-width': selectedLabelOutline,
				'min-zoomed-font-size': 0,
				width: selectedNodeDiameter,
				height: selectedNodeDiameter,
				'z-index': 20,
			},
		},
		{
			selector: 'node[?isCommunityParent]',
			style: {
				'background-color': colors.text,
				'background-opacity': 0.04,
				'border-width': 1,
				'border-style': 'dashed',
				'border-color': colors.text,
				'border-opacity': 0.22,
				shape: 'round-rectangle',
				label: 'data(label)',
				color: colors.mutedText,
				'font-size': '10px',
				'font-weight': 600,
				'text-valign': 'top',
				'text-halign': 'center',
				'text-margin-y': -6,
				'text-outline-width': 2,
				'text-outline-color': colors.canvas,
				padding: '18px',
			},
		},
		{
			selector: 'edge',
			style: {
				width: lowDetail ? 1.2 : steadyLength(1.5),
				'line-color': colors.link,
				'curve-style': lowDetail ? 'haystack' : 'unbundled-bezier',
				'control-point-distances': lowDetail ? 0 : edgeBow,
				'control-point-weights': 0.5,
				'target-arrow-shape': lowDetail ? 'none' : 'triangle',
				'target-arrow-color': colors.link,
				'arrow-scale': lowDetail ? 0.8 : arrowScale,
			},
		},
		{
			selector: 'edge[type="tag"]',
			style: {
				width: lowDetail ? 1 : steadyLength(1.3),
				'line-color': colors.tag,
				'line-style': lowDetail ? 'solid' : 'dashed',
				'line-dash-pattern': lowDetail ? [6, 3] : steadyDashes(0.1, 4.6),
				'line-cap': 'round',
				'target-arrow-shape': 'none',
			},
		},
		{
			selector: 'edge[type="semantic"]',
			style: {
				width: lowDetail ? 1.2 : steadyLength(1.25),
				'line-color': colors.similar,
				'line-style': lowDetail ? 'solid' : 'dashed',
				'line-dash-pattern': lowDetail ? [6, 3] : steadyDashes(5, 3.5),
				'target-arrow-shape': 'none',
			},
		},
		{
			selector: 'edge.edge-faded',
			style: {
				opacity: 0.22,
			},
		},
		{
			selector: 'edge.edge-connected, edge.edge-hover',
			style: {
				width: steadyLength(2.2),
				'z-index': 10,
			},
		},
		{
			selector: 'edge[type="link"].edge-connected, edge[type="link"].edge-hover',
			style: {
				'line-color': colors.linkStrong,
				'target-arrow-color': colors.linkStrong,
			},
		},
		{
			selector: 'edge[type="tag"].edge-connected, edge[type="tag"].edge-hover',
			style: {
				width: steadyLength(2.7),
				'line-dash-pattern': steadyDashes(0.1, 5.4),
			},
		},
		{
			selector: 'edge[type="semantic"].edge-connected, edge[type="semantic"].edge-hover',
			style: {
				width: steadyLength(1.9),
				'line-dash-pattern': steadyDashes(6, 4),
			},
		},
		{
			selector: 'node.edge-hover-node, node.node-hover',
			style: {
				'outline-style': 'solid',
				'outline-color': nodeColor,
				'outline-width': steadyLength(1.7),
				'outline-offset': steadyLength(3.4),
				'outline-opacity': 0.4,
				'z-index': 10,
			},
		},
	];
}

function emphasizeEdges(edges, className) {
	cy.batch(function () {
		edges.addClass(className);
		if (!lowDetail) cy.edges().not(edges).addClass('edge-faded');
	});
}

function clearEdgeEmphasis() {
	cy.batch(function () {
		cy.edges('.edge-connected, .edge-hover, .edge-faded').removeClass(
			'edge-connected edge-hover edge-faded'
		);
	});
}

function openConnections(noteId) {
	openView({ kind: 'neighborhood', noteId: noteId, depth: currentDepth });
}

function openNote(node) {
	if (typeof webviewApi !== 'undefined') {
		webviewApi.postMessage({
			type: 'node-clicked',
			nodeId: node.id(),
			nodeLabel: node.data('label'),
		});
	}
}

/** Opening a note from another notebook would move Joplin there and take the graph with it, so that note shows its connections instead. */
function onNodeTap(evt) {
	var node = evt.target;
	if (node.data('outsideScope')) {
		openConnections(node.id());
		return;
	}
	openNote(node);
}

/** Animate zoom-to-node on double-click. */
function onNodeDblClick(evt) {
	var node = evt.target;
	cy.animate({
		fit: { eles: node, padding: 40 },
		center: { eles: node },
		duration: 400,
	});
}

var TAG_NAME_SEPARATOR = '\n';
var MAX_TOOLTIP_TAGS = 4;

/** A note's card sizes to what it says; an edge's card keeps one width, so its sentence wraps the same way every time. */
function showTooltip(html, point, kind) {
	if (!tooltipEl) return;
	tooltipEl.className = 'graph-tooltip graph-tooltip--' + kind;
	tooltipEl.innerHTML = html;
	tooltipEl.classList.add('is-visible');
	positionTooltip(point);
}

function pointerOf(evt) {
	return { x: evt.originalEvent.clientX, y: evt.originalEvent.clientY };
}

function panelPointOf(node) {
	var box = cy.container().getBoundingClientRect();
	var position = node.renderedPosition();
	return { x: box.left + position.x, y: box.top + position.y };
}

/** Cytoscape treats everything inside its container as the graph, so a press on these controls would also tap the note behind them, and it cancels the press, which stops a slider from dragging. */
function keepControlsFromGraph(container) {
	Array.prototype.forEach.call(container.children, function (control) {
		['mousedown', 'pointerdown', 'mousemove'].forEach(function (type) {
			control.addEventListener(type, function (e) {
				e.stopPropagation();
			});
		});
		control.addEventListener(
			'touchstart',
			function (e) {
				e.stopPropagation();
			},
			{ passive: true }
		);
		control.addEventListener('mouseenter', function () {
			if (cy) cy.elements('.node-hover, .edge-hover').emit('mouseout');
			hideTooltip();
		});
	});
}

function hideTooltip() {
	if (tooltipEl) tooltipEl.classList.remove('is-visible');
}

var NOTEBOOK_ICON =
	'<svg viewBox="0 0 12 16" width="8" height="10.5" aria-hidden="true"><rect x="0.75" y="0.75" width="10.5" height="14.5" rx="1.75" fill="none" stroke="currentColor" stroke-width="1.6"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M3.75 4.5h4.5"/></svg>';
var TAG_ICON =
	'<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7.1a2 2 0 0 1 1.4.6l8 8a2 2 0 0 1 0 2.8l-6.6 6.6a2 2 0 0 1-2.8 0l-8-8A2 2 0 0 1 3 11.6z"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>';

function edgeSwatch(type) {
	var kind = type === 'tag' || type === 'semantic' ? type : 'link';
	return '<i class="edge-swatch edge-swatch--' + kind + '"></i>';
}

function noteDot(node) {
	return (
		'<i class="note-dot' +
		(node.data('outsideScope') ? ' note-dot--outside' : '') +
		'" style="--ng-dot-color:' +
		nodeColor(node) +
		'"></i>'
	);
}

function tooltipKind(type, label, usesAi) {
	return (
		'<div class="graph-tooltip__kind">' +
		edgeSwatch(type) +
		'<span>' +
		escapeHtml(label) +
		'</span>' +
		(usesAi ? '<span class="ai-badge">AI</span>' : '') +
		'</div>'
	);
}

function tooltipTitle(text) {
	return '<div class="graph-tooltip__title">' + escapeHtml(text) + '</div>';
}

function tooltipText(text, strong) {
	return (
		'<div class="graph-tooltip__text' +
		(strong ? ' graph-tooltip__text--strong' : '') +
		'">' +
		escapeHtml(text) +
		'</div>'
	);
}

function tooltipNotebook(names) {
	var shown = names.filter(Boolean);
	if (shown.length === 0) return '';
	return (
		'<div class="graph-tooltip__notebook">' +
		NOTEBOOK_ICON +
		'<span>' +
		escapeHtml(shown.join(' \u00b7 ')) +
		'</span></div>'
	);
}

function tooltipHint(text) {
	return '<div class="graph-tooltip__hint">' + escapeHtml(text) + '</div>';
}

function tooltipChips(names) {
	if (names.length === 0) return '';
	var shown = names.slice(0, MAX_TOOLTIP_TAGS).map(function (name) {
		return (
			'<span class="graph-tooltip__chip">' +
			TAG_ICON +
			'<span>' +
			escapeHtml(name) +
			'</span></span>'
		);
	});
	if (names.length > MAX_TOOLTIP_TAGS) {
		shown.push(
			'<span class="graph-tooltip__chip graph-tooltip__chip--more">+' +
				(names.length - MAX_TOOLTIP_TAGS) +
				'</span>'
		);
	}
	return '<div class="graph-tooltip__chips">' + shown.join('') + '</div>';
}

function tooltipCount(type, count, noun) {
	return (
		'<span class="graph-tooltip__count">' +
		edgeSwatch(type) +
		'<b>' +
		count +
		'</b> ' +
		noun +
		'</span>'
	);
}

/** Counts what's on screen, so the numbers match what the user can see. */
function tooltipConnections(node) {
	var counts = { link: 0, semantic: 0, tag: 0 };
	node.connectedEdges().forEach(function (edge) {
		var type = edge.data('type');
		if (counts[type] !== undefined) counts[type]++;
	});
	var parts = [];
	if (counts.link)
		parts.push(tooltipCount('link', counts.link, counts.link === 1 ? 'link' : 'links'));
	if (counts.semantic) parts.push(tooltipCount('semantic', counts.semantic, 'similar'));
	if (counts.tag) parts.push(tooltipCount('tag', counts.tag, 'by tag'));
	return (
		'<div class="graph-tooltip__counts">' +
		(parts.length ? parts.join('') : 'Not connected in this view') +
		'</div>'
	);
}

function noteTooltipHtml(node) {
	var outside = !!node.data('outsideScope');
	var notebookTitle =
		currentView && currentView.notebookTitles
			? currentView.notebookTitles[node.data('notebookId')]
			: null;
	var tagNames = node.data('tagNames') ? node.data('tagNames').split(TAG_NAME_SEPARATOR) : [];
	var category = CATEGORIES_SHOWN ? node.data('category') : null;
	return (
		'<div class="graph-tooltip__head">' +
		noteDot(node) +
		tooltipTitle(node.data('label') || '(untitled)') +
		'</div>' +
		tooltipNotebook([notebookTitle, category]) +
		tooltipChips(tagNames) +
		tooltipConnections(node) +
		tooltipHint(
			outside ? 'Click to see its connections' : 'Click to open \u00b7 Right-click for more'
		)
	);
}

/** Each note on its own line, with the dot it has in the graph. */
function edgeNotes(edge) {
	return (
		'<div class="graph-tooltip__notes">' +
		[edge.source(), edge.target()]
			.map(function (node) {
				return (
					'<div class="graph-tooltip__note">' +
					noteDot(node) +
					'<span class="graph-tooltip__note-name">' +
					escapeHtml(node.data('label') || '(untitled)') +
					'</span></div>'
				);
			})
			.join('') +
		'</div>'
	);
}

function edgeTooltipHtml(edge) {
	var type = edge.data('type');
	if (type === 'tag') {
		var names = (edge.data('tagName') || '').split(', ').filter(Boolean);
		var several = names.length > 1;
		return (
			tooltipKind(type, 'Tag connection') +
			tooltipText(
				several ? 'Both notes share ' + names.length + ' tags' : 'Both notes share a tag',
				true
			) +
			tooltipChips(names) +
			edgeNotes(edge)
		);
	}
	if (type === 'semantic') {
		return (
			tooltipKind(type, 'Similar notes', true) +
			tooltipText(edge.data('relationshipLabel') || 'These notes are about similar things') +
			edgeNotes(edge)
		);
	}
	return (
		tooltipKind(type, 'Link') +
		tooltipText('One note links to the other', true) +
		edgeNotes(edge)
	);
}

function fallbackCopy(text) {
	var ta = document.createElement('textarea');
	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();
	try {
		document.execCommand('copy');
	} catch (e) {
		console.error('Copy failed:', e);
	}
	document.body.removeChild(ta);
}

function copyText(text) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).catch(function () {
			fallbackCopy(text);
		});
	} else {
		fallbackCopy(text);
	}
}

function recomputeStats() {
	nodeStats = {};
	var explicitCount = 0;
	var semanticCount = 0;
	var tagNames = {};

	cy.edges().forEach(function (edge) {
		var e = edge.data();
		if (!nodeStats[e.source]) nodeStats[e.source] = { linkCount: 0, tagCount: 0 };
		if (!nodeStats[e.target]) nodeStats[e.target] = { linkCount: 0, tagCount: 0 };

		if (e.type === 'link' || e.type === 'explicit') {
			nodeStats[e.source].linkCount++;
			nodeStats[e.target].linkCount++;
			explicitCount++;
		} else if (e.type === 'semantic') {
			nodeStats[e.source].linkCount++;
			nodeStats[e.target].linkCount++;
			semanticCount++;
		} else if (e.type === 'tag') {
			nodeStats[e.source].tagCount++;
			nodeStats[e.target].tagCount++;
			if (e.tagName) {
				var parts = e.tagName.split(', ');
				for (var j = 0; j < parts.length; j++) {
					tagNames[parts[j]] = true;
				}
			}
		}
	});

	if (currentTotals) {
		updateStats(
			currentTotals.notes,
			currentTotals.explicit,
			currentTotals.semantic,
			currentTotals.tags
		);
	} else {
		var noteNodeCount = cy.nodes().filter(function (n) {
			return !n.data('isCommunityParent');
		}).length;
		updateStats(noteNodeCount, explicitCount, semanticCount, Object.keys(tagNames).length);
	}
	refreshCategoryFilterOptions();
	refreshDensityControlVisibility();
	if (groupByCommunityEnabled) {
		applyCommunityGrouping();
	}
}

/** Mirrors LouvainDetector.MIN_NOTES_FOR_LOUVAIN — below this, the graph has too few notes for meaningful structure. */
var NEAR_EMPTY_NOTE_THRESHOLD = 3;

var lastAllNotesVeryShort = false;

function countLabel(count, noun) {
	return count + ' ' + noun + (count === 1 ? '' : 's');
}

function noteCountLabel(count) {
	return countLabel(count, 'note');
}

function refreshEmptyStateStatus() {
	var noteCount = currentTotals ? currentTotals.notes : cy.nodes().length;
	if (currentView && currentView.emptyMessage) {
		showStatus(currentView.emptyMessage);
	} else if (noteCount === 0) {
		showStatus('No graph data received');
	} else if (noteCount < NEAR_EMPTY_NOTE_THRESHOLD) {
		showStatus(
			'Only ' +
				noteCountLabel(noteCount) +
				' found. Add more notes to see a meaningful graph.'
		);
	} else if (cy.edges().length === 0) {
		showStatus(noteCountLabel(noteCount) + ', 0 connections');
	} else if (lastAllNotesVeryShort) {
		showStatus('Notes are very short - add more content for a more meaningful graph.');
	} else {
		hideStatus();
	}
}

/**
 * Replaces the current graph with new data at the positions the plugin computed.
 * The panel shares Joplin's UI thread, so it never runs a layout itself.
 * @param {{ nodes: Array, edges: Array }} message - graph data from the plugin.
 */
function renderGraph(message) {
	refreshThemeIfChanged();
	currentRenderId++;
	renderInProgress = false;
	patchesAwaitingRender = [];
	cy.batch(function () {
		// Taking the community boxes first removes their notes with them, far faster than one note at a time.
		cy.nodes('[?isCommunityParent]').remove();
		cy.elements().remove();
	});
	elementsAreHidden = false;
	nodeFilterStylesApplied = false;
	focusActive = false;
	showFocusState();
	lastAllNotesVeryShort = !!(message && message.allNotesVeryShort);
	applyViewDetails(message || {});
	currentLayoutRevision = message ? message.layoutRevision : null;

	if (!message || !message.nodes || !message.nodes.length) {
		showStatus((currentView && currentView.emptyMessage) || 'No graph data received');
		if (currentTotals) recomputeStats();
		else updateStats(0, 0, 0, 0);
		return;
	}

	hideStatus();

	var edges = message.edges || [];
	applyDetailLevel(message.nodes.length, edges.length);
	var nodes = withCommunityParents(message.nodes);
	sizeForComingFit(message.nodes, nodes.length);
	var renderId = ++currentRenderId;
	renderInProgress = true;

	addInStages(nodes, renderId, function () {
		if (pendingFocusNoteId && highlightNodeBeforeLayout(pendingFocusNoteId)) {
			pendingFocusNoteId = null;
		} else if (openNoteId) {
			highlightNodeBeforeLayout(openNoteId);
		}
		selectNeighborhoodCenter();
		fitViewportToFocus();

		addInStages(edges, renderId, function () {
			recomputeStats();
			setTimeout(function () {
				if (renderId !== currentRenderId) return;
				applyVisibility();
				fitViewportToFocus();
				refreshEmptyStateStatus();
				finishRender();
			}, 0);
		});
	});
}

function sizeForComingFit(incomingNodes, noteCount) {
	var target = viewportForPositions(
		incomingNodes.map(function (node) {
			return node.position;
		})
	);
	if (target) keepSizesSteadyAt(target.zoom, noteCount);
}

/** Moving notes into a community box one at a time is very slow, so when grouping is on, each note starts inside its box. */
function withCommunityParents(nodes) {
	if (!groupByCommunityEnabled) return nodes;

	var counts = {};
	nodes.forEach(function (node) {
		var community = node.data.community || 0;
		counts[community] = (counts[community] || 0) + 1;
	});

	var parents = Object.keys(counts)
		.filter(function (community) {
			return counts[community] > 1;
		})
		.map(function (community) {
			return {
				data: {
					id: communityParentId(community),
					label: 'Cluster (' + counts[community] + ')',
					isCommunityParent: true,
				},
			};
		});

	var children = nodes.map(function (node) {
		var community = node.data.community || 0;
		if (counts[community] <= 1) return node;
		return {
			data: Object.assign({}, node.data, { parent: communityParentId(community) }),
			position: node.position,
		};
	});
	return parents.concat(children);
}

/** Applies whatever arrived while the graph was being drawn, now that everything it refers to is on screen. */
function finishRender() {
	renderInProgress = false;
	var waiting = patchesAwaitingRender;
	patchesAwaitingRender = [];
	waiting.forEach(applyGraphPatch);
}

/** Adds elements a slice at a time with a pause between, so the UI thread is never held for the whole graph at once. */
function addInStages(elements, renderId, onDone) {
	var position = 0;
	(function addNextSlice() {
		if (renderId !== currentRenderId) return;

		var slice = elements.slice(position, position + ELEMENTS_PER_RENDER_SLICE);
		position += slice.length;
		if (slice.length > 0) {
			cy.batch(function () {
				cy.add(slice);
			});
		}

		if (position < elements.length) {
			setTimeout(addNextSlice, 0);
		} else {
			onDone();
		}
	})();
}

function selectNeighborhoodCenter() {
	if (!currentView || !currentView.centerNoteId) return;
	var center = cy.getElementById(currentView.centerNoteId);
	if (center && center.length) center.select();
}

function upsertElement(data, position) {
	var existing = cy.getElementById(data.id);
	if (existing && existing.length) {
		var parent = existing.data('parent');
		existing.removeData();
		existing.data(data);
		if (parent) existing.data('parent', parent);
	} else if (position) {
		cy.add({ data: withCommunityParent(data), position: position });
	} else {
		cy.add({ data: data });
	}
}

/** A note added by a patch joins its community's box when grouping is on and the box is already drawn. */
function withCommunityParent(data) {
	if (!groupByCommunityEnabled) return data;
	var parentId = communityParentId(data.community || 0);
	if (!cy.getElementById(parentId).length) return data;
	return Object.assign({}, data, { parent: parentId });
}

/** Applies a change in place: nodes already on screen stay exactly where they are. */
function applyGraphPatch(patch) {
	if (!cy || !patch) return;
	if (renderInProgress) {
		patchesAwaitingRender.push(patch);
		return;
	}
	applyViewDetails(patch);

	var hasChanges =
		(patch.upsertedNodes && patch.upsertedNodes.length) ||
		(patch.upsertedEdges && patch.upsertedEdges.length) ||
		(patch.removedNodeIds && patch.removedNodeIds.length) ||
		(patch.removedEdgeIds && patch.removedEdgeIds.length);
	if (!hasChanges) {
		if (currentTotals) recomputeStats();
		return;
	}

	cy.batch(function () {
		(patch.removedEdgeIds || []).concat(patch.removedNodeIds || []).forEach(function (id) {
			var ele = cy.getElementById(id);
			if (ele && ele.length) ele.remove();
		});
		(patch.upsertedNodes || []).forEach(function (item) {
			upsertElement(item.data || item, item.position);
		});
		(patch.upsertedEdges || []).forEach(function (item) {
			upsertElement(item.data || item);
		});
	});

	recomputeStats();
	applyVisibility();
	refreshEmptyStateStatus();
	resolvePendingFocus();
}

function panelState() {
	return {
		hasRenderedOnce: hasRenderedOnce,
		lastSeenVersion: lastSeenVersion,
		renderInProgress: renderInProgress,
		viewKey: currentView ? currentView.key : null,
		layoutRevision: currentLayoutRevision,
	};
}

/** The notes and connections on screen, leaving out the community boxes. */
function drawnGraph() {
	return {
		nodeIds: cy
			.nodes()
			.filter(function (n) {
				return !n.data('isCommunityParent');
			})
			.map(function (n) {
				return n.id();
			}),
		edgeIds: cy.edges().map(function (e) {
			return e.id();
		}),
		dataOf: function (id) {
			var ele = cy.getElementById(id);
			return ele && ele.length ? ele.data() : null;
		},
	};
}

function handleGraphUpdate(type, message) {
	var version = message.version || 0;
	var state = panelState();
	if (isOutdated(version, state)) return;

	if (message && message.focusNoteId) {
		pendingFocusNoteId = message.focusNoteId;
		openNoteId = message.focusNoteId;
	}

	var action = decideUpdate(type, message, state);
	if (action === 'skip') return;
	if (message.layout) showLayoutChoice(message.layout, !!message.grouped);
	if (action === 'apply-patch') {
		applyGraphPatch(message);
	} else if (action === 'redraw') {
		renderGraph(message);
		hasRenderedOnce = true;
	} else {
		var drawn = drawnGraph();
		var patch = computeClientPatch(message, drawn);
		if (isWholesaleChange(patch, drawn)) {
			renderGraph(message);
		} else {
			applyGraphPatch(patch);
		}
	}

	lastSeenVersion = version;
}

/** Write counts into the footer (stat-notes) and the connection toggles (stat-explicit, stat-semantic, stat-tags). */
function updateStats(notes, explicit, semantic, tags) {
	var elNotes = document.getElementById('stat-notes');
	var elExplicit = document.getElementById('stat-explicit');
	var elSemantic = document.getElementById('stat-semantic');
	var elTags = document.getElementById('stat-tags');
	var bar = document.getElementById('stats-bar');
	if (bar) bar.classList.remove('stats-bar--empty');
	if (elNotes) elNotes.textContent = notes.toLocaleString();
	if (elExplicit) elExplicit.textContent = explicit.toLocaleString();
	if (elSemantic) elSemantic.textContent = semantic.toLocaleString();
	if (elTags) elTags.textContent = tags.toLocaleString();
	showSimilarOnlyWhenPresent(semantic > 0);
	updateNoteLegend();
}

function notesLegendLabel() {
	if (isConnectionsView()) return 'notes shown';
	if (!currentView || currentView.kind !== 'notebook') return 'notes';
	return currentView.scopeNotebookCount > 1
		? 'notes in ' + currentView.scopeLabel
		: 'notes in this notebook';
}

function updateNoteLegend() {
	var label = document.getElementById('stat-notes-label');
	var outsideEl = document.getElementById('stat-outside');
	var bar = document.getElementById('stats-bar');
	var outside = cy ? cy.nodes('[?outsideScope]').length : 0;
	if (label) label.textContent = notesLegendLabel();
	if (outsideEl) {
		outsideEl.textContent = outside.toLocaleString();
		outsideEl.parentNode.hidden = outside === 0;
	}
	if (bar) bar.classList.toggle('stats-bar--plain-dots', colorBy !== 'none');
}

/** Without AI analysis there are no similar notes, so a control for them would do nothing. */
function showSimilarOnlyWhenPresent(present) {
	var toggle = document.querySelector('[data-edge="semantic"]');
	var stat = document.getElementById('stat-semantic');
	if (toggle) toggle.hidden = !present;
	if (stat) stat.parentNode.hidden = !present;
}

/** Escape closes an open menu and goes no further, so in the popup it doesn't close the popup too. */
function closeOnEscape(isOpen, close) {
	document.addEventListener(
		'keydown',
		function (e) {
			if (e.key !== 'Escape' || !isOpen()) return;
			e.stopPropagation();
			close();
		},
		true
	);
}

function createExportMenu(btn) {
	var menu = document.createElement('div');
	menu.className = 'export-menu';
	menu.innerHTML =
		'<button class="export-menu__item" data-format="png"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 16l4.58-5.34a1 1 0 0 1 1.54-.08L14 15l3.35-4.47a1 1 0 0 1 1.62-.06L21 14"/><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>PNG</button><button class="export-menu__item" data-format="svg"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>SVG</button><button class="export-menu__item" data-format="json"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 18l2 2 4-4"/><path fill="none" stroke="currentColor" stroke-width="2" d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/></svg>JSON</button>';
	document.body.appendChild(menu);

	btn.addEventListener('click', function (e) {
		e.stopPropagation();
		var open = menu.style.display === 'block';
		menu.style.display = open ? 'none' : 'block';
		if (!open) {
			var rect = btn.getBoundingClientRect();
			menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
			menu.style.top = rect.bottom + 6 + 'px';
		}
	});

	menu.addEventListener('click', function (e) {
		e.stopPropagation();
		var item = e.target.closest('.export-menu__item');
		if (!item) return;
		var format = item.getAttribute('data-format');
		menu.style.display = 'none';
		var bg = graphColors.canvas;
		if (format === 'png') {
			downloadFile(cy.png({ full: true, bg: bg }), 'note-graph.png');
		} else if (format === 'svg') {
			var svgString = cy.svg({ full: true, bg: bg });
			var svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
			downloadFile(URL.createObjectURL(svgBlob), 'note-graph.svg');
		} else if (format === 'json') {
			var blob = new Blob([JSON.stringify(cy.json().elements, null, 2)], {
				type: 'application/json',
			});
			downloadFile(URL.createObjectURL(blob), 'note-graph.json');
		}
	});

	document.addEventListener('click', function () {
		menu.style.display = 'none';
	});
	closeOnEscape(
		function () {
			return menu.style.display === 'block';
		},
		function () {
			menu.style.display = 'none';
		}
	);

	return menu;
}

function downloadFile(data, filename) {
	var link = document.createElement('a');
	link.download = filename;
	link.href = data;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	if (data.indexOf('blob:') === 0) URL.revokeObjectURL(data);
}

var POLL_INTERVAL_WAITING_MS = 1000;
var POLL_INTERVAL_LIVE_MS = 3000;

function requestData() {
	webviewApi
		.postMessage({ type: 'request-data', version: lastSeenVersion })
		.then(function (response) {
			applyGraphNotice(response && response.notice);
			applySharedChoices(response && response.choices);
			if (response && response.type === 'graph-data') {
				handleGraphUpdate('graph-data', response);
			}
			if (response && response.progress) {
				var label =
					response.progress.stage === 'enrichment-progress'
						? 'Enriching notes'
						: 'Building graph';
				showPipelineProgress(label, response.progress.current, response.progress.total);
			} else {
				hidePipelineProgress();
			}
		})
		.catch(function (e) {
			console.error('Note Graph poll failed:', e);
		})
		.then(function () {
			setTimeout(
				requestData,
				hasRenderedOnce ? POLL_INTERVAL_LIVE_MS : POLL_INTERVAL_WAITING_MS
			);
		});
}

function pollForData() {
	if (typeof webviewApi === 'undefined') {
		return;
	}
	requestData();
}

/**
 * Bootstrap the graph panel: size the container, create Cytoscape, wire all UI controls
 * (zoom, search, edge toggles, focus mode, fit), observe resize and theme changes.
 */
function init() {
	var container = document.getElementById('graph-container');
	if (!container) {
		return;
	}

	applyThemeToChrome(isDarkTheme());

	statusEl = document.getElementById('graph-status');
	if (statusEl) {
		statusEl.style.display = '';
	}

	pipelineProgressEl = document.getElementById('pipeline-progress');
	pipelineProgressFillEl = document.getElementById('pipeline-progress-fill');
	pipelineProgressLabelEl = document.getElementById('pipeline-progress-label');
	pipelineProgressCancelEl = document.getElementById('pipeline-progress-cancel');
	if (pipelineProgressCancelEl) {
		pipelineProgressCancelEl.addEventListener('click', function () {
			pipelineProgressCancelEl.disabled = true;
			if (typeof webviewApi !== 'undefined') {
				webviewApi.postMessage({ type: 'cancel-analysis' }).catch(function (e) {
					console.error('Note Graph cancel failed:', e);
				});
			}
		});
	}

	tooltipEl = document.createElement('div');
	tooltipEl.className = 'graph-tooltip';
	document.body.appendChild(tooltipEl);
	keepControlsFromGraph(container);

	try {
		cy = cytoscape({
			container: container,
			style: buildStylesheet(),
			elements: [],
			wheelSensitivity: 0.3,
			// Moves a picture of the graph while panning and zooming, so a large view stays smooth.
			textureOnViewport: true,
		});

		cy.on('tap', 'node[!isCommunityParent]', onNodeTap);
		cy.on('dblclick', 'node[!isCommunityParent]', onNodeDblClick);

		var zoomInBtn = document.getElementById('graph-zoom-in');
		var zoomOutBtn = document.getElementById('graph-zoom-out');
		if (zoomInBtn) {
			zoomInBtn.addEventListener('click', function () {
				cy.zoom({
					level: cy.zoom() * 1.3,
					renderedPosition: {
						x: container.clientWidth / 2,
						y: container.clientHeight / 2,
					},
				});
			});
		}
		if (zoomOutBtn) {
			zoomOutBtn.addEventListener('click', function () {
				cy.zoom({
					level: cy.zoom() * 0.7,
					renderedPosition: {
						x: container.clientWidth / 2,
						y: container.clientHeight / 2,
					},
				});
			});
		}

		restyleGraphOnceStylesArrive();

		cy.on('mouseover', 'edge', function (evt) {
			showTooltip(edgeTooltipHtml(evt.target), pointerOf(evt), 'edge');
		});
		cy.on('mousemove', 'edge', function (evt) {
			positionTooltip(pointerOf(evt));
		});
		cy.on('mouseout', 'edge', hideTooltip);

		cy.on('mouseover', 'edge', function (evt) {
			var edge = evt.target;
			emphasizeEdges(edge, 'edge-hover');
			edge.source().addClass('edge-hover-node');
			edge.target().addClass('edge-hover-node');
		});

		cy.on('mouseout', 'edge', function (evt) {
			var edge = evt.target;
			clearEdgeEmphasis();
			edge.source().removeClass('edge-hover-node');
			edge.target().removeClass('edge-hover-node');
		});

		cy.on('mouseover', 'node[!isCommunityParent]', function (evt) {
			var node = evt.target;
			node.addClass('node-hover');
			emphasizeEdges(node.connectedEdges(), 'edge-connected');
			container.style.cursor = 'pointer';
			showTooltip(noteTooltipHtml(node), panelPointOf(node), 'note');
		});

		cy.on('mouseout', 'node[!isCommunityParent]', function (evt) {
			evt.target.removeClass('node-hover');
			clearEdgeEmphasis();
			container.style.cursor = '';
			hideTooltip();
		});

		cy.on('tap', function (evt) {
			if (evt.target === cy) {
				cy.elements().unselect();
			}
		});
		cy.on('select unselect', 'node', updateFocusAvailability);
		cy.on('zoom', function () {
			cy.nodes(':selected').updateStyle();
		});

		var resizeTimer = null;
		var lastWindowWidth = window.innerWidth;
		var lastWindowHeight = window.innerHeight;
		var lastCanvasHadSize = containerHasSize();
		var observer = new ResizeObserver(function () {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(function () {
				resizeTimer = null;
				var canvasChangedUnderAFit = viewIsAsFitted();
				// A hidden view still gets graphs, fitted to no space at all, so it refits once it can be seen.
				var hasSize = containerHasSize();
				var canvasWasHidden = hasSize && !lastCanvasHadSize;
				lastCanvasHadSize = hasSize;
				if (canvasWasHidden) hideTooltip();
				cy.resize();
				if (
					canvasWasHidden ||
					canvasChangedUnderAFit ||
					window.innerWidth !== lastWindowWidth ||
					window.innerHeight !== lastWindowHeight
				) {
					lastWindowWidth = window.innerWidth;
					lastWindowHeight = window.innerHeight;
					fitToNodePositions();
				}
			}, 120);
		});
		observer.observe(container);
		observer.observe(document.body);

		lastThemeBackground = themeBackground();
		var themeObserver = new MutationObserver(refreshThemeIfChanged);
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['style', 'class'],
		});
		themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ['style', 'class'],
		});
		themeObserver.observe(document.head, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		var fitBtn = document.getElementById('graph-fit');
		if (fitBtn) {
			fitBtn.addEventListener('click', fitToNodePositions);
		}

		var exportBtn = document.getElementById('graph-export');
		if (exportBtn) {
			createExportMenu(exportBtn);
		}

		var edgeToggles = document.querySelectorAll('.legend-panel__pill[data-edge]');
		for (var t = 0; t < edgeToggles.length; t++) {
			edgeToggles[t].addEventListener('click', function () {
				showEdgeType(this, this.classList.contains('legend-panel__pill--off'));
				applyVisibility();
				shareChoices();
			});
		}

		densitySliderEl = document.getElementById('graph-density-slider');
		densityValueEl = document.getElementById('graph-density-value');
		densityControlEl = document.getElementById('graph-density-control');
		if (densitySliderEl) {
			densitySliderEl.addEventListener('input', function () {
				showMinSimilarity(Number(this.value));
				applyVisibility();
			});
			// Shared once the slider is let go, so dragging doesn't message the plugin at every step.
			densitySliderEl.addEventListener('change', shareChoices);
		}

		var SEARCH_DEBOUNCE_MS = 400;
		var searchDebounceTimer = null;

		var searchInput = document.getElementById('graph-search');
		if (searchInput) {
			searchResultsEl = document.createElement('div');
			searchResultsEl.className = 'graph-search-results';
			searchResultsEl.hidden = true;
			searchInput.parentNode.appendChild(searchResultsEl);

			var runSearch = function (value) {
				if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
				searchDebounceTimer = null;
				currentSearchQuery = value.trim().toLowerCase();
				if (colorBy === 'search') refreshNodeColors();
				applyNodeFilters();
				searchAllNotes(currentSearchQuery);
			};

			searchInput.addEventListener('input', function () {
				var value = this.value;
				if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
				searchDebounceTimer = setTimeout(function () {
					runSearch(value);
				}, SEARCH_DEBOUNCE_MS);
			});

			document.addEventListener('click', function (e) {
				if (e.target !== searchInput && !searchResultsEl.contains(e.target)) {
					hideSearchResults();
				}
			});

			searchInput.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					var firstResult = searchResultsEl.querySelector('.graph-search-results__item');
					if (firstResult && !searchResultsEl.hidden && !searchDebounceTimer) {
						firstResult.click();
						return;
					}
					// Typed faster than the search runs, so search now and open what it finds.
					openTopResultWhenShown = true;
					runSearch(this.value);
				} else if (e.key === 'Escape' && (this.value || !searchResultsEl.hidden)) {
					e.stopPropagation();
					this.value = '';
					this.dispatchEvent(new Event('input'));
					hideSearchResults();
				}
			});
		}

		categoryFilterEl = document.getElementById('graph-category-filter');
		if (categoryFilterEl) {
			categoryFilterEl.addEventListener('change', applyNodeFilters);
		}

		tagFilterEl = document.getElementById('graph-tag-filter');
		if (tagFilterEl) {
			tagFilterEl.addEventListener('change', function () {
				postToPlugin({ type: 'set-tag-filter', tag: this.value });
			});
		}

		var colorByEl = document.getElementById('graph-color-by');
		if (colorByEl) {
			colorByEl.addEventListener('change', function () {
				colorBy = this.value;
				refreshNodeColors();
				updateNoteLegend();
				applyNodeFilters();
				shareChoices();
				if (colorBy === 'search' && !currentSearchQuery) {
					showPluginStatus('Type in the search box to color the notes that match.');
					if (searchInput) searchInput.focus();
				}
			});
		}

		depthControlEl = document.getElementById('graph-depth-control');
		depthSliderEl = document.getElementById('graph-depth-slider');
		depthValueEl = document.getElementById('graph-depth-value');
		depthLessEl = document.getElementById('graph-depth-less');
		depthMoreEl = document.getElementById('graph-depth-more');
		if (depthSliderEl) {
			depthSliderEl.addEventListener('input', showDepth);
			if (depthLessEl) depthLessEl.addEventListener('click', stepDepth.bind(null, -1));
			if (depthMoreEl) depthMoreEl.addEventListener('click', stepDepth.bind(null, 1));
			// Waits for the slider to be let go, because each step lays out a new graph.
			depthSliderEl.addEventListener('change', function () {
				currentDepth = Number(this.value);
				if (currentView && currentView.centerNoteId) {
					openConnections(currentView.centerNoteId);
				}
			});
		}

		var groupToggleEl = document.getElementById('graph-group-toggle');

		function setGroupingEnabled(enabled) {
			groupByCommunityEnabled = enabled;
			if (groupToggleEl) {
				groupToggleEl.classList.toggle('legend-panel__action-btn--active', enabled);
				groupToggleEl.setAttribute('aria-pressed', String(enabled));
			}
		}

		function requestLayout() {
			if (!hasRenderedOnce) return;
			postToPlugin({
				type: 'set-layout',
				layout: currentLayoutName,
				grouped: groupByCommunityEnabled,
			});
		}

		updateGroupToggleAvailability = function () {
			if (!groupToggleEl) return;
			var hierarchical = currentLayoutName === LAYOUT_HIERARCHICAL;
			if (hierarchical && groupByCommunityEnabled) {
				setGroupingEnabled(false);
				applyCommunityGrouping();
			}
			groupToggleEl.disabled = hierarchical;
			groupToggleEl.title = hierarchical ? 'Not available under hierarchical layout' : '';
		}

		var LAYOUT_DISPLAY_NAMES = {
			fcose: 'Organic',
			hierarchical: 'Tree',
		};
		var layoutBtnEl = document.getElementById('graph-layout-btn');
		var layoutMenuEl = document.getElementById('graph-layout-menu');
		var layoutLabelEl = document.getElementById('graph-layout-label');

		function closeLayoutMenu() {
			if (!layoutMenuEl || !layoutBtnEl) return;
			layoutMenuEl.hidden = true;
			layoutBtnEl.setAttribute('aria-expanded', 'false');
		}

		/** Only shows the choice; the plugin's layout is the one that counts, and every view it sends names it. */
		function showLayout(layoutName, grouped) {
			currentLayoutName = layoutName;
			if (layoutLabelEl)
				layoutLabelEl.textContent = LAYOUT_DISPLAY_NAMES[layoutName] || layoutName;
			if (layoutMenuEl) {
				layoutMenuEl.querySelectorAll('[data-layout]').forEach(function (item) {
					item.setAttribute(
						'aria-selected',
						String(item.getAttribute('data-layout') === layoutName)
					);
				});
			}
			setGroupingEnabled(grouped);
			updateGroupToggleAvailability();
		}
		showLayoutChoice = showLayout;

		function setLayout(layoutName) {
			showLayout(layoutName, groupByCommunityEnabled);
			requestLayout();
		}

		if (layoutBtnEl && layoutMenuEl) {
			layoutBtnEl.addEventListener('click', function (e) {
				e.stopPropagation();
				var isHidden = layoutMenuEl.hidden;
				layoutMenuEl.hidden = !isHidden;
				layoutBtnEl.setAttribute('aria-expanded', String(isHidden));
			});

			document.addEventListener('click', function (e) {
				if (
					!layoutMenuEl.hidden &&
					!layoutMenuEl.contains(e.target) &&
					e.target !== layoutBtnEl
				) {
					closeLayoutMenu();
				}
			});
			closeOnEscape(function () {
				return !layoutMenuEl.hidden;
			}, closeLayoutMenu);

			layoutMenuEl.querySelectorAll('[data-layout]').forEach(function (item) {
				item.addEventListener('click', function () {
					setLayout(item.getAttribute('data-layout'));
					closeLayoutMenu();
				});
			});

			setLayout(currentLayoutName);
		}

		if (groupToggleEl) {
			groupToggleEl.addEventListener('click', function () {
				if (currentLayoutName === LAYOUT_HIERARCHICAL) return;
				setGroupingEnabled(!groupByCommunityEnabled);
				requestLayout();
			});
		}

		focusBtnEl = document.getElementById('graph-focus');
		updateFocusAvailability();
		if (focusBtnEl) {
			focusBtnEl.addEventListener('click', function () {
				if (focusActive) {
					disengageFocusMode();
				} else if (isConnectionsView()) {
					openView({ kind: 'auto' });
				} else {
					engageFocusMode();
				}
			});
		}

		var contextMenuEl = document.createElement('div');
		contextMenuEl.className = 'graph-context-menu';
		contextMenuEl.hidden = true;
		contextMenuEl.innerHTML =
			'<button class="graph-context-menu__item" data-action="open" type="button">Open note</button>' +
			'<button class="graph-context-menu__item" data-action="focus" type="button">Focus</button>' +
			'<button class="graph-context-menu__item" data-action="connections" type="button">Show connections</button>' +
			'<button class="graph-context-menu__item" data-action="copy-id" type="button">Copy note ID</button>';
		document.body.appendChild(contextMenuEl);
		var contextMenuNodeId = null;

		function openContextMenu(node, x, y) {
			hideTooltip();
			contextMenuNodeId = node.id();
			contextMenuEl.style.left = x + 'px';
			contextMenuEl.style.top = y + 'px';
			contextMenuEl.hidden = false;
		}

		function closeContextMenu() {
			contextMenuEl.hidden = true;
			contextMenuNodeId = null;
		}

		container.addEventListener('contextmenu', function (e) {
			e.preventDefault();
		});

		cy.on('cxttap', 'node[!isCommunityParent]', function (evt) {
			evt.originalEvent.preventDefault();
			openContextMenu(evt.target, evt.originalEvent.clientX, evt.originalEvent.clientY);
		});

		document.addEventListener('click', function (e) {
			if (!contextMenuEl.hidden && !contextMenuEl.contains(e.target)) {
				closeContextMenu();
			}
		});
		closeOnEscape(function () {
			return !contextMenuEl.hidden;
		}, closeContextMenu);

		contextMenuEl.addEventListener('click', function (e) {
			var item = e.target.closest('.graph-context-menu__item');
			if (!item) return;
			var node = cy.getElementById(contextMenuNodeId);
			closeContextMenu();
			if (!node || node.empty()) return;
			if (item.getAttribute('data-action') === 'open') {
				openNote(node);
			} else if (item.getAttribute('data-action') === 'focus') {
				cy.elements().unselect();
				node.select();
				if (focusActive) {
					focusActive = false;
					showFocusState();
				}
				engageFocusMode();
			} else if (item.getAttribute('data-action') === 'connections') {
				openConnections(node.id());
			} else if (item.getAttribute('data-action') === 'copy-id') {
				copyText(node.id());
			}
		});

		viewBarEl = document.getElementById('graph-view-bar');
		viewBackEl = document.getElementById('graph-view-back');
		viewBackLabelEl = document.getElementById('graph-view-back-label');
		viewTitleEl = document.getElementById('graph-view-title');
		if (viewBackEl) {
			viewBackEl.addEventListener('click', function () {
				openView({ kind: 'auto' });
			});
		}

		showStatus('Graph engine ready: waiting for data...');
		pollForData();

		if (typeof webviewApi !== 'undefined') {
			// Joplin wraps whatever the plugin posts, so the plugin's own message is inside.
			webviewApi.onMessage(function (event) {
				var message = event && event.message;
				if (message && message.type === 'graph-data') {
					hidePipelineProgress();
					handleGraphUpdate('graph-data', message);
				}
				if (message && message.type === 'graph-patch') {
					hidePipelineProgress();
					handleGraphUpdate('graph-patch', message);
				}
				if (message && message.type === 'view-choices') {
					applySharedChoices(message.choices);
				}
				if (message && message.type === 'status' && message.text) {
					hidePipelineProgress();
					showPluginStatus(message.text, message.icon);
				}
				if (message && message.type === 'progress') {
					var label = message.stage === 'enrichment-progress' ? 'Enriching notes' : 'Building graph';
					showPipelineProgress(label, message.current, message.total);
				}
				if (message && message.type === 'focus-note') {
					openNoteId = message.noteId || null;
					if (message.noteId) {
						if (!highlightOpenNote(message.noteId)) {
							pendingFocusNoteId = message.noteId;
						}
					} else {
						pendingFocusNoteId = null;
					}
					updateFocusAvailability();
				}
			});
		}
	} catch (e) {
		console.error('Note Graph panel failed to initialize:', e);
		showStatus('Error: ' + (e && e.message ? e.message : String(e)));
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
