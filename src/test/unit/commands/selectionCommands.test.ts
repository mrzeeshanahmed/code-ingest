import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { COMMAND_MAP } from "../../../commands/commandMap";
import {
	registerSelectionCommands,
	markSelectionHandlersReady,
	__testing as selectionTesting
} from "../../../commands/selectionCommands";
import type { CommandRegistrar, CommandServices } from "../../../commands/types";

describe("selectionCommands", () => {
	const registerCommandMock = vscode.commands.registerCommand as jest.MockedFunction<
		typeof vscode.commands.registerCommand
	>;

	let context: vscode.ExtensionContext;
		let services: CommandServices;
	let setStateSnapshotMock: jest.Mock;
	let sendCommandMock: jest.Mock;
	let updateSelectionMock: jest.Mock;
		let withSelectionLockMock: jest.Mock;
	let getSelectionMock: jest.Mock;
	let getWorkspaceRootMock: jest.Mock;

	beforeEach(() => {
		selectionTesting.resetReadiness();
		registerCommandMock.mockClear();

		context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

		setStateSnapshotMock = jest.fn();
		sendCommandMock = jest.fn();
		updateSelectionMock = jest.fn();
		getSelectionMock = jest.fn(() => ["src/index.ts"]);
		getWorkspaceRootMock = jest.fn(() => vscode.Uri.file("/workspace"));
					withSelectionLockMock = jest.fn(async (operation: () => unknown) => operation()) as unknown as jest.Mock;

			services = {
				diagnostics: { add: jest.fn(), getAll: jest.fn(() => []), clear: jest.fn() },
				gitignoreService: {},
				workspaceManager: {
					getWorkspaceRoot: getWorkspaceRootMock,
				withSelectionLock: withSelectionLockMock as unknown as CommandServices["workspaceManager"]["withSelectionLock"],
					updateSelection: updateSelectionMock,
					getSelection: getSelectionMock,
					selectAll: jest.fn(() => []),
					clearSelection: jest.fn(),
					setSelection: jest.fn(() => []),
					expandAll: jest.fn(),
					collapseAll: jest.fn(),
					getExpandStateObject: jest.fn(() => ({})),
					getTree: jest.fn(() => [])
				},
				webviewPanelManager: {
					setStateSnapshot: setStateSnapshotMock,
					sendCommand: sendCommandMock
				},
				performanceMonitor: {} as CommandServices["performanceMonitor"],
				diagnosticService: {} as CommandServices["diagnosticService"],
				configurationService: {} as CommandServices["configurationService"],
				errorReporter: {} as CommandServices["errorReporter"],
				extensionUri: vscode.Uri.file("/extension"),
				outputWriter: {} as CommandServices["outputWriter"]
			} as unknown as CommandServices;
	});

	afterEach(() => {
		for (const disposable of context.subscriptions ?? []) {
			disposable?.dispose?.();
		}
		(context.subscriptions as vscode.Disposable[]).length = 0;
	});

	const registerAndGetHandler = (commandId: string) => {
		const registrar: CommandRegistrar = (id, handler) => vscode.commands.registerCommand(id, handler);
		registerSelectionCommands(context, services, registrar);
		const commandApi = vscode.commands as unknown as {
			__getRegisteredCommands(): Map<string, (...args: unknown[]) => unknown>;
		};
		const handler = commandApi.__getRegisteredCommands().get(commandId);
		if (!handler) {
			throw new Error(`Command ${commandId} was not registered`);
		}
		return handler as (...args: unknown[]) => Promise<unknown>;
	};

	it("updates selection when payload is valid", async () => {
		const handler = registerAndGetHandler(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION);

		const runPromise = handler({ filePath: "/workspace/src/index.ts", selected: true });
		markSelectionHandlersReady();
		const result = await runPromise;

		expect(result).toEqual({ ok: true });
		expect(updateSelectionMock).toHaveBeenCalledWith("src/index.ts", true);
		expect(withSelectionLockMock).toHaveBeenCalledTimes(1);
		expect(setStateSnapshotMock).toHaveBeenCalledWith({ selection: ["src/index.ts"] }, { emit: false });
	});

	it("rejects selections outside the workspace", async () => {
		const handler = registerAndGetHandler(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION);

		const runPromise = handler({ filePath: "/other/src/app.ts", selected: true });
		markSelectionHandlersReady();
		const result = await runPromise;

		expect(result).toEqual({ ok: false, reason: "outside_workspace" });
		expect(updateSelectionMock).not.toHaveBeenCalled();
		expect(sendCommandMock).toHaveBeenCalledWith(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
			title: "Invalid selection",
			message: expect.stringContaining("outside the workspace")
		});
	});

	it("rejects invalid payloads without touching workspace state", async () => {
		const handler = registerAndGetHandler(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION);

		const runPromise = handler({ filePath: "/workspace/src/app.ts", selected: "yes" });
		markSelectionHandlersReady();
		const result = await runPromise;

		expect(result).toEqual({ ok: false, reason: "invalid_payload" });
		expect(updateSelectionMock).not.toHaveBeenCalled();
		expect(sendCommandMock).toHaveBeenCalledWith(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
			title: "Invalid selection",
			message: expect.stringContaining("target state")
		});
		expect(withSelectionLockMock).not.toHaveBeenCalled();
	});
});