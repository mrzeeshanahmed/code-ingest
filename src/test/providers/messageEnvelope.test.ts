import { describe, expect, it } from "@jest/globals";
import { COMMAND_MAP } from "../../commands/commandMap";
import {
  WebviewMessageEnvelope,
  type CommandMessage,
  type ResponseMessage
} from "../../providers/messageEnvelope";

describe("WebviewMessageEnvelope", () => {
  it("creates command messages with sequential identifiers", () => {
    const envelope = new WebviewMessageEnvelope({ sessionToken: "test-token", role: "host" });
    const message = envelope.createMessage(
      "command",
      COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_TREE_DATA,
      { tree: [] }
    );

    expect(message.id).toBe(1);
    expect(message.type).toBe("command");
    expect(message.command).toBe(COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_TREE_DATA);
    expect(message.token).toBe("test-token");
    expect(typeof message.timestamp).toBe("number");
  });

  it("validates inbound commands from the webview", () => {
    const sessionToken = "shared-token";
    const hostEnvelope = new WebviewMessageEnvelope({ sessionToken, role: "host" });
    const webviewEnvelope = new WebviewMessageEnvelope({ sessionToken, role: "webview" });

    const outbound = webviewEnvelope.createMessage(
      "command",
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      { selectedFiles: [] }
    ) as CommandMessage;

    const validation = hostEnvelope.validateMessage(outbound, { direction: "inbound" });
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.value.command).toBe(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST);
    }
  });

  it("rejects messages with mismatched session tokens", () => {
    const hostEnvelope = new WebviewMessageEnvelope({ sessionToken: "expected", role: "host" });
    const invalidMessage = {
      id: 1,
      type: "command" as const,
      command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      payload: { selectedFiles: [] },
      timestamp: Date.now(),
      token: "unexpected"
    } satisfies Omit<ResponseMessage, "type"> & { type: "command" };

    const validation = hostEnvelope.validateMessage(invalidMessage, { direction: "inbound" });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toBe("session token mismatch");
    }
  });
});
