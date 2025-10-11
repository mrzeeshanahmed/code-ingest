import * as vscode from "vscode";
import { CodeIngestPanel } from "../providers/codeIngestPanel";

type PanelState = Record<string, unknown>;

export class WebviewPanelManager {
  private stateSnapshot: PanelState | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  createAndShowPanel(state?: PanelState): void {
    if (state) {
      this.setStateSnapshot(state, { emit: false });
    }

    void CodeIngestPanel.createOrShow(this.extensionUri);
  }

  setStateSnapshot(state: PanelState, options?: { emit?: boolean }): void {
    const nextState = this.stateSnapshot ? { ...this.stateSnapshot, ...state } : { ...state };
    this.stateSnapshot = nextState;

    if (options?.emit === false) {
      return;
    }

    CodeIngestPanel.restoreState({ ...nextState });
  }

  getStateSnapshot(): PanelState | undefined {
    return this.stateSnapshot ? { ...this.stateSnapshot } : undefined;
  }

  tryRestoreState(): boolean {
    if (!this.stateSnapshot) {
      return false;
    }

    return CodeIngestPanel.restoreState({ ...this.stateSnapshot });
  }
}
