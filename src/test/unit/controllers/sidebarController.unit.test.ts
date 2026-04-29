import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { SidebarController, type ControllerOptions, type MessageEnvelope, type CodeIngestWebviewViewProvider, type CommandRegistry, type SessionDescriptor } from "../../../controllers/sidebarController";
import { ConfigurationService } from "../../../services/configurationService";

describe("SidebarController", () => {
  const baseOptions: ControllerOptions = {
    enableRateLimit: true,
    rateLimitWindowMs: 1000,
    maxRequestsPerWindow: 10,
    messageTimeoutMs: 1000,
    enableSchemaValidation: true,
    enableLogging: false
  };

  class MockProvider implements CodeIngestWebviewViewProvider {
    public readonly sent: MessageEnvelope[] = [];

    constructor(private readonly session: SessionDescriptor) {}

    postMessage(message: MessageEnvelope): Thenable<boolean> {
      this.sent.push(message);
      return Promise.resolve(true);
    }

    getSession(): SessionDescriptor {
      return this.session;
    }
  }

  class MockRegistry implements CommandRegistry {
  public readonly execute = jest.fn(async (_command: string, payload: unknown) => ({ payload }));

    constructor(private readonly known: Set<string>) {}

    has(command: string): boolean {
      return this.known.has(command);
    }
  }

  const session: SessionDescriptor = { id: "session-1", token: "token-1" };
  let provider: MockProvider;
  let registry: MockRegistry;
  let controller: SidebarController;

  beforeEach(() => {
    provider = new MockProvider(session);
    registry = new MockRegistry(new Set(["generateDigest", "updateSelection"]));
    const configService = new ConfigurationService({ include: ["src"], exclude: ["dist"], maxDepth: 1 });
    controller = new SidebarController(provider, registry, configService, baseOptions);
  });

  test("routes valid command payloads to the command registry", async () => {
    const message: MessageEnvelope = {
      id: "1",
      type: "command",
      command: "generateDigest",
      payload: {
        selectedFiles: ["src/index.ts"],
        outputFormat: "markdown",
        redactionOverride: false
      },
      timestamp: Date.now(),
      token: session.token
    };

    await controller.handleWebviewMessage(message);

    expect(registry.execute).toHaveBeenCalledTimes(1);
    expect(provider.sent).toHaveLength(1);
    const response = provider.sent[0];
    expect(response.type).toBe("response");
    expect(response.command).toBe("generateDigest");
  });

  test("enforces rate limiting for repeated messages", async () => {
    const options: ControllerOptions = { ...baseOptions, maxRequestsPerWindow: 1, rateLimitWindowMs: 10_000 };
    const configService = new ConfigurationService({ include: ["src"], exclude: ["dist"], maxDepth: 1 });
    controller = new SidebarController(provider, registry, configService, options);

    const message: MessageEnvelope = {
      id: "2",
      type: "command",
      command: "generateDigest",
      payload: { selectedFiles: ["src/index.ts"] },
      timestamp: Date.now(),
      token: session.token
    };

    await controller.handleWebviewMessage(message);
    await controller.handleWebviewMessage({ ...message, id: "3", timestamp: Date.now() + 1 });

    expect(registry.execute).toHaveBeenCalledTimes(1);
  });

  test("resolves outbound command promises when responses arrive", async () => {
    const outboundPromise = controller.sendToWebview("command", "updateSelection", {
      filePath: "src/index.ts",
      selected: true
    });

    expect(provider.sent).toHaveLength(1);
    const outbound = provider.sent[0];

    const response: MessageEnvelope = {
      id: outbound.id,
      type: "response",
      command: outbound.command,
      payload: { ok: true },
      timestamp: Date.now(),
      token: session.token
    };

    await controller.handleWebviewMessage(response);
    await expect(outboundPromise).resolves.toBeUndefined();
  });
});