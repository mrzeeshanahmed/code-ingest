import * as vscode from 'vscode';

const CONSENT_BUTTON_SEND = 'I Consent — Send';
const CONSENT_BUTTON_CANCEL = 'Cancel';
const MAX_PREVIEW_ITEMS = 10;
const CONSENT_CHANNEL_NAME = 'Code-Ingest: Local RAG';

let consentChannel: vscode.OutputChannel | undefined;

function getConsentChannel(): vscode.OutputChannel {
	if (!consentChannel) {
		consentChannel = vscode.window.createOutputChannel(CONSENT_CHANNEL_NAME);
	}

	return consentChannel;
}

function formatItems(items: Array<{ file: string; start: number; end: number }>): string {
	if (items.length === 0) {
		return 'No files selected for upload.';
	}

	const preview = items.slice(0, MAX_PREVIEW_ITEMS).map((item) => {
		const startLine = Number.isFinite(item.start) ? item.start : 0;
		const endLine = Number.isFinite(item.end) ? item.end : startLine;
		return `${item.file}: ${startLine}-${endLine}`;
	});

	if (items.length > MAX_PREVIEW_ITEMS) {
		preview.push(`+${items.length - MAX_PREVIEW_ITEMS} more`);
	}

	return preview.join('\n');
}

export async function showConsentModal(
	items: Array<{ file: string; start: number; end: number }>,
	provider: string
): Promise<{ consent: boolean }> {
	const channel = getConsentChannel();
	channel.appendLine(`Consent requested by ${provider} for ${items.length} item(s).`);

	const summary = formatItems(items);
	const heading = provider
		? `${provider} wants to send ${items.length} code snippet${items.length === 1 ? '' : 's'} for processing.`
		: `A data provider wants to send ${items.length} snippet${items.length === 1 ? '' : 's'}.`;

	const message = `${heading}\n\n${summary}`;
	const selection = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		CONSENT_BUTTON_SEND,
		CONSENT_BUTTON_CANCEL
	);

	const consent = selection === CONSENT_BUTTON_SEND;
	channel.appendLine(consent ? 'Consent granted; proceeding with upload.' : 'Consent denied or modal dismissed.');

	return { consent };
}
