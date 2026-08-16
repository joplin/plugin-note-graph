import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import svg from 'cytoscape-svg';
import layoutUtilities from 'cytoscape-layout-utilities';

cytoscape.use(fcose);
cytoscape.use(svg);
cytoscape.use(layoutUtilities);

var FCOSE_OPTIONS = {
	name: 'fcose',
	quality: 'default',
	randomize: true,
	animate: true,
	animationDuration: 800,
	fit: true,
	padding: 40,
	nodeDimensionsIncludeLabels: true,
	uniformNodeDimensions: false,
	packComponents: true,
	nodeSeparation: 200,
	nodeRepulsion: function () {
		return 20000;
	},
	gravity: 0.05,
	gravityRange: 5.0,
	idealEdgeLength: 180,
	edgeElasticity: 0.2,
	numIter: 3000,
	tile: true,
	tilingPaddingVertical: 40,
	tilingPaddingHorizontal: 40,
	step: 'all',
};

var INCREMENTAL_FCOSE_OVERRIDES = {
	randomize: false,
	animate: false,
	fit: false,
	packComponents: false,
};

var LAYOUT_FCOSE = 'fcose';
var LAYOUT_HIERARCHICAL = 'hierarchical';
var currentLayoutName = LAYOUT_FCOSE;

function buildLayoutOptions(incremental, fixedNodeConstraint) {
	if (currentLayoutName === LAYOUT_HIERARCHICAL) {
		return {
			name: 'breadthfirst',
			directed: false,
			fit: true,
			padding: 40,
			spacingFactor: 1.6,
			avoidOverlap: true,
			animate: !incremental,
			animationDuration: 500,
		};
	}

	var options = Object.assign({}, FCOSE_OPTIONS);
	if (incremental) {
		Object.assign(options, INCREMENTAL_FCOSE_OVERRIDES, {
			fixedNodeConstraint: fixedNodeConstraint || [],
		});
	}
	return options;
}

function escapeHtml(value) {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function positionTooltip(clientX, clientY, offset) {
	if (!tooltipEl) return;
	var width = tooltipEl.offsetWidth;
	var height = tooltipEl.offsetHeight;
	var vw = window.innerWidth;
	var vh = window.innerHeight;

	var left = clientX + offset;
	if (left + width > vw) left = clientX - width - offset;

	var top = clientY + offset;
	if (top + height > vh) top = clientY - height - offset;

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
var currentSearchQuery = '';
var searchBorderTimer = null;
var densitySliderEl;
var densityValueEl;
var densityControlEl;
var currentMinConfidence = 0;
var edgeTypeOff = {};
var focusBtnEl;
var focusActive = false;
var focusIsAutoFollowing = false;
var pendingFocusNoteId = null;

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

	cy.nodes().forEach(function (n) {
		if (focusHood && !focusHood.has(n)) n.hide();
		else n.show();
	});

	cy.edges().forEach(function (e) {
		var type = e.data('type');
		var filtered =
			!!edgeTypeOff[type] ||
			(type === 'semantic' &&
				typeof e.data('score') === 'number' &&
				e.data('score') < currentMinConfidence);
		var hiddenByFocus = focusHood ? !focusHood.has(e) : false;
		if (filtered || hiddenByFocus) e.hide();
		else e.show();
	});
}

function engageFocusMode() {
	if (!cy || focusActive) return;
	var sel = cy.nodes(':selected');
	if (sel.length === 0) return;
	focusActive = true;
	if (focusBtnEl) focusBtnEl.classList.add('legend-panel__action-btn--active');
	applyVisibility();
	cy.animate({ fit: { eles: focusNeighborhoodOf(sel), padding: 50 }, duration: 400 });
}

function focusNodeBeforeLayout(noteId) {
	var node = cy.getElementById(noteId);
	if (!node || node.empty()) return false;
	cy.elements().unselect();
	node.select();
	focusActive = true;
	focusIsAutoFollowing = true;
	if (focusBtnEl) focusBtnEl.classList.add('legend-panel__action-btn--active');
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
	cy.fit(undefined, 40);
}

function disengageFocusMode() {
	if (!cy || !focusActive) return;
	focusActive = false;
	focusIsAutoFollowing = false;
	if (focusBtnEl) focusBtnEl.classList.remove('legend-panel__action-btn--active');
	applyVisibility();
	cy.fit(undefined, 30);
}

function engageFocusOnNote(noteId) {
	if (!cy) return false;
	var node = cy.getElementById(noteId);
	if (!node || node.empty()) return false;
	if (focusActive && !focusIsAutoFollowing) return true;
	focusActive = true;
	focusIsAutoFollowing = true;
	if (focusBtnEl) focusBtnEl.classList.add('legend-panel__action-btn--active');
	cy.elements().unselect();
	node.select();
	applyVisibility();
	cy.animate({ fit: { eles: focusNeighborhoodOf(node), padding: 50 }, duration: 400 });
	return true;
}

function resolvePendingFocus() {
	if (!pendingFocusNoteId || !cy) return;
	var noteId = pendingFocusNoteId;
	if (engageFocusOnNote(noteId)) {
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
		realNodes.forEach(function (n) {
			if (n.parent().nonempty()) n.move({ parent: null });
		});
		cy.nodes()
			.filter(function (n) {
				return n.data('isCommunityParent');
			})
			.remove();
		return;
	}

	var communityCounts = {};
	realNodes.forEach(function (n) {
		var community = n.data('community') || 0;
		communityCounts[community] = (communityCounts[community] || 0) + 1;
	});

	var presentParentIds = {};
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
}

function refreshDensityControlVisibility() {
	if (!densityControlEl) return;
	var hasScore = false;
	cy.edges('[type="semantic"]').forEach(function (e) {
		if (typeof e.data('score') === 'number') hasScore = true;
	});
	densityControlEl.style.display = hasScore ? '' : 'none';
}

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
	categoryFilterEl.style.display = names.length === 0 && !hasUncategorized ? 'none' : '';

	applyNodeFilters();
}

function applyNodeFilters() {
	if (!cy) return;
	var query = currentSearchQuery;
	var category = categoryFilterEl ? categoryFilterEl.value : '';

	cy.nodes().stop(true, false);
	cy.nodes().removeStyle('border-width border-color');

	if (!query && !category) {
		cy.nodes().style('opacity', 1);
		return;
	}

	var matches = cy.collection();
	cy.nodes().forEach(function (n) {
		if (n.data('isCommunityParent')) return;
		var matchesSearch = !query || (n.data('label') || '').toLowerCase().indexOf(query) !== -1;
		var c = n.data('category');
		var matchesCategory =
			!category || (category === UNCATEGORIZED_FILTER_VALUE ? !c : c === category);
		var isMatch = matchesSearch && matchesCategory;
		n.style('opacity', isMatch ? 1 : 0.15);
		if (isMatch) matches = matches.union(n);
	});

	if (query && matches.length > 0) {
		matches.style('border-width', 3);
		matches.style('border-color', '#ffa500');
		if (searchBorderTimer) clearTimeout(searchBorderTimer);
		searchBorderTimer = setTimeout(function () {
			matches.removeStyle('border-width border-color');
		}, 800);
		cy.animate({ fit: { eles: matches, padding: 50 }, duration: 400 });
	}
}

function showStatus(text) {
	if (statusEl) {
		statusEl.textContent = text;
		statusEl.style.display = '';
	}
}

function hideStatus() {
	if (statusEl) {
		statusEl.style.display = 'none';
	}
}

function showPipelineProgress(label, current, total) {
	if (!pipelineProgressEl || !pipelineProgressFillEl || !pipelineProgressLabelEl) return;
	pipelineProgressEl.style.display = 'inline-flex';
	var pct = total > 0 ? Math.round((current / total) * 100) : 0;
	pipelineProgressFillEl.style.width = pct + '%';
	pipelineProgressLabelEl.textContent = label;
	if (pipelineProgressCancelEl) {
		pipelineProgressCancelEl.disabled = false;
	}
}

function hidePipelineProgress() {
	if (pipelineProgressEl) {
		pipelineProgressEl.style.display = 'none';
	}
}

/** Colors for community groups, ordered largest cluster first. First 7 are the Okabe-Ito colorblind-safe palette, 3 more added to reach 10. */
var COMMUNITY_COLORS = [
	'#e69f00', // orange
	'#56b4e9', // sky blue
	'#009e73', // bluish green
	'#f0e442', // yellow
	'#0072b2', // blue
	'#d55e00', // vermillion
	'#cc79a7', // reddish purple
	'#332288', // indigo
	'#44aa99', // teal
	'#aa4499', // purple
];

/** Neutral color for communities past the palette. A long tail of small groups isn't worth giving each one its own color. */
var COMMUNITY_OVERFLOW_COLOR = '#9aa0a6';

function communityColor(ele) {
	var community = ele.data('community') || 0;
	if (community >= COMMUNITY_COLORS.length) return COMMUNITY_OVERFLOW_COLOR;
	return COMMUNITY_COLORS[community];
}

/** Maps the 1-10 centrality score to a pixel diameter. */
function nodeDiameter(ele) {
	var size = ele.data('size') || 1;
	return 18 + (size - 1) * 3;
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

function applyThemeToChrome(dark) {
	document.documentElement.classList.toggle('theme-dark', dark);
	if (densitySliderEl) densitySliderEl.style.accentColor = dark ? '#9b6bd5' : '#5b9bd5';
}

/** Build the Cytoscape stylesheet with theme-aware colours. Tag edges are green dotted, semantic are purple dashed, explicit are dark grey solid. */
function buildStylesheet() {
	var dark = isDarkTheme();

	return [
		{
			selector: 'node[!isCommunityParent]',
			style: {
				'background-color': communityColor,
				label: 'data(label)',
				color: dark ? '#ddd' : '#222',
				'font-size': '9px',
				'text-valign': 'top',
				'text-halign': 'center',
				'text-margin-y': -4,
				'text-wrap': 'wrap',
				'text-max-width': '90px',
				'text-outline-width': 2,
				'text-outline-color': dark ? '#1e1e1e' : '#ffffff',
				'min-zoomed-font-size': 7,
				width: nodeDiameter,
				height: nodeDiameter,
				'border-width': 1.5,
				'border-color': dark ? '#1e1e1e' : '#ffffff',
			},
		},
		{
			selector: 'node[!isCommunityParent]:selected',
			style: {
				'outline-style': 'dashed',
				'outline-color': communityColor,
				'outline-width': 3,
				'outline-opacity': 1,
			},
		},
		{
			selector: 'node[?isCommunityParent]',
			style: {
				'background-color': dark ? '#ffffff' : '#000000',
				'background-opacity': dark ? 0.05 : 0.04,
				'border-width': 1.5,
				'border-style': 'dashed',
				'border-color': dark ? '#ffffff' : '#000000',
				'border-opacity': dark ? 0.28 : 0.2,
				shape: 'round-rectangle',
				label: 'data(label)',
				color: dark ? '#ccc' : '#555',
				'font-size': '10px',
				'font-weight': 600,
				'text-valign': 'top',
				'text-halign': 'center',
				'text-margin-y': -6,
				'text-outline-width': 2,
				'text-outline-color': dark ? '#1e1e1e' : '#ffffff',
				padding: '18px',
			},
		},
		{
			selector: 'edge',
			style: {
				width: function (ele) {
					var t = ele.data('type');
					if (t === 'tag') return 1;
					if (t === 'semantic') return 2;
					return 1.2;
				},
				'line-color': function (ele) {
					var t = ele.data('type');
					if (t === 'tag') return '#4caf7d';
					if (t === 'semantic') return dark ? '#a48ad9' : '#9b6bd5';
					return dark ? '#bbbbbb' : '#555';
				},
				'curve-style': 'bezier',
				'line-style': function (ele) {
					var t = ele.data('type');
					if (t === 'tag') return 'dotted';
					if (t === 'semantic') return 'dashed';
					return 'solid';
				},
				'target-arrow-shape': function (ele) {
					return ele.data('type') === 'tag' ? 'none' : 'triangle';
				},
				'target-arrow-color': function (ele) {
					var t = ele.data('type');
					if (t === 'semantic') return dark ? '#a48ad9' : '#9b6bd5';
					return dark ? '#bbbbbb' : '#555';
				},
				'arrow-scale': 0.8,
			},
		},
		{
			selector: 'edge.edge-hover',
			style: {
				'overlay-color': function (ele) {
					var t = ele.data('type');
					if (t === 'tag') return '#4caf7d';
					if (t === 'semantic') return dark ? '#a48ad9' : '#9b6bd5';
					return dark ? '#bbbbbb' : '#555';
				},
				'overlay-opacity': 0.6,
				'overlay-padding': 2,
				'z-index': 10,
			},
		},
		{
			selector: 'node.edge-hover-node, node.node-hover',
			style: {
				'outline-style': 'solid',
				'outline-color': communityColor,
				'outline-width': 3,
				'outline-opacity': 1,
				'z-index': 10,
			},
		},
	];
}

/** Post a message to open the tapped note in Joplin. */
function onNodeTap(evt) {
	var node = evt.target;
	if (typeof webviewApi !== 'undefined') {
		webviewApi.postMessage({
			type: 'node-clicked',
			nodeId: node.id(),
			nodeLabel: node.data('label'),
		});
	}
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

function registerEdgeTooltip(selector, className, resolveText) {
	cy.on('mouseover', selector, function (evt) {
		var value = resolveText(evt.target);
		if (!value || !tooltipEl) return;
		tooltipEl.className = 'graph-tooltip';
		tooltipEl.style.borderLeft = '';
		tooltipEl.innerHTML = '<div class="graph-tooltip__value">' + escapeHtml(value) + '</div>';
		tooltipEl.classList.add(className);
		tooltipEl.classList.add('is-visible');
		positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 12);
	});

	cy.on('mousemove', selector, function (evt) {
		positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 12);
	});

	cy.on('mouseout', selector, function () {
		if (!tooltipEl) return;
		tooltipEl.classList.remove('is-visible');
		tooltipEl.classList.remove(className);
	});
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

	var totalTags = Object.keys(tagNames).length;
	var noteNodeCount = cy.nodes().filter(function (n) {
		return !n.data('isCommunityParent');
	}).length;
	updateStats(noteNodeCount, explicitCount, semanticCount, totalTags);
	refreshCategoryFilterOptions();
	refreshDensityControlVisibility();
	if (groupByCommunityEnabled) {
		applyCommunityGrouping();
	}
}

/** Mirrors LouvainDetector.MIN_NOTES_FOR_LOUVAIN — below this, the graph has too few notes for meaningful structure. */
var NEAR_EMPTY_NOTE_THRESHOLD = 3;

var lastAllNotesVeryShort = false;

function noteCountLabel(count) {
	return count + (count === 1 ? ' note' : ' notes');
}

function refreshEmptyStateStatus() {
	var noteCount = cy.nodes().length;
	if (noteCount === 0) {
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
 * Replace the current graph with new data and run a full fCoSE layout.
 * @param {{ nodes: Array, edges: Array }} message - graph data from the plugin.
 */
function renderGraph(message) {
	cy.elements().remove();
	focusActive = false;
	focusIsAutoFollowing = false;
	if (focusBtnEl) focusBtnEl.classList.remove('legend-panel__action-btn--active');
	lastAllNotesVeryShort = !!(message && message.allNotesVeryShort);

	if (!message || !message.nodes || !message.nodes.length) {
		showStatus('No graph data received');
		updateStats(0, 0, 0, 0);
		return;
	}

	hideStatus();

	cy.add(message.nodes);
	cy.add(message.edges || []);

	recomputeStats();

	var focused = false;
	if (pendingFocusNoteId && focusNodeBeforeLayout(pendingFocusNoteId)) {
		pendingFocusNoteId = null;
		focused = true;
	}

	var layoutOptions = buildLayoutOptions(false);
	if (focused) {
		layoutOptions.animate = false;
		layoutOptions.fit = false;
	}
	var layout = cy.elements().layout(layoutOptions);
	if (focused) {
		layout.one('layoutstop', function () {
			applyVisibility();
			fitViewportToFocus();
		});
	} else {
		applyVisibility();
	}
	layout.run();
	refreshEmptyStateStatus();
}

function upsertElement(data) {
	var existing = cy.getElementById(data.id);
	if (existing && existing.length) {
		existing.removeData();
		existing.data(data);
	} else {
		cy.add({ data: data });
	}
}

function applyGraphPatch(patch) {
	if (!cy || !patch) return;
	var hasChanges =
		(patch.upsertedNodes && patch.upsertedNodes.length) ||
		(patch.upsertedEdges && patch.upsertedEdges.length) ||
		(patch.removedNodeIds && patch.removedNodeIds.length) ||
		(patch.removedEdgeIds && patch.removedEdgeIds.length);
	if (!hasChanges) return;

	var movableIds = {};

	(patch.removedEdgeIds || []).forEach(function (id) {
		var ele = cy.getElementById(id);
		if (ele && ele.length) {
			movableIds[ele.data('source')] = true;
			movableIds[ele.data('target')] = true;
		}
	});

	var toRemove = cy.collection();
	(patch.removedEdgeIds || []).concat(patch.removedNodeIds || []).forEach(function (id) {
		var ele = cy.getElementById(id);
		if (ele && ele.length) toRemove = toRemove.union(ele);
	});
	toRemove.remove();

	(patch.upsertedNodes || []).forEach(function (item) {
		var data = item.data || item;
		var existing = cy.getElementById(data.id);
		var isNew = !(existing && existing.length);
		upsertElement(data);
		if (isNew) movableIds[data.id] = true;
	});
	(patch.upsertedEdges || []).forEach(function (item) {
		var data = item.data || item;
		upsertElement(data);
		movableIds[data.source] = true;
		movableIds[data.target] = true;
	});

	recomputeStats();

	var fixedNodeConstraint = [];
	if (currentLayoutName === LAYOUT_FCOSE) {
		cy.nodes().forEach(function (n) {
			if (n.data('isCommunityParent')) return;
			if (!movableIds[n.id()]) {
				fixedNodeConstraint.push({ nodeId: n.id(), position: n.position() });
			}
		});
	}
	cy.elements(':visible').layout(buildLayoutOptions(true, fixedNodeConstraint)).run();

	applyVisibility();
	refreshEmptyStateStatus();
	resolvePendingFocus();
}

function definedKeys(obj) {
	return Object.keys(obj).filter(function (key) {
		return obj[key] !== undefined;
	});
}

function dataEqual(existingEle, data) {
	if (!existingEle || !existingEle.length) return false;
	var existing = existingEle.data();
	var keys = {};
	definedKeys(existing).forEach(function (key) {
		keys[key] = true;
	});
	definedKeys(data).forEach(function (key) {
		keys[key] = true;
	});
	return Object.keys(keys).every(function (key) {
		return existing[key] === data[key];
	});
}

function computeClientPatch(graphData) {
	var newNodeIds = {};
	(graphData.nodes || []).forEach(function (n) {
		newNodeIds[n.data.id] = true;
	});
	var newEdgeIds = {};
	(graphData.edges || []).forEach(function (e) {
		newEdgeIds[e.data.id] = true;
	});

	var upsertedNodes = (graphData.nodes || []).filter(function (n) {
		return !dataEqual(cy.getElementById(n.data.id), n.data);
	});
	var upsertedEdges = (graphData.edges || []).filter(function (e) {
		return !dataEqual(cy.getElementById(e.data.id), e.data);
	});

	var removedNodeIds = [];
	cy.nodes().forEach(function (n) {
		if (n.data('isCommunityParent')) return;
		if (!newNodeIds[n.id()]) removedNodeIds.push(n.id());
	});
	var removedEdgeIds = [];
	cy.edges().forEach(function (e) {
		if (!newEdgeIds[e.id()]) removedEdgeIds.push(e.id());
	});

	return {
		upsertedNodes: upsertedNodes,
		upsertedEdges: upsertedEdges,
		removedNodeIds: removedNodeIds,
		removedEdgeIds: removedEdgeIds,
	};
}

function isWholesaleChange(patch) {
	var currentCount = cy.nodes().filter(function (n) {
		return !n.data('isCommunityParent');
	}).length;
	var removedCount = (patch.removedNodeIds || []).length;

	var newCount = 0;
	(patch.upsertedNodes || []).forEach(function (item) {
		var data = item.data || item;
		var existing = cy.getElementById(data.id);
		if (!existing || !existing.length) newCount++;
	});

	if (currentCount > 0 && removedCount >= currentCount * 0.5) return true;
	var resultingCount = currentCount - removedCount + newCount;
	return newCount >= resultingCount * 0.5;
}

function handleGraphUpdate(type, message) {
	var version = message.version || 0;
	if (hasRenderedOnce && version <= lastSeenVersion) return;

	if (message && message.focusNoteId) {
		pendingFocusNoteId = message.focusNoteId;
	}

	if (type === 'graph-patch') {
		if (!hasRenderedOnce || version !== lastSeenVersion + 1) return;
		applyGraphPatch(message);
	} else if (!hasRenderedOnce) {
		renderGraph(message);
		hasRenderedOnce = true;
	} else {
		var patch = computeClientPatch(message);
		if (isWholesaleChange(patch)) {
			renderGraph(message);
		} else {
			applyGraphPatch(patch);
		}
	}

	lastSeenVersion = version;
}

/** Write counts into the stats bar elements (stat-notes, stat-explicit, stat-semantic, stat-tags). */
function updateStats(notes, explicit, semantic, tags) {
	var elNotes = document.getElementById('stat-notes');
	var elExplicit = document.getElementById('stat-explicit');
	var elSemantic = document.getElementById('stat-semantic');
	var elTags = document.getElementById('stat-tags');
	if (elNotes) elNotes.textContent = notes;
	if (elExplicit) elExplicit.textContent = explicit;
	if (elSemantic) elSemantic.textContent = semantic;
	if (elTags) elTags.textContent = tags;
}

function createExportMenu(btn) {
	var menu = document.createElement('div');
	menu.className = 'export-menu';
	menu.innerHTML =
		'<button class="export-menu__item" data-format="png"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 16l4.58-5.34a1 1 0 0 1 1.54-.08L14 15l3.35-4.47a1 1 0 0 1 1.62-.06L21 14"/><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>PNG</button><button class="export-menu__item" data-format="svg"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>SVG</button><button class="export-menu__item" data-format="json"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 18l2 2 4-4"/><path fill="none" stroke="currentColor" stroke-width="2" d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/></svg>JSON</button>';
	document.body.appendChild(menu);

	btn.addEventListener('click', function (e) {
		e.stopPropagation();
		var open = menu.style.display === 'block';
		menu.style.display = open ? 'none' : 'block';
		if (!open) {
			var rect = btn.getBoundingClientRect();
			menu.style.left = rect.left + 'px';
			menu.style.top = rect.bottom + 4 + 'px';
		}
	});

	menu.addEventListener('click', function (e) {
		e.stopPropagation();
		var item = e.target.closest('.export-menu__item');
		if (!item) return;
		var format = item.getAttribute('data-format');
		menu.style.display = 'none';
		var bg =
			getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim() ||
			'#1e1e1e';
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

	var header = document.querySelector('.panel-header');
	var legend = document.getElementById('legend-panel');
	var statsBar = document.getElementById('stats-bar');
	var headerH = header ? header.offsetHeight : 0;
	var legendH = legend ? legend.offsetHeight : 0;
	var statsH = statsBar ? statsBar.offsetHeight : 0;
	container.style.height = window.innerHeight - headerH - legendH - statsH + 'px';
	container.style.minHeight = '350px';
	container.style.width = '100%';

	document.body.style.margin = '0';
	document.body.style.padding = '0';
	document.body.style.height = window.innerHeight + 'px';

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

	try {
		cy = cytoscape({
			container: container,
			style: buildStylesheet(),
			elements: [],
			wheelSensitivity: 0.3,
		});

		cy.layoutUtilities({ componentSpacing: 120 });

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

		registerEdgeTooltip('edge[type="tag"]', 'graph-tooltip--tag', function (edge) {
			return edge.data('tagName');
		});
		registerEdgeTooltip(
			'edge[type="semantic"]',
			'graph-tooltip--relationship',
			function (edge) {
				return edge.data('relationshipLabel');
			}
		);

		cy.on('mouseover', 'edge', function (evt) {
			var edge = evt.target;
			edge.addClass('edge-hover');
			edge.source().addClass('edge-hover-node');
			edge.target().addClass('edge-hover-node');
		});

		cy.on('mouseout', 'edge', function (evt) {
			var edge = evt.target;
			edge.removeClass('edge-hover');
			edge.source().removeClass('edge-hover-node');
			edge.target().removeClass('edge-hover-node');
		});

		cy.on('mouseover', 'node[!isCommunityParent]', function (evt) {
			var node = evt.target;
			node.addClass('node-hover');
			var label = node.data('label') || '(untitled)';
			var id = node.id();
			var degree = node.data('degree') || 0;
			var community = node.data('community') || 0;
			var category = node.data('category');
			var stats = nodeStats && nodeStats[id] ? nodeStats[id] : { linkCount: 0, tagCount: 0 };
			var badge = category
				? '<div class="graph-tooltip__badge">' + escapeHtml(category) + '</div>'
				: '';
			tooltipEl.className = 'graph-tooltip';
			tooltipEl.style.borderLeft = '3px solid ' + communityColor(node);
			tooltipEl.innerHTML =
				'<div class="graph-tooltip__title">' +
				escapeHtml(label) +
				'</div>' +
				badge +
				'<div class="graph-tooltip__stats">' +
				'<span class="graph-tooltip__stat">degree <strong>' +
				degree +
				'</strong></span>' +
				'<span class="graph-tooltip__sep"></span>' +
				'<span class="graph-tooltip__stat">links <strong>' +
				stats.linkCount +
				'</strong></span>' +
				'</div>' +
				'<div class="graph-tooltip__stats">' +
				'<span class="graph-tooltip__stat">tags <strong>' +
				stats.tagCount +
				'</strong></span>' +
				'<span class="graph-tooltip__sep"></span>' +
				'<span class="graph-tooltip__stat">community <strong>' +
				community +
				'</strong></span>' +
				'</div>';
			tooltipEl.classList.add('is-visible');
			positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 14);
		});

		cy.on('mousemove', 'node[!isCommunityParent]', function (evt) {
			positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 14);
		});

		cy.on('mouseout', 'node[!isCommunityParent]', function (evt) {
			evt.target.removeClass('node-hover');
			if (!tooltipEl) return;
			tooltipEl.classList.remove('is-visible');
		});

		cy.on('tap', function (evt) {
			if (evt.target === cy) {
				cy.elements().unselect();
			}
		});

		var observer = new ResizeObserver(function () {
			var h = header ? header.offsetHeight : 0;
			var lh = legend ? legend.offsetHeight : 0;
			var sh = statsBar ? statsBar.offsetHeight : 0;
			container.style.height = window.innerHeight - h - lh - sh + 'px';
			cy.resize();
			cy.fit(undefined, 30);
		});
		observer.observe(container);
		observer.observe(document.body);

		var lastBg = getComputedStyle(document.body)
			.getPropertyValue('--joplin-background-color')
			.trim();
		var themeObserver = new MutationObserver(function () {
			var currentBg = getComputedStyle(document.body)
				.getPropertyValue('--joplin-background-color')
				.trim();
			if (currentBg !== lastBg) {
				lastBg = currentBg;
				cy.style().fromJson(buildStylesheet()).update();
				applyThemeToChrome(isDarkTheme());
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['style', 'class'],
		});
		themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ['style', 'class'],
		});

		var fitBtn = document.getElementById('graph-fit');
		if (fitBtn) {
			fitBtn.addEventListener('click', function () {
				cy.fit(undefined, 30);
			});
		}

		var exportBtn = document.getElementById('graph-export');
		if (exportBtn) {
			createExportMenu(exportBtn);
		}

		var edgeToggles = document.querySelectorAll('.legend-panel__pill[data-edge]');
		for (var t = 0; t < edgeToggles.length; t++) {
			edgeToggles[t].addEventListener('click', function () {
				var edgeType = this.getAttribute('data-edge');
				var off = this.classList.toggle('legend-panel__pill--off');
				edgeTypeOff[edgeType] = off;
				applyVisibility();
			});
		}

		densitySliderEl = document.getElementById('graph-density-slider');
		densityValueEl = document.getElementById('graph-density-value');
		densityControlEl = document.getElementById('graph-density-control');
		if (densitySliderEl) {
			densitySliderEl.addEventListener('input', function () {
				currentMinConfidence = Number(this.value) / 100;
				if (densityValueEl) densityValueEl.textContent = this.value + '%';
				applyVisibility();
			});
			applyThemeToChrome(isDarkTheme());
		}

		var SEARCH_DEBOUNCE_MS = 400;
		var searchDebounceTimer = null;

		var searchInput = document.getElementById('graph-search');
		if (searchInput) {
			searchInput.addEventListener('input', function () {
				var value = this.value;
				if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
				searchDebounceTimer = setTimeout(function () {
					currentSearchQuery = value.trim().toLowerCase();
					applyNodeFilters();
				}, SEARCH_DEBOUNCE_MS);
			});
		}

		categoryFilterEl = document.getElementById('graph-category-filter');
		if (categoryFilterEl) {
			categoryFilterEl.addEventListener('change', applyNodeFilters);
		}

		var groupToggleEl = document.getElementById('graph-group-toggle');

		function setGroupingEnabled(enabled) {
			groupByCommunityEnabled = enabled;
			if (groupToggleEl) {
				groupToggleEl.classList.toggle('legend-panel__action-btn--active', enabled);
				groupToggleEl.setAttribute('aria-pressed', String(enabled));
			}
			applyCommunityGrouping();
			applyVisibility();
		}

		function updateGroupToggleAvailability() {
			if (!groupToggleEl) return;
			var hierarchical = currentLayoutName === LAYOUT_HIERARCHICAL;
			if (hierarchical && groupByCommunityEnabled) {
				setGroupingEnabled(false);
			}
			groupToggleEl.disabled = hierarchical;
			groupToggleEl.title = hierarchical ? 'Not available under hierarchical layout' : '';
		}

		var LAYOUT_DISPLAY_NAMES = {
			fcose: 'fCoSE',
			hierarchical: 'Hierarchical',
		};
		var layoutBtnEl = document.getElementById('graph-layout-btn');
		var layoutMenuEl = document.getElementById('graph-layout-menu');
		var layoutLabelEl = document.getElementById('graph-layout-label');

		function closeLayoutMenu() {
			if (!layoutMenuEl || !layoutBtnEl) return;
			layoutMenuEl.hidden = true;
			layoutBtnEl.setAttribute('aria-expanded', 'false');
		}

		function setLayout(layoutName) {
			currentLayoutName = layoutName;
			if (layoutLabelEl)
				layoutLabelEl.textContent = LAYOUT_DISPLAY_NAMES[layoutName] || layoutName;
			if (layoutMenuEl) {
				layoutMenuEl.querySelectorAll('[data-layout]').forEach(function (item) {
					item.classList.toggle(
						'graph-pill-menu-item--active',
						item.getAttribute('data-layout') === layoutName
					);
				});
			}
			updateGroupToggleAvailability();
			if (cy.nodes().length > 0) {
				cy.elements(':visible').layout(buildLayoutOptions(false)).run();
			}
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
				if (cy.nodes().length > 0) {
					cy.elements(':visible').layout(buildLayoutOptions(false)).run();
				}
			});
		}

		focusBtnEl = document.getElementById('graph-focus');
		if (focusBtnEl) {
			focusBtnEl.addEventListener('click', function () {
				if (focusActive) {
					disengageFocusMode();
				} else {
					focusIsAutoFollowing = false;
					engageFocusMode();
				}
			});
		}

		var contextMenuEl = document.createElement('div');
		contextMenuEl.className = 'graph-context-menu';
		contextMenuEl.hidden = true;
		contextMenuEl.innerHTML =
			'<button class="graph-context-menu__item" data-action="focus" type="button">Focus</button>' +
			'<button class="graph-context-menu__item" data-action="copy-id" type="button">Copy note ID</button>';
		document.body.appendChild(contextMenuEl);
		var contextMenuNodeId = null;

		function openContextMenu(node, x, y) {
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

		contextMenuEl.addEventListener('click', function (e) {
			var item = e.target.closest('.graph-context-menu__item');
			if (!item) return;
			var node = cy.getElementById(contextMenuNodeId);
			closeContextMenu();
			if (!node || node.empty()) return;
			if (item.getAttribute('data-action') === 'focus') {
				focusIsAutoFollowing = false;
				cy.elements().unselect();
				node.select();
				if (focusActive) {
					focusActive = false;
					if (focusBtnEl) focusBtnEl.classList.remove('legend-panel__action-btn--active');
				}
				engageFocusMode();
			} else if (item.getAttribute('data-action') === 'copy-id') {
				copyText(node.id());
			}
		});

		showStatus('Graph engine ready: waiting for data...');
		pollForData();

		if (typeof webviewApi !== 'undefined') {
			webviewApi.onMessage(function (message) {
				if (message && message.type === 'graph-data') {
					hidePipelineProgress();
					handleGraphUpdate('graph-data', message);
				}
				if (message && message.type === 'graph-patch') {
					hidePipelineProgress();
					handleGraphUpdate('graph-patch', message);
				}
				if (message && message.type === 'fit-to-screen') {
					cy.fit(undefined, 30);
				}
				if (message && message.type === 'status' && message.text) {
					hidePipelineProgress();
					showStatus(message.text);
				}
				if (message && message.type === 'progress') {
					var label = message.stage === 'enrichment-progress' ? 'Enriching notes' : 'Building graph';
					showPipelineProgress(label, message.current, message.total);
				}
				if (message && message.type === 'focus-note') {
					if (message.noteId) {
						if (!engageFocusOnNote(message.noteId)) {
							pendingFocusNoteId = message.noteId;
						}
					} else {
						pendingFocusNoteId = null;
						disengageFocusMode();
					}
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
