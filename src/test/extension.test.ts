import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from '@vscode/test-api';

const OUTPUT_CHANNEL_NAME = 'Code-Ingest: Local RAG';
const BACKEND_READY_REGEX = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/i;
const HEALTH_JSON_REGEX = /"status"\s*:\s*"ok"/i;
const RECEIVED_QUERY_REGEX = /RECEIVED_QUERY/;
const BACKEND_START_TIMEOUT = 60_000;
const COMMAND_TIMEOUT = 60_000;

class CapturingOutputChannel implements vscode.OutputChannel {
	public readonly name: string;
	private readonly chunks: string[] = [];

	constructor(name: string) {
		this.name = name;
	}

	append(value: string): void {
		this.chunks.push(value);
	}

	appendLine(value: string): void {
		this.chunks.push(`${value}\n`);
	}

	replace(value: string): void {
		this.chunks.length = 0;
		this.chunks.push(value);
	}

	clear(): void {
		this.chunks.length = 0;
	}

	show(): void {
		// no-op for tests
	}

	hide(): void {
		// no-op for tests
	}

	dispose(): void {
		this.chunks.length = 0;
	}

	read(): string {
		return this.chunks.join('');
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOutput(channel: CapturingOutputChannel, regex: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const content = channel.read();
		const match = content.match(regex);
		if (match) {
			return match;
		}
		await delay(200);
	}
	throw new Error(`Timed out waiting for output matching ${regex}`);
}

async function waitForInfoMessage(messages: string[], matcher: RegExp, startIndex: number, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (let i = startIndex; i < messages.length; i++) {
			const msg = messages[i];
			if (matcher.test(msg)) {
				return msg;
			}
		}
		await delay(200);
	}
	throw new Error(`Timed out waiting for notification containing ${matcher}`);
}

function getExtension(): vscode.Extension<unknown> {
	const extension = vscode.extensions.all.find((ext) => ext.packageJSON.name === 'code-ingest');
	if (!extension) {
		throw new Error('Code Ingest extension not found in test environment');
	}
	return extension;
}

function ensurePythonOnPath(): void {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		return;
	}
	const workspacePath = workspaceFolder.uri.fsPath;
	const scriptsDir = path.join(workspacePath, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
	if (!fs.existsSync(scriptsDir)) {
		return;
	}
	const currentPath = process.env.PATH ?? '';
	const normalized = currentPath.toLowerCase();
	if (!normalized.includes(scriptsDir.toLowerCase())) {
		process.env.PATH = `${scriptsDir}${path.delimiter}${currentPath}`;
	}
	if (!process.env.CODE_INGEST_PORT) {
		process.env.CODE_INGEST_PORT = '0';
	}
}

suite('Code Ingest Milestone 0', function () {
	this.timeout(240_000);

	let extension: vscode.Extension<unknown>;
	let backendUrl: string | undefined;
	let channelCapture: CapturingOutputChannel;
	const infoMessages: string[] = [];
	let originalCreateOutputChannel: typeof vscode.window.createOutputChannel;
	let originalShowInformationMessage: typeof vscode.window.showInformationMessage;

	suiteSetup(async () => {
		channelCapture = new CapturingOutputChannel(OUTPUT_CHANNEL_NAME);
		const windowApi = vscode.window as typeof vscode.window & {
			createOutputChannel: typeof vscode.window.createOutputChannel;
			showInformationMessage: typeof vscode.window.showInformationMessage;
		};
		originalCreateOutputChannel = windowApi.createOutputChannel.bind(vscode.window);
		windowApi.createOutputChannel = ((...args: Parameters<typeof vscode.window.createOutputChannel>) => {
			const [name] = args;
			if (name === OUTPUT_CHANNEL_NAME) {
				return channelCapture;
			}
			return originalCreateOutputChannel(...args);
		}) as typeof vscode.window.createOutputChannel;

		originalShowInformationMessage = windowApi.showInformationMessage.bind(vscode.window);
		windowApi.showInformationMessage = ((message: string, ...rest: unknown[]) => {
			infoMessages.push(message);
			return Promise.resolve(undefined as never);
		}) as typeof vscode.window.showInformationMessage;

		ensurePythonOnPath();
		extension = getExtension();
		try {
			await extension.activate();
		} catch (error) {
			console.error('Extension activation failed', error);
			console.error('Captured backend logs:\n', channelCapture.read());
			throw error;
		}
	});

	suiteTeardown(async () => {
		const windowApi = vscode.window as typeof vscode.window & {
			createOutputChannel: typeof vscode.window.createOutputChannel;
			showInformationMessage: typeof vscode.window.showInformationMessage;
		};
		windowApi.createOutputChannel = originalCreateOutputChannel;
		windowApi.showInformationMessage = originalShowInformationMessage;
		channelCapture.dispose();
		// Explicitly run deactivate to ensure backend process stops when tests finish.
		const extensionModule = require('../extension');
		if (typeof extensionModule.deactivate === 'function') {
			await extensionModule.deactivate();
		}
	});

	test('Extension activates & spawns backend', async () => {
		assert.ok(extension.isActive, 'Extension should be active');
		const match = await waitForOutput(channelCapture, BACKEND_READY_REGEX, BACKEND_START_TIMEOUT);
		backendUrl = match[0];
		assert.ok(backendUrl, 'Backend URL not detected');
	});

	test('pingBackend command works', async () => {
		assert.ok(backendUrl, 'Backend URL required before running ping test');
		const startingIndex = infoMessages.length;
		await vscode.commands.executeCommand('code-ingest.pingBackend');
		const message = await waitForInfoMessage(infoMessages, HEALTH_JSON_REGEX, startingIndex, COMMAND_TIMEOUT);
		assert.match(message, HEALTH_JSON_REGEX, 'Ping notification must include health JSON');
	});

	test('testQuery command works', async () => {
		const startingIndex = infoMessages.length;
		await vscode.commands.executeCommand('code-ingest.testQuery');
		const message = await waitForInfoMessage(infoMessages, /backend received it/i, startingIndex, COMMAND_TIMEOUT);
		assert.ok(message.includes('backend received it'), 'Test query notification missing backend response');
	});

	test('Logs emitted to OutputChannel', async () => {
		const reopenedChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
		reopenedChannel.show(true);
		await vscode.commands.executeCommand('code-ingest.testQuery');
		await waitForOutput(channelCapture, RECEIVED_QUERY_REGEX, COMMAND_TIMEOUT);
	});
});
