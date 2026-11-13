const path = require('path');

module.exports = {
	mode: 'production',
	target: 'web',
	entry: './src/ui/graph-view.js',
	output: {
		filename: 'ui/graph-view.js',
		path: path.resolve(__dirname, 'dist'),
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: 'ts-loader',
				exclude: /node_modules/,
			},
		],
	},
	resolve: {
		extensions: ['.ts', '.js'],
	},
};
