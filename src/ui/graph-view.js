import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import svg from 'cytoscape-svg';

cytoscape.use(fcose);
cytoscape.use(svg);

var FCOSE_OPTIONS = {
	name: 'fcose',
	quality: 'default',
	randomize: true,
	animate: true,
	animationDuration: 800,
	fit: true,
	padding: 40,
	nodeDimensionsIncludeLabels: false,
	uniformNodeDimensions: true,
	packComponents: true,
	nodeSeparation: 140,
	nodeRepulsion: function () { return 8000; },
	gravity: 0.12,
	gravityRange: 5.0,
	idealEdgeLength: 180,
	edgeElasticity: 0.2,
	numIter: 3000,
	tile: true,
	tilingPaddingVertical: 25,
	tilingPaddingHorizontal: 25,
	step: 'all',
};

var INCREMENTAL_FCOSE_OVERRIDES = {
	randomize: false,
	animate: false,
	fit: false,
	packComponents: false,
};

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

/** Build the Cytoscape stylesheet with theme-aware colours. Tag edges are green dotted, semantic are purple dashed, explicit are dark grey solid. */
function buildStylesheet() {
	var dark = isDarkTheme();

	return [
		{
			selector: 'node',
			style: {
				'background-color': communityColor,
				label: 'data(label)',
				color: dark ? '#ddd' : '#222',
				'font-size': '9px',
				'text-valign': 'top',
				'text-halign': 'center',
				'text-margin-y': -4,
				'text-wrap': 'ellipsis',
				'text-max-width': '100px',
				width: nodeDiameter,
				height: nodeDiameter,
				'border-width': 1.5,
				'border-color': dark ? '#1e1e1e' : '#ffffff',
			},
		},
		{
			selector: 'node:selected',
			style: {
				'background-color': '#ffa500',
				'border-width': 1.5,
				'border-color': '#cc8400',
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
					if (t === 'tag') return dark ? '#3d8b5e' : '#4caf7d';
					if (t === 'semantic') return dark ? '#a48ad9' : '#9b6bd5';
					return dark ? '#999' : '#555';
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
					return dark ? '#999' : '#555';
				},
				'arrow-scale': 0.8,
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
	updateStats(cy.nodes().length, explicitCount, semanticCount, totalTags);
}

/** Mirrors LouvainDetector.MIN_NOTES_FOR_LOUVAIN — below this, the graph has too few notes for meaningful structure. */
var NEAR_EMPTY_NOTE_THRESHOLD = 3;

function noteCountLabel(count) {
	return count + (count === 1 ? ' note' : ' notes');
}

function refreshEmptyStateStatus() {
	var noteCount = cy.nodes().length;
	if (noteCount === 0) {
		showStatus('No graph data received');
	} else if (noteCount < NEAR_EMPTY_NOTE_THRESHOLD) {
		showStatus('Only ' + noteCountLabel(noteCount) + ' found. Add more notes to see a meaningful graph.');
	} else if (cy.edges().length === 0) {
		showStatus(noteCountLabel(noteCount) + ', 0 connections');
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

	if (!message || !message.nodes || !message.nodes.length) {
		showStatus('No graph data received');
		updateStats(0, 0, 0, 0);
		return;
	}

	hideStatus();

	cy.add(message.nodes);
	cy.add(message.edges || []);

	recomputeStats();
	cy.layout(FCOSE_OPTIONS).run();
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
	cy.nodes().forEach(function (n) {
		if (!movableIds[n.id()]) {
			fixedNodeConstraint.push({ nodeId: n.id(), position: n.position() });
		}
	});
	cy.layout(
		Object.assign({}, FCOSE_OPTIONS, INCREMENTAL_FCOSE_OVERRIDES, {
			fixedNodeConstraint: fixedNodeConstraint,
		})
	).run();

	refreshEmptyStateStatus();
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
	definedKeys(existing).forEach(function (key) { keys[key] = true; });
	definedKeys(data).forEach(function (key) { keys[key] = true; });
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

function handleGraphUpdate(type, message) {
	var version = message.version || 0;
	if (hasRenderedOnce && version <= lastSeenVersion) return;

	if (type === 'graph-patch') {
		if (!hasRenderedOnce || version !== lastSeenVersion + 1) return;
		applyGraphPatch(message);
	} else if (!hasRenderedOnce) {
		renderGraph(message);
		hasRenderedOnce = true;
	} else {
		applyGraphPatch(computeClientPatch(message));
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
	menu.innerHTML = '<button class="export-menu__item" data-format="png"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 16l4.58-5.34a1 1 0 0 1 1.54-.08L14 15l3.35-4.47a1 1 0 0 1 1.62-.06L21 14"/><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>PNG</button><button class="export-menu__item" data-format="svg"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>SVG</button><button class="export-menu__item" data-format="json"><svg viewBox="0 0 24 24" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 18l2 2 4-4"/><path fill="none" stroke="currentColor" stroke-width="2" d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/></svg>JSON</button>';
	document.body.appendChild(menu);

	btn.addEventListener('click', function (e) {
		e.stopPropagation();
		var open = menu.style.display === 'block';
		menu.style.display = open ? 'none' : 'block';
		if (!open) {
			var rect = btn.getBoundingClientRect();
			menu.style.left = rect.left + 'px';
			menu.style.top = (rect.bottom + 4) + 'px';
		}
	});

	menu.addEventListener('click', function (e) {
		e.stopPropagation();
		var item = e.target.closest('.export-menu__item');
		if (!item) return;
		var format = item.getAttribute('data-format');
		menu.style.display = 'none';
		var bg = getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim() || '#1e1e1e';
		if (format === 'png') {
			downloadFile(cy.png({ full: true, bg: bg }), 'note-graph.png');
		} else if (format === 'svg') {
			var svgString = cy.svg({ full: true, bg: bg });
			var svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
			downloadFile(URL.createObjectURL(svgBlob), 'note-graph.svg');
		} else if (format === 'json') {
			var blob = new Blob([JSON.stringify(cy.json().elements, null, 2)], { type: 'application/json' });
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
				var label = response.progress.stage === 'enrichment-progress' ? 'Enriching notes' : 'Building graph';
				showPipelineProgress(label, response.progress.current, response.progress.total);
			} else {
				hidePipelineProgress();
			}
		})
		.catch(function (e) {
			console.error('Note Graph poll failed:', e);
		})
		.then(function () {
			setTimeout(requestData, hasRenderedOnce ? POLL_INTERVAL_LIVE_MS : POLL_INTERVAL_WAITING_MS);
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

	var header = document.querySelector('.panel-header');
	var legend = document.getElementById('legend-panel');
	var statsBar = document.getElementById('stats-bar');
	var headerH = header ? header.offsetHeight : 0;
	var legendH = legend ? legend.offsetHeight : 0;
	var statsH = statsBar ? statsBar.offsetHeight : 0;
	container.style.height = (window.innerHeight - headerH - legendH - statsH) + 'px';
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

		cy.on('tap', 'node', onNodeTap);
		cy.on('dblclick', 'node', onNodeDblClick);

		var zoomInBtn = document.getElementById('graph-zoom-in');
		var zoomOutBtn = document.getElementById('graph-zoom-out');
		if (zoomInBtn) {
			zoomInBtn.addEventListener('click', function () {
				cy.zoom({
					level: cy.zoom() * 1.3,
					renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
				});
			});
		}
		if (zoomOutBtn) {
			zoomOutBtn.addEventListener('click', function () {
				cy.zoom({
					level: cy.zoom() * 0.7,
					renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 },
				});
			});
		}

		registerEdgeTooltip('edge[type="tag"]', 'graph-tooltip--tag', function (edge) {
			return edge.data('tagName');
		});
		registerEdgeTooltip('edge[type="semantic"]', 'graph-tooltip--relationship', function (edge) {
			return edge.data('relationshipLabel');
		});

		cy.on('mouseover', 'node', function (evt) {
			var node = evt.target;
			var label = node.data('label') || '(untitled)';
			var id = node.id();
			var degree = node.data('degree') || 0;
			var community = node.data('community') || 0;
			var category = node.data('category');
			var stats = nodeStats && nodeStats[id] ? nodeStats[id] : { linkCount: 0, tagCount: 0 };
			var badge = category ? '<div class="graph-tooltip__badge">' + escapeHtml(category) + '</div>' : '';
			tooltipEl.className = 'graph-tooltip';
			tooltipEl.innerHTML = '<div class="graph-tooltip__title">' + escapeHtml(label) + '</div>'
				+ badge
				+ '<div class="graph-tooltip__stats">'
				+ '<span class="graph-tooltip__stat">degree <strong>' + degree + '</strong></span>'
				+ '<span class="graph-tooltip__sep"></span>'
				+ '<span class="graph-tooltip__stat">links <strong>' + stats.linkCount + '</strong></span>'
				+ '</div>'
				+ '<div class="graph-tooltip__stats">'
				+ '<span class="graph-tooltip__stat">tags <strong>' + stats.tagCount + '</strong></span>'
				+ '<span class="graph-tooltip__sep"></span>'
				+ '<span class="graph-tooltip__stat">community <strong>' + community + '</strong></span>'
				+ '</div>';
			tooltipEl.classList.add('is-visible');
			positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 14);
		});

		cy.on('mousemove', 'node', function (evt) {
			positionTooltip(evt.originalEvent.clientX, evt.originalEvent.clientY, 14);
		});

		cy.on('mouseout', 'node', function () {
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
			container.style.height = (window.innerHeight - h - lh - sh) + 'px';
			cy.resize();
			cy.fit(undefined, 30);
		});
		observer.observe(container);
		observer.observe(document.body);

		var lastBg = getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim();
		var themeObserver = new MutationObserver(function () {
			var currentBg = getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim();
			if (currentBg !== lastBg) {
				lastBg = currentBg;
				cy.style().fromJson(buildStylesheet()).update();
			}
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
		themeObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

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
				if (off) {
					cy.edges('[type="' + edgeType + '"]').hide();
				} else {
					cy.edges('[type="' + edgeType + '"]').show();
				}
			});
		}

		var searchTimer = null;
		var searchInput = document.getElementById('graph-search');
		if (searchInput) {
			searchInput.addEventListener('input', function () {
				var q = this.value.trim().toLowerCase();
				if (searchTimer) clearTimeout(searchTimer);
				cy.nodes().style('opacity', 1);
				cy.nodes().removeStyle('border-width border-color');
				cy.nodes().stop(true, false);
				if (!q) return;
				cy.nodes().style('opacity', 0.15);
				var matches = cy.nodes().filter(function (n) {
					return (n.data('label') || '').toLowerCase().indexOf(q) !== -1;
				});
				matches.style('opacity', 1);
				if (matches.length > 0) {
					matches.style('border-width', 3);
					matches.style('border-color', '#ffa500');
					searchTimer = setTimeout(function () {
						matches.removeStyle('border-width border-color');
					}, 800);
					cy.animate({ fit: { eles: matches, padding: 50 }, duration: 400 });
				}
			});
		}

		var focusBtn = document.getElementById('graph-focus');
		var focusActive = false;
		if (focusBtn) {
			focusBtn.addEventListener('click', function () {
				if (focusActive) {
					focusActive = false;
					this.classList.remove('legend-panel__action-btn--active');
					cy.elements().show();
					cy.fit(undefined, 30);
					return;
				}
				var sel = cy.nodes(':selected');
				if (sel.length === 0) return;
				focusActive = true;
				this.classList.add('legend-panel__action-btn--active');
				cy.elements().hide();
				var hood = sel.closedNeighborhood().add(sel.neighborhood().nodes().neighborhood());
				hood.show();
				sel.show();
				cy.animate({ fit: { eles: hood, padding: 50 }, duration: 400 });
			});
		}

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
