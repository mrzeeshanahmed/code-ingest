import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'default',
		files: 'out/test/**/*.test.js',
	},
	{
		label: 'shutdown',
		files: 'tools/tests/shutdown-suite.js',
	},
]);
