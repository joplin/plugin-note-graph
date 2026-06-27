import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

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

var cy;
var statusEl;
var pollTimer;
var tooltipEl;
var nodeStats;

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
				'background-color': '#5b9bd5',
				label: 'data(label)',
				color: dark ? '#ddd' : '#222',
				'font-size': '9px',
				'text-valign': 'top',
				'text-halign': 'center',
				'text-margin-y': -4,
				'text-wrap': 'ellipsis',
				'text-max-width': '100px',
				width: 28,
				height: 28,
				'border-width': 1.5,
				'border-color': '#4a8cc4',
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

/**
 * Replace the current graph with new data. Computes per-node link/tag counts,
 * deduplicates unique tag names for the stats bar, and runs the fCoSE layout.
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

	nodeStats = {};
	var edgesArr = message.edges || [];
	var explicitCount = 0;
	var semanticCount = 0;
	var tagNames = {};

	for (var i = 0; i < edgesArr.length; i++) {
		var e = edgesArr[i].data || edgesArr[i];
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
	}

	var totalTags = Object.keys(tagNames).length;
	updateStats(message.nodes.length, explicitCount, semanticCount, totalTags);

	cy.layout(FCOSE_OPTIONS).run();

	var edgeCount = (message.edges || []).length;
	if (edgeCount === 0) {
		showStatus(message.nodes.length + ' notes, 0 connections');
	} else {
		hideStatus();
	}
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

/** Poll every second for graph data via webviewApi until the first graph-data response arrives. */
function pollForData() {
	if (typeof webviewApi === 'undefined') {
		return;
	}

	pollTimer = setInterval(function () {
		webviewApi.postMessage({ type: 'request-data' }).then(function (response) {
			if (response && response.type === 'graph-data') {
				clearInterval(pollTimer);
				renderGraph(response);
			}
		});
	}, 1000);
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

		cy.on('mouseover', 'edge[type="tag"]', function (evt) {
			var edge = evt.target;
			var tagName = edge.data('tagName');
			if (!tagName || !tooltipEl) return;
			tooltipEl.textContent = tagName;
			tooltipEl.classList.add('graph-tooltip--tag');
			tooltipEl.style.display = 'block';
		});

		cy.on('mousemove', 'edge[type="tag"]', function (evt) {
			if (!tooltipEl) return;
			tooltipEl.style.left = (evt.originalEvent.clientX + 12) + 'px';
			tooltipEl.style.top = (evt.originalEvent.clientY + 12) + 'px';
		});

		cy.on('mouseout', 'edge[type="tag"]', function () {
			if (!tooltipEl) return;
			tooltipEl.style.display = 'none';
			tooltipEl.classList.remove('graph-tooltip--tag');
		});

		cy.on('mouseover', 'node', function (evt) {
			var node = evt.target;
			var label = node.data('label') || '(untitled)';
			var id = node.id();
			var degree = node.data('degree') || 0;
			var stats = nodeStats && nodeStats[id] ? nodeStats[id] : { linkCount: 0, tagCount: 0 };
			var safeLabel = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
			tooltipEl.innerHTML = '<div class="graph-tooltip__title">' + safeLabel + '</div>'
				+ '<div class="graph-tooltip__row"><span>Degree</span><strong>' + degree + '</strong></div>'
				+ '<div class="graph-tooltip__row"><span>Links</span><strong>' + stats.linkCount + '</strong></div>'
				+ '<div class="graph-tooltip__row"><span>Tags</span><strong>' + stats.tagCount + '</strong></div>';
			tooltipEl.style.display = 'block';
		});

		cy.on('mousemove', 'node', function (evt) {
			if (!tooltipEl) return;
			tooltipEl.style.left = (evt.originalEvent.clientX + 14) + 'px';
			tooltipEl.style.top = (evt.originalEvent.clientY + 14) + 'px';
		});

		cy.on('mouseout', 'node', function () {
			if (!tooltipEl) return;
			tooltipEl.style.display = 'none';
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
				cy.nodes().style('border-width', 1.5);
				cy.nodes().style('border-color', '#4a8cc4');
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
						matches.style('border-width', 1.5);
						matches.style('border-color', '#4a8cc4');
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
					clearInterval(pollTimer);
					renderGraph(message);
				}
				if (message && message.type === 'fit-to-screen') {
					cy.fit(undefined, 30);
				}
			});
		}
	} catch (e) {
		showStatus('Error: ' + (e && e.message ? e.message : String(e)));
	}
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
