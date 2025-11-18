const fs = require('fs');
const vscode = require('vscode');

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activateExtension() {
	const extension = vscode.extensions.getExtension('undefined_publisher.code-ingest');
	if (!extension) {
		throw new Error('Code Ingest extension not found');
	}
	if (!extension.isActive) {
		await extension.activate();
	}
}

async function waitForTriggerFile(triggerPath, timeoutMs = 120_000) {
	if (!triggerPath) {
		return;
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(triggerPath)) {
			return;
		}
		await delay(250);
	}
	throw new Error('Timed out waiting for shutdown trigger file');
}

suite('Backend shutdown harness', function () {
	this.timeout(120_000);

	test('activate backend and await reload signal', async function () {
		await activateExtension();
		const delayMs = Number(process.env.CODE_INGEST_SHUTDOWN_DELAY ?? '8000');
		await delay(delayMs);
		const triggerPath = process.env.CODE_INGEST_SHUTDOWN_TRIGGER;
		if (!triggerPath) {
			console.warn('CODE_INGEST_SHUTDOWN_TRIGGER not set; falling back to timed reload.');
		} else {
			await waitForTriggerFile(triggerPath, 120_000);
		}
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	});
});
