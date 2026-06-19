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

function isDarkTheme() {
	var bg = getComputedStyle(document.body).getPropertyValue('--joplin-background-color').trim();
	if (!bg) return false;

	var r = parseInt(bg.slice(1, 3), 16);
	var g = parseInt(bg.slice(3, 5), 16);
	var b = parseInt(bg.slice(5, 7), 16);
	var lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return lum < 128;
}

function buildStylesheet() {
	var dark = isDarkTheme();

	return [
		{
			selector: 'node',
			style: {
				'background-color': dark ? '#5b9bd5' : '#5b9bd5',
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
				'border-width': 0,
			},
		},
		{
			selector: 'node:selected',
			style: {
				'background-color': '#ffa500',
				'border-width': 0,
			},
		},
		{
			selector: 'edge',
			style: {
				width: function (ele) {
					return ele.data('type') === 'tag' ? 1 : 2;
				},
				'line-color': function (ele) {
					return ele.data('type') === 'tag'
						? dark ? '#666' : '#b0b0b0'
						: dark ? '#999' : '#555';
				},
				'curve-style': 'bezier',
				'line-style': function (ele) {
					return ele.data('type') === 'tag' ? 'dotted' : 'solid';
				},
				'target-arrow-shape': function (ele) {
					return ele.data('type') === 'tag' ? 'none' : 'triangle';
				},
				'target-arrow-color': dark ? '#999' : '#555',
				'arrow-scale': 0.8,
			},
		},
	];
}

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

function onNodeDblClick(evt) {
	var node = evt.target;
	cy.animate({
		fit: { eles: node, padding: 40 },
		center: { eles: node },
		duration: 400,
	});
}

function renderGraph(message) {
	if (!message || !message.nodes || !message.nodes.length) {
		showStatus('No graph data received');
		return;
	}

	var nodeCount = message.nodes.length;
	var edgeCount = (message.edges || []).length;

	if (edgeCount === 0) {
		showStatus(nodeCount + ' notes loaded, 0 connections found');
		return;
	}

	hideStatus();

	cy.elements().remove();
	cy.add(message.nodes);
	cy.add(message.edges);

	cy.layout(FCOSE_OPTIONS).run();
}

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

function init() {
	var container = document.getElementById('graph-container');
	if (!container) {
		return;
	}

	var header = document.querySelector('.panel-header');
	var headerH = header ? header.offsetHeight : 0;
	container.style.height = (window.innerHeight - headerH) + 'px';
	container.style.minHeight = '350px';
	container.style.width = '100%';

	document.body.style.margin = '0';
	document.body.style.padding = '0';
	document.body.style.height = window.innerHeight + 'px';

	statusEl = document.getElementById('graph-status');
	if (statusEl) {
		statusEl.style.display = '';
	}

	try {
		cy = cytoscape({
			container: container,
			style: buildStylesheet(),
			elements: [],
			wheelSensitivity: 0.3,
		});

		cy.on('tap', 'node', onNodeTap);
		cy.on('dblclick', 'node', onNodeDblClick);

		cy.on('tap', function (evt) {
			if (evt.target === cy) {
				cy.elements().unselect();
			}
		});

		var observer = new ResizeObserver(function () {
			var h = header ? header.offsetHeight : 0;
			container.style.height = (window.innerHeight - h) + 'px';
			cy.resize();
			cy.fit(undefined, 30);
		});
		observer.observe(container);
		observer.observe(document.body);

		showStatus('Graph engine ready: waiting for data...');
		pollForData();

		if (typeof webviewApi !== 'undefined') {
			webviewApi.onMessage(function (message) {
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
