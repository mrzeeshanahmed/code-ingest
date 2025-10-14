import * as vscode from "vscode";
import { CodeIngestPanel } from "../providers/codeIngestPanel";
import { DashboardViewProvider } from "../providers/dashboardViewProvider";
import type { HostCommandId } from "../commands/commandMap";

type PanelState = Record<string, unknown>;

export class WebviewPanelManager {
  private stateSnapshot: PanelState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ensureResourcesReady: () => Promise<void>
  ) {}

  async createAndShowPanel(state?: PanelState): Promise<void> {
    if (state) {
      this.setStateSnapshot(state, { emit: false });
    }
    await this.ensureResourcesReady();
    const focusCommand = `${DashboardViewProvider.viewType}.focus`;
    try {
      await vscode.commands.executeCommand(focusCommand);
    } catch (focusError) {
      try {
        await CodeIngestPanel.createOrShow(this.extensionUri);
      } catch (panelError) {
        console.error("WebviewPanelManager: failed to show dashboard panel", {
          focusError,
          panelError
        });
      }
    }
  }

  setStateSnapshot(state: PanelState, options?: { emit?: boolean }): void {
    const nextState = this.stateSnapshot ? { ...this.stateSnapshot, ...state } : { ...state };
    this.stateSnapshot = nextState;

    if (options?.emit === false) {
      return;
    }
    const snapshot = { ...nextState };
    const delivered = DashboardViewProvider.restoreState(snapshot);
    if (!delivered) {
      CodeIngestPanel.restoreState({ ...snapshot });
      return;
    }
    CodeIngestPanel.restoreState({ ...snapshot });
  }

  getStateSnapshot(): PanelState | undefined {
    return this.stateSnapshot ? { ...this.stateSnapshot } : undefined;
  }

  tryRestoreState(): boolean {
    if (!this.stateSnapshot) {
      return false;
    }
    const snapshot = { ...this.stateSnapshot };
    const viewRestored = DashboardViewProvider.restoreState({ ...snapshot });
    const panelRestored = CodeIngestPanel.restoreState({ ...snapshot });
    return viewRestored || panelRestored;
  }

  sendCommand(command: HostCommandId, payload: unknown, options?: { expectsAck?: boolean }): void {
    const deliveredToView = DashboardViewProvider.postCommand(command, payload, options);
    const deliveredToPanel = CodeIngestPanel.postCommand(command, payload, options);

    if (!deliveredToView && !deliveredToPanel) {
      console.warn("WebviewPanelManager: unable to deliver command", { command });
    }
  }
}
