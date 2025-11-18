// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as net from 'net';

const PYTHON_EXECUTABLES = ['python', 'python3', 'py'];
const START_TIMEOUT_MS = 8000;
const OUTPUT_CHANNEL_NAME = 'Code-Ingest: Local RAG';
const LOCAL_HOST = '127.0.0.1';
const DEFAULT_PORT_RANGE: [number, number] = [43880, 43899];
const PORT_PROBE_TIMEOUT_MS = 200;

let backendProcess: ChildProcess | undefined;
let backendUrl: string | undefined;
let backendChannel: vscode.OutputChannel | undefined;

type BackendUrlCheck = {
	url: string;
	channel: vscode.OutputChannel;
};

function ensureOutputChannel(): vscode.OutputChannel {
	if (!backendChannel) {
		backendChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	}

	return backendChannel;
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null || proc.signalCode !== null) {
			resolve(true);
			return;
		}

		let settled = false;

		const cleanup = () => {
			if (settled) {
				return;
			}
			settled = true;
			proc.off('exit', handleExit);
			proc.off('close', handleExit);
			clearTimeout(timer);
		};

		const handleExit = () => {
			cleanup();
			resolve(true);
		};

		const timer = setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);

		proc.once('exit', handleExit);
		proc.once('close', handleExit);
	});
}

async function stopBackendProcessGracefully(): Promise<void> {
	const proc = backendProcess;
	const channel = ensureOutputChannel();
	if (!proc) {
		backendUrl = undefined;
		channel.appendLine('Stopped backend.');
		return;
	}

	channel.appendLine('Stopping backend process...');
	let exited = proc.exitCode !== null || proc.signalCode !== null;

	if (!exited) {
		try {
			proc.kill('SIGINT');
		} catch (error) {
			channel.appendLine(`Failed to send SIGINT: ${error instanceof Error ? error.message : String(error)}`);
		}
		exited = await waitForProcessExit(proc, 2000);
	}

	if (!exited) {
		channel.appendLine('Backend still running after SIGINT; forcing kill.');
		try {
			proc.kill();
		} catch (error) {
			channel.appendLine(`Failed to force kill backend: ${error instanceof Error ? error.message : String(error)}`);
		}
		await waitForProcessExit(proc, 500);
	}

	backendProcess = undefined;
	backendUrl = undefined;
	channel.appendLine('Stopped backend.');
}

function disposeBackend(): void {
	if (backendProcess && !backendProcess.killed) {
		backendProcess.kill();
	}

	backendProcess = undefined;
	backendUrl = undefined;
}

function probePort(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		let settled = false;

		const finish = (isFree: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(isFree);
		};

		const timer = setTimeout(() => {
			finish(true);
		}, PORT_PROBE_TIMEOUT_MS);

		socket.once('connect', () => {
			clearTimeout(timer);
			finish(false);
		});

		socket.once('timeout', () => {
			clearTimeout(timer);
			finish(true);
		});

		socket.once('error', (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
				finish(true);
			} else {
				finish(false);
			}
		});

		socket.connect({ host: LOCAL_HOST, port });
		socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
	});
}

export async function findFreePort(preferredRange: [number, number] = DEFAULT_PORT_RANGE): Promise<number> {
	const [rawStart, rawEnd] = preferredRange;
	const start = Math.min(rawStart, rawEnd);
	const end = Math.max(rawStart, rawEnd);

	for (let port = start; port <= end; port++) {
		// Sequential probing keeps traffic predictable and honors the per-port timeout constraint.
		const isFree = await probePort(port);
		if (isFree) {
			return port;
		}
	}

	return 0;
}

async function resolveRequestedPort(channel: vscode.OutputChannel): Promise<number> {
	const envValue = process.env.CODE_INGEST_PORT;
	if (envValue !== undefined) {
		const parsedPort = Number.parseInt(envValue, 10);
		if (Number.isFinite(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
			channel.appendLine(`Using CODE_INGEST_PORT=${parsedPort}.`);
			return parsedPort;
		}
		channel.appendLine(`Invalid CODE_INGEST_PORT value "${envValue}". Scanning for a free port instead.`);
	}

	const freePort = await findFreePort();
	if (freePort === 0) {
		channel.appendLine('No free port found in the preferred range. Backend will request an ephemeral port.');
	}
	return freePort;
}

async function spawnBackend(context: vscode.ExtensionContext): Promise<{ proc: ChildProcess; url: string }> {
	const channel = ensureOutputChannel();
	channel.appendLine('Starting Code Ingest backend...');
	channel.show(true);

	const backendDir = path.join(context.extensionPath, 'backend');
	const backendScript = path.join(backendDir, 'run.py');

	const requestedPort = await resolveRequestedPort(channel);

	const env = { ...process.env } as NodeJS.ProcessEnv;
	env.CODE_INGEST_PORT = String(requestedPort);
	env.CODE_INGEST_HOST = LOCAL_HOST;
	env.UVICORN_HOST = LOCAL_HOST;
	env.UVICORN_PORT = String(requestedPort);

	const spawnOptions = {
		cwd: backendDir,
		env
	};

	const trySpawn = (executable: string): Promise<ChildProcess> => {
		return new Promise((resolve, reject) => {
			const proc = spawn(executable, [backendScript], spawnOptions);

			const handleError = (err: NodeJS.ErrnoException) => {
				proc.removeListener('spawn', handleSpawn);
				reject(err);
			};

			const handleSpawn = () => {
				proc.removeListener('error', handleError);
				resolve(proc);
			};

			proc.once('error', handleError);
			proc.once('spawn', handleSpawn);
		});
	};

	let proc: ChildProcess | undefined;
	let lastError: Error | undefined;

	for (const executable of PYTHON_EXECUTABLES) {
		try {
			proc = await trySpawn(executable);
			channel.appendLine(`Spawned backend with "${executable}".`);
			break;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				channel.appendLine(`Python executable "${executable}" not found.`);
				lastError = err;
				continue;
			}

			throw err;
		}
	}

	if (!proc) {
		throw new Error(lastError?.message ?? 'Unable to locate a Python executable to launch the backend.');
	}

	const urlRegex = new RegExp(`https?:\\/\\/${LOCAL_HOST}:(\\d+)`, 'i');
	const startupRegex = /BACKEND_STARTUP port=(\d+)/i;
	let stdoutBuffer = '';

	proc.stdout?.setEncoding('utf8');
	proc.stderr?.setEncoding('utf8');

	const urlPromise = new Promise<string>((resolve, reject) => {
		let resolved = false;

		const cleanup = () => {
			proc.stdout?.off('data', handleStdout);
			proc.stderr?.off('data', handleStderr);
			proc.off('error', handleError);
		};

		const onTimeout = () => {
			if (!resolved) {
				channel.appendLine('Backend startup timed out after 8 seconds.');
				if (!proc.killed) {
					proc.kill();
				}
				cleanup();
				disposeBackend();
				reject(new Error('Backend failed to announce URL within 8 seconds.'));
			}
		};

		const timeout = setTimeout(onTimeout, START_TIMEOUT_MS);

		const handleStdout = (chunk: string) => {
			channel.append(chunk);
			stdoutBuffer = `${stdoutBuffer}${chunk}`;
			if (stdoutBuffer.length > 4096) {
				stdoutBuffer = stdoutBuffer.slice(-4096);
			}

			const match = stdoutBuffer.match(urlRegex);
			if (match && !resolved) {
				const detectedUrl = match[0];
				resolved = true;
				clearTimeout(timeout);
				backendUrl = detectedUrl;
				channel.appendLine(`Backend is ready at ${detectedUrl}`);
				resolve(detectedUrl);
			}

			if (!resolved) {
				const startupMatch = stdoutBuffer.match(startupRegex);
				if (startupMatch) {
					const port = startupMatch[1];
					const detectedUrl = `http://${LOCAL_HOST}:${port}`;
					resolved = true;
					clearTimeout(timeout);
					backendUrl = detectedUrl;
					channel.appendLine(`Backend is ready at ${detectedUrl}`);
					resolve(detectedUrl);
				}
			}
		};

		const handleStderr = (chunk: string) => {
			channel.append(chunk);
		};

		const handleError = (error: Error) => {
			channel.appendLine(`Backend process error: ${error.message}`);
			if (!resolved) {
				clearTimeout(timeout);
				cleanup();
				if (!proc.killed) {
					proc.kill();
				}
				disposeBackend();
				reject(error);
			}
		};

		proc.stdout?.on('data', handleStdout);
		proc.stderr?.on('data', handleStderr);
		proc.on('error', handleError);

		proc.once('exit', (code, signal) => {
			channel.appendLine(`Backend process exited (${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).`);
			if (!resolved) {
				clearTimeout(timeout);
				cleanup();
				disposeBackend();
				reject(new Error('Backend exited before announcing its URL.'));
			} else {
				cleanup();
				if (backendProcess === proc) {
					disposeBackend();
				}
			}
		});
	});

	const url = await urlPromise;
	backendProcess = proc;

	return { proc, url };
}

function ensureBackendUrl(kind: 'warning' | 'error'): BackendUrlCheck | undefined {
	if (!backendUrl) {
		const message = 'Backend is not running yet. Start it before using this command.';
		if (kind === 'warning') {
			vscode.window.showWarningMessage(message);
		}else{
			vscode.window.showErrorMessage(message);
		}
		const ch = ensureOutputChannel();
		ch.appendLine('Backend URL missing; command aborted.');
		return undefined;
	}

	return { url: backendUrl, channel: ensureOutputChannel() };
}

async function parseResponseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "code-ingest" is now active!');

	const channel = ensureOutputChannel();
	channel.appendLine('Code Ingest extension activating...');

	const showLogsDisposable = vscode.commands.registerCommand('code-ingest.showLogs', () => {
		const logChannel = ensureOutputChannel();
		logChannel.show(true);
	});
	context.subscriptions.push(showLogsDisposable);

	const pingDisposable = vscode.commands.registerCommand('code-ingest.pingBackend', async () => {
		const check = ensureBackendUrl('warning');
		if (!check) {
			return;
		}

		const { url, channel: logChannel } = check;
		const requestUrl = `${url}/health`;
		logChannel.appendLine(`Ping backend: GET ${requestUrl}`);

		try {
			const response = await fetch(requestUrl, { method: 'GET' });
			logChannel.appendLine(`Ping response status: ${response.status}`);
			if (!response.ok) {
				throw new Error(`Backend returned status ${response.status}`);
			}
			const json = await parseResponseJson(response);
			const payload = JSON.stringify(json);
			logChannel.appendLine(`Ping response body: ${payload}`);
			vscode.window.showInformationMessage(payload);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logChannel.appendLine(`Ping backend failed: ${msg}`);
			vscode.window.showErrorMessage(`Ping backend failed: ${msg}`);
		}
	});
	context.subscriptions.push(pingDisposable);

	const testQueryDisposable = vscode.commands.registerCommand('code-ingest.testQuery', async () => {
		const check = ensureBackendUrl('error');
		if (!check) {
			return;
		}

		const { url, channel: logChannel } = check;
		const requestUrl = `${url}/query`;
		const body = { repo_id: 'TEST', query: 'hello backend' };
		logChannel.appendLine(`Test query: POST ${requestUrl} body=${JSON.stringify(body)}`);

		try {
			const response = await fetch(requestUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});
			logChannel.appendLine(`Test query status: ${response.status}`);
			if (!response.ok) {
				throw new Error(`Backend returned status ${response.status}`);
			}
			const json = await parseResponseJson(response);
			const payload = JSON.stringify(json);
			logChannel.appendLine(`Test query response: ${payload}`);
			vscode.window.showInformationMessage(payload);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logChannel.appendLine(`Test query failed: ${msg}`);
			vscode.window.showErrorMessage(`Test query failed: ${msg}`);
		}
	});
	context.subscriptions.push(testQueryDisposable);

	try {
		const { proc, url } = await spawnBackend(context);
		backendProcess = proc;
		backendUrl = url;

		context.subscriptions.push(new vscode.Disposable(() => {
			disposeBackend();
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to start Code Ingest backend: ${message}`);
		throw error;
	}

	const disposable = vscode.commands.registerCommand('code-ingest.helloWorld', () => {
		const message = backendUrl ? `Hello from Code Ingest backend at ${backendUrl}` : 'Hello World from Code Ingest!';
		vscode.window.showInformationMessage(message);
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export async function deactivate() {
	await stopBackendProcessGracefully();
	backendChannel?.appendLine('Extension deactivated; backend process terminated.');
}
