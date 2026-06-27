const path = require('path');

module.exports = {
	mode: 'production',
	target: 'web',
	entry: './src/ui/graph-view.js',
	output: {
		filename: 'ui/graph-view.js',
		path: path.resolve(__dirname, 'dist'),
	},
	resolve: {
		extensions: ['.js'],
	},
};
