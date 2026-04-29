import * as vscode from "vscode";
import { ConfigurationService } from "../configurationService";

const CONSENT_STORAGE_KEY = "codeIngest.telemetry.consent";
const CONSENT_DIALOG_KEY = "codeIngest.telemetry.consentDialog";

export interface TelemetryConsent {
  granted: boolean;
  version: string;
  timestamp: Date;
  level: "off" | "error" | "usage" | "all";
}

export class ConsentManager {
  private readonly CONSENT_VERSION = "1.0";

  constructor(private readonly configService: ConfigurationService, private readonly context: vscode.ExtensionContext) {}

  async checkAndRequestConsent(): Promise<boolean> {
    const storedConsent = this.getStoredConsent();
    if (storedConsent && storedConsent.version === this.CONSENT_VERSION) {
      return storedConsent.granted;
    }

    if (this.hasShownConsentDialog()) {
      return false;
    }

    const granted = await this.showConsentDialog();
    await this.storeConsent({
      granted,
      version: this.CONSENT_VERSION,
      timestamp: new Date(),
      level: granted ? "usage" : "off"
    });
    return granted;
  }

  async showConsentDialog(): Promise<boolean> {
    const detail = [
      "Code Ingest collects anonymous usage analytics to improve stability and performance.",
      "\nData collected includes:",
      "• Aggregate feature usage counts",
      "• Performance metrics (timings, resource usage)",
      "• Error categories and recovery statistics",
      "\nNo personal or project-identifiable information is collected, and telemetry is optional.",
      "You can change this decision at any time in the settings."
    ].join("\n");

    const selection = await vscode.window.showInformationMessage(
      "Help us improve Code Ingest",
      { modal: true, detail },
      "Enable Telemetry",
      "No Thanks",
      "View Privacy Policy"
    );

    await this.markConsentDialogShown();

    if (selection === "View Privacy Policy") {
      void vscode.window.showInformationMessage(
        "Code-Ingest uses local-only logging. No telemetry or analytics are sent off-machine."
      );
      return false;
    }

    return selection === "Enable Telemetry";
  }

  private getStoredConsent(): TelemetryConsent | null {
    const raw = this.context.globalState.get<string>(CONSENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as TelemetryConsent & { timestamp: string };
      return {
        ...parsed,
        timestamp: new Date(parsed.timestamp)
      };
    } catch {
      return null;
    }
  }

  private async storeConsent(consent: TelemetryConsent): Promise<void> {
    await this.context.globalState.update(CONSENT_STORAGE_KEY, JSON.stringify(consent));
    await this.configService.updateGlobalValue("codeIngest.telemetry.consentShown", consent.granted);
  }

  private hasShownConsentDialog(): boolean {
    return this.context.globalState.get<boolean>(CONSENT_DIALOG_KEY, false);
  }

  private async markConsentDialogShown(): Promise<void> {
    await this.context.globalState.update(CONSENT_DIALOG_KEY, true);
  }
}