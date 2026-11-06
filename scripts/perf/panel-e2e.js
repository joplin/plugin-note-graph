#!/usr/bin/env node
/*
 * Runs the real plugin (src/index.ts) against a fake Joplin holding a synthetic
 * vault, with the real panel (dist/ui) in a real headless browser. Reports every
 * block of the panel's thread, which in Joplin is also the UI thread.
 *
 *   npm run dist
 *   npm run perf:panel -- --notes=10500 --ai
 *
 * Options: --notes=N  --ai  --latency=MS (per API call)  --browser=PATH  --out=DIR
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const DIMENSION = 384;
const BUDGET_MS = 200;

function parseArgs() {
	const args = { notes: 10500, ai: false, latency: 1, browser: null, out: null };
	for (const arg of process.argv.slice(2)) {
		const [key, value] = arg.replace(/^--/, '').split('=');
		if (key === 'ai') args.ai = true;
		else if (key === 'notes' || key === 'latency') args[key] = Number(value);
		else args[key] = value;
	}
	args.out = args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'note-graph-perf-'));
	return args;
}

function findBrowser(explicit) {
	const candidates = [
		explicit,
		process.env.BROWSER,
		'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	];
	const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
	if (!found) throw new Error('No Chromium browser found. Pass --browser=PATH.');
	return found;
}

function seededRandom(seed) {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const hexId = (i) => i.toString(16).padStart(32, '0');

/** Groups of notes that mostly link and tag within themselves, sized unevenly like a real vault. */
function createVault(noteCount) {
	const random = seededRandom(42);
	const groupCount = Math.max(5, Math.round(noteCount / 70));
	const tagCount = Math.max(10, Math.round(noteCount / 25));
	const groupOf = [];
	for (let i = 0; i < noteCount; i++) groupOf.push(Math.floor(random() ** 2 * groupCount));

	const membersByGroup = new Map();
	groupOf.forEach((group, i) => {
		if (!membersByGroup.has(group)) membersByGroup.set(group, []);
		membersByGroup.get(group).push(i);
	});

	const padding = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(90);
	const tagNotes = new Map();
	const notes = [];
	for (let i = 0; i < noteCount; i++) {
		const members = membersByGroup.get(groupOf[i]);
		const links = [];
		for (let l = Math.floor(random() * 3); l > 0; l--) {
			const target =
				random() < 0.85
					? members[Math.floor(random() * members.length)]
					: Math.floor(random() * noteCount);
			links.push(`[link](:/${hexId(target)})`);
		}
		for (let t = 1 + Math.floor(random() * 2); t > 0; t--) {
			const tag =
				random() < 0.7 ? groupOf[i] % tagCount : Math.floor(random() ** 3 * tagCount);
			if (!tagNotes.has(tag)) tagNotes.set(tag, new Set());
			tagNotes.get(tag).add(hexId(i));
		}
		notes.push({
			id: hexId(i),
			parent_id: hexId(1000000 + (groupOf[i] % 12)),
			title: `Note ${i} about topic ${groupOf[i]}`,
			body: `${links.join(' ')} ${padding}`,
			created_time: 1600000000000 + i * 3600000,
			updated_time: 1600000000000 + i * 3600000,
			deleted_time: 0,
		});
	}

	const vectors = new Map();
	const centers = new Map();
	const vectorOf = (i) => {
		const group = groupOf[i];
		if (!centers.has(group)) {
			centers.set(
				group,
				Array.from({ length: DIMENSION }, () => random() - 0.5)
			);
		}
		const center = centers.get(group);
		const vector = center.map((value) => value + (random() - 0.5) * 0.4);
		const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
		return vector.map((value) => value / norm);
	};
	for (let i = 0; i < noteCount; i++) vectors.set(hexId(i), vectorOf(i));

	return {
		notes,
		tagNotes,
		vectors,
		folderIds: Array.from({ length: 12 }, (_, i) => hexId(1000000 + i)),
		selectedFolderId: hexId(1000000),
	};
}

/** Just enough of the Joplin plugin API, with every call counted. */
function createFakeJoplin(vault, options) {
	const callCounts = {};
	const settings = {};
	const events = { noteChange: [], selectionChange: [], sync: [], settingsChange: [] };
	const panel = { html: '', scripts: [], onMessage: null, pushed: [], waiting: [] };
	const commands = {};
	const count = (name) => {
		callCounts[name] = (callCounts[name] || 0) + 1;
	};
	const latency = () => new Promise((resolve) => setTimeout(resolve, options.latency));
	const pageOf = (items, query) => {
		const limit = query.limit || 100;
		const start = ((query.page || 1) - 1) * limit;
		return { items: items.slice(start, start + limit), has_more: start + limit < items.length };
	};

	const dataGet = async (route, query = {}) => {
		count(`data:${route[0]}${route.length > 1 ? `/${route[2] || 'item'}` : ''}`);
		await latency();
		if (route[0] === 'notes' && route.length === 1) {
			return pageOf(
				[...vault.notes].sort((a, b) => (a.id < b.id ? -1 : 1)),
				query
			);
		}
		if (route[0] === 'notes' && route.length === 2)
			return vault.notes.find((n) => n.id === route[1]);
		if (route[0] === 'notes' && route[2] === 'tags') {
			const titles = [];
			for (const [tag, ids] of vault.tagNotes)
				if (ids.has(route[1])) titles.push({ title: `tag-${tag}` });
			return { items: titles, has_more: false };
		}
		if (route[0] === 'tags' && route.length === 1) {
			return pageOf(
				Array.from(vault.tagNotes.keys(), (tag) => ({
					id: `t${tag}`,
					title: `tag-${tag}`,
				})),
				query
			);
		}
		if (route[0] === 'tags' && route[2] === 'notes') {
			const ids = vault.tagNotes.get(Number(route[1].slice(1))) || new Set();
			return pageOf(
				Array.from(ids, (id) => ({ id })),
				query
			);
		}
		if (route[0] === 'folders' && route.length === 1) {
			return pageOf(
				// The last notebook sits inside the first, so nested notebooks get exercised.
				vault.folderIds.map((id, i) => ({
					id,
					parent_id: i === vault.folderIds.length - 1 ? vault.folderIds[0] : '',
					title: `Notebook ${i}`,
				})),
				query
			);
		}
		if (route[0] === 'folders' && route[2] === 'notes') {
			return pageOf(
				vault.notes.filter((n) => n.parent_id === route[1]),
				query
			);
		}
		if (route[0] === 'events') return { items: [], cursor: 'events-1', has_more: false };
		throw new Error(`Fake Joplin has no route for ${route.join('/')}`);
	};

	const ai = {
		getIndexStatus: async () => {
			count('ai:getIndexStatus');
			return {
				state: 'ready',
				ready: true,
				modelId: 'fake-model',
				notesIndexed: vault.notes.length,
				totalNotes: vault.notes.length,
			};
		},
		getEmbeddings: async ({ noteIds, cursor, limit = 500 }) => {
			count('ai:getEmbeddings');
			await latency();
			const ids = noteIds || vault.notes.map((n) => n.id);
			const start = cursor ? Number(cursor) : 0;
			const page = ids.slice(start, start + limit);
			return {
				modelId: 'fake-model',
				dimension: DIMENSION,
				chunks: page.map((noteId) => ({
					noteId,
					chunkIndex: 0,
					chunkText: '',
					vector: vault.vectors.get(noteId),
				})),
				nextCursor: start + limit < ids.length ? String(start + limit) : undefined,
			};
		},
		search: async () => {
			count('ai:search');
			return [];
		},
		chat: async () => ({ text: '{}' }),
	};

	const joplin = {
		ai: options.ai ? ai : undefined,
		data: { get: dataGet },
		plugins: {
			register: (plugin) => {
				joplin.onStart = plugin.onStart;
			},
			dataDir: async () => os.tmpdir(),
		},
		// The native driver isn't available outside Joplin; caches fail soft and are logged.
		require: () => {
			throw new Error('sqlite3 is not available in the fake Joplin');
		},
		settings: {
			registerSection: async () => undefined,
			registerSettings: async (defs) => {
				for (const [key, def] of Object.entries(defs)) settings[key] = def.value;
				settings['noteGraph.aiAnalysisEnabled'] = options.ai;
			},
			value: async (key) => settings[key],
			values: async (keys) => Object.fromEntries(keys.map((key) => [key, settings[key]])),
			setValue: async (key, value) => {
				settings[key] = value;
				for (const handler of events.settingsChange) handler({ keys: [key] });
			},
			onChange: async (handler) => events.settingsChange.push(handler),
		},
		workspace: {
			onNoteChange: async (handler) => events.noteChange.push(handler),
			onNoteSelectionChange: async (handler) => events.selectionChange.push(handler),
			onSyncComplete: async (handler) => events.sync.push(handler),
			selectedNote: async () => (vault.selectedNoteId ? { id: vault.selectedNoteId } : null),
			selectedFolder: async () => {
				const index = vault.folderIds.indexOf(vault.selectedFolderId);
				return { id: vault.selectedFolderId, title: `Notebook ${index}` };
			},
		},
		commands: {
			register: async (command) => {
				commands[command.name] = command;
			},
			execute: async (name) => count(`command:${name}`),
		},
		views: {
			menuItems: { create: async () => undefined },
			panels: {
				create: async () => 'panel-handle',
				setHtml: async (_handle, html) => {
					panel.html = html;
				},
				addScript: async (_handle, script) => panel.scripts.push(script),
				onMessage: async (_handle, handler) => {
					panel.onMessage = handler;
				},
				show: async () => undefined,
				hide: async () => undefined,
				visible: async () => true,
				postMessage: async (_handle, message) => {
					count('panel:postMessage');
					const size = JSON.stringify(message).length;
					panel.largestMessage = Math.max(panel.largestMessage || 0, size);
					panel.pushed.push(message);
					const waiting = panel.waiting.splice(0);
					for (const respond of waiting) respond();
				},
			},
		},
	};

	return { joplin, callCounts, panel, commands, events };
}

function loadPluginWith(joplin) {
	Module._extensions['.ts'] = (module, filename) => {
		const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
			compilerOptions: { module: 'commonjs', target: 'es2019', esModuleInterop: true },
		});
		module._compile(outputText, filename);
	};
	const originalLoad = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'api') return { __esModule: true, default: joplin };
		if (request === 'api/types')
			return originalLoad.call(this, path.join(ROOT, 'api/types.ts'), parent, isMain);
		return originalLoad.call(this, request, parent, isMain);
	};
	require(path.join(ROOT, 'src/index.ts'));
}

const CONTENT_TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

function readBody(request) {
	return new Promise((resolve) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	});
}

function startServer(fake, handlers) {
	return new Promise((resolve) => {
		const server = http.createServer(async (request, response) => {
			const url = new URL(request.url, 'http://localhost');
			const json = (value) => {
				const text = JSON.stringify(value === undefined ? null : value);
				handlers.onPayload?.(text.length);
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(text);
			};

			if (url.pathname === '/') {
				response.writeHead(200, { 'Content-Type': 'text/html' });
				response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/ui/styles/panel.css"></head>
<body>${fake.panel.html}
<script>window.__AI_ENABLED = ${handlers.aiEnabled}; window.__VAULT_NOTES = ${handlers.vaultNotes};</script>
<script src="/client.js"></script>
<script src="/dist/ui/setup.js"></script>
<script src="/dist/ui/graph-view.js"></script>
<script>window.__runScenario();</script>
</body></html>`);
			} else if (url.pathname === '/client.js') {
				response.writeHead(200, { 'Content-Type': 'text/javascript' });
				response.end(fs.readFileSync(path.join(__dirname, 'panel-client.js')));
			} else if (url.pathname.startsWith('/dist/')) {
				const file = path.join(ROOT, url.pathname);
				if (!fs.existsSync(file)) {
					response.writeHead(404);
					response.end();
					return;
				}
				response.writeHead(200, {
					'Content-Type': CONTENT_TYPES[path.extname(file)] || 'text/plain',
				});
				response.end(fs.readFileSync(file));
			} else if (url.pathname === '/rpc') {
				json(await fake.panel.onMessage(JSON.parse(await readBody(request))));
			} else if (url.pathname === '/events') {
				if (fake.panel.pushed.length === 0) {
					await new Promise((done) => {
						fake.panel.waiting.push(done);
						setTimeout(done, 5000);
					});
				}
				json(fake.panel.pushed.splice(0));
			} else if (url.pathname === '/action') {
				json(await handlers.onAction(JSON.parse(await readBody(request))));
			} else if (url.pathname === '/report') {
				response.end('ok');
				handlers.onReport(JSON.parse(await readBody(request)));
			} else if (url.pathname === '/image') {
				const name = url.searchParams.get('name');
				const data = (await readBody(request)).replace(/^data:image\/png;base64,/, '');
				fs.writeFileSync(
					path.join(handlers.outDir, `${name}.png`),
					Buffer.from(data, 'base64')
				);
				response.end('ok');
			} else {
				response.writeHead(404);
				response.end();
			}
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

function summarize(report, context) {
	const lines = [];
	let worst = 0;
	lines.push('');
	lines.push(
		`${context.noteCount} notes, AI ${context.ai ? 'on' : 'off'}, ${context.browserName}`
	);
	lines.push(
		'Step'.padEnd(34) +
			'Took'.padStart(9) +
			'Worst block'.padStart(13) +
			'API calls'.padStart(11)
	);
	for (const step of report.steps) {
		if (!step.expectsPause) worst = Math.max(worst, step.worstBlock);
		const calls = context.callsByStep[step.name] ?? '';
		lines.push(
			step.name.padEnd(34) +
				`${step.tookMs} ms`.padStart(9) +
				`${step.worstBlock} ms${step.expectsPause ? '*' : ''}`.padStart(13) +
				String(calls).padStart(11)
		);
	}
	lines.push('');
	lines.push(`Worst block of the UI thread: ${worst} ms (budget ${BUDGET_MS} ms)`);
	lines.push(
		'* A one-off action where a brief pause is expected, so not counted against the budget.'
	);
	if (report.frameRate) lines.push(`Frame rate while zooming: ${report.frameRate} fps`);
	lines.push(`Largest message to the panel: ${(context.largestMessage / 1048576).toFixed(2)} MB`);
	lines.push(`Plugin heap: ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
	lines.push(`Errors: ${report.errors.length}`);
	for (const error of report.errors.slice(0, 10)) lines.push(`  ${error}`);
	lines.push(`Images and report: ${context.outDir}`);
	return { text: lines.join('\n'), worst };
}

async function main() {
	const args = parseArgs();
	const browser = findBrowser(args.browser);
	if (!fs.existsSync(path.join(ROOT, 'dist/ui/graph-view.js'))) {
		throw new Error('dist/ is missing. Run npm run dist first.');
	}

	const realInfo = console.info;
	const pluginLog = [];
	console.info = (...parts) => pluginLog.push(parts.join(' '));
	const realError = console.error;
	const pluginErrors = [];
	console.error = (...parts) => {
		const text = parts
			.map((part) => (part instanceof Error ? part.message : String(part)))
			.join(' ');
		if (!text.includes('sqlite3 is not available')) pluginErrors.push(text);
	};

	realInfo(`Creating a vault of ${args.notes} notes...`);
	const vault = createVault(args.notes);
	const fake = createFakeJoplin(vault, args);
	loadPluginWith(fake.joplin);
	await fake.joplin.onStart();

	const callsByStep = {};
	let callsAtStepStart = {};
	const totalCalls = () => Object.values(fake.callCounts).reduce((sum, value) => sum + value, 0);
	const snapshotCalls = () => {
		callsAtStepStart = { ...fake.callCounts, __total: totalCalls() };
	};

	const finish = new Promise((resolve, reject) => {
		const handlers = {
			outDir: args.out,
			aiEnabled: args.ai,
			vaultNotes: args.notes,
			onAction: async (action) => {
				if (action.type === 'stepStart') snapshotCalls();
				if (action.type === 'stepEnd') {
					callsByStep[action.name] = totalCalls() - (callsAtStepStart.__total || 0);
				}
				if (action.type === 'selectNote') {
					vault.selectedNoteId = action.noteId;
					for (const handler of fake.events.selectionChange)
						handler({ value: [action.noteId] });
				}
				if (action.type === 'selectNotebook') {
					vault.selectedFolderId = vault.folderIds[action.index];
					for (const handler of fake.events.selectionChange) handler({ value: [] });
				}
				if (action.type === 'editNote') {
					const note = vault.notes[action.index];
					note.updated_time += 1000;
					if (action.kind === 'text') note.body += ' more text';
					else note.title = `${note.title} renamed`;
					for (const handler of fake.events.noteChange)
						handler({ id: note.id, event: 2 });
				}
				if (action.type === 'createNote') {
					const id = hexId(9000000 + action.index);
					vault.notes.push({
						id,
						parent_id: vault.folderIds[0],
						title: `Brand new note ${action.index}`,
						body: `[link](:/${vault.notes[0].id})`,
						created_time: Date.now(),
						updated_time: Date.now(),
						deleted_time: 0,
					});
					vault.vectors.set(id, vault.vectors.get(vault.notes[0].id));
					for (const handler of fake.events.noteChange) handler({ id, event: 1 });
				}
				if (action.type === 'deleteNote') {
					const [note] = vault.notes.splice(action.index, 1);
					for (const handler of fake.events.noteChange)
						handler({ id: note.id, event: 3 });
				}
				return { calls: totalCalls() };
			},
			onReport: resolve,
		};
		startServer(fake, handlers).then((server) => {
			const url = `http://127.0.0.1:${server.address().port}/`;
			const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'note-graph-browser-'));
			const child = spawn(browser, [
				'--headless=new',
				'--disable-gpu',
				'--no-first-run',
				`--user-data-dir=${profile}`,
				'--window-size=900,720',
				url,
			]);
			finishHandles.server = server;
			finishHandles.child = child;
			child.on('error', reject);
		});
		const timeoutMs = 9 * 60 * 1000;
		setTimeout(
			() => reject(new Error(`Scenario did not finish in ${timeoutMs / 60000} minutes.`)),
			timeoutMs
		);
	});

	fake.commands.showNoteGraph.execute().catch((e) => pluginErrors.push(e.message));

	const report = await finish;
	report.errors = [...report.errors, ...pluginErrors];
	console.info = realInfo;
	console.error = realError;

	const { text, worst } = summarize(report, {
		noteCount: args.notes,
		ai: args.ai,
		browserName: path.basename(browser),
		callsByStep,
		largestMessage: fake.panel.largestMessage || report.largestResponse || 0,
		outDir: args.out,
	});
	console.log(text);
	fs.writeFileSync(
		path.join(args.out, 'report.json'),
		JSON.stringify({ report, callCounts: fake.callCounts, callsByStep, pluginLog }, null, 2)
	);

	finishHandles.child?.kill();
	finishHandles.server?.close();
	process.exit(report.errors.length > 0 || worst > BUDGET_MS ? 1 : 0);
}

const finishHandles = {};

main().catch((e) => {
	console.error(e);
	finishHandles.child?.kill();
	process.exit(2);
});
