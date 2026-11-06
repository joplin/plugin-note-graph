import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The panel shares Joplin's UI thread, and running a layout there froze and then
 * crashed Joplin on a 10,500-note vault. Layouts belong in GraphLayoutEngine, and
 * these checks fail if one ever finds its way back into the panel.
 */
describe('graph-view.js', () => {
	const source = readFileSync(join(__dirname, 'graph-view.js'), 'utf8');

	it('does not load a force layout', () => {
		expect(source).not.toMatch(/from ['"]cytoscape-fcose['"]/);
		expect(source).not.toMatch(/name:\s*['"](fcose|cose|breadthfirst)['"]/);
	});

	it('never runs a layout', () => {
		expect(source).not.toMatch(/\.layout\(/);
	});

	it('reads pushed messages from where Joplin puts them', () => {
		expect(source).toMatch(
			/webviewApi\.onMessage\(function \(event\) \{\s*var message = event && event\.message;/
		);
	});

	it('keeps the categories hidden', () => {
		expect(source).toMatch(/var CATEGORIES_SHOWN = false;/);
	});

	it('has no cluster views left', () => {
		expect(source).not.toMatch(/isCluster|isOverview|clusterId/);
	});
});
