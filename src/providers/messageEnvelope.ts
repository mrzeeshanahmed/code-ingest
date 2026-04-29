import { randomUUID } from "node:crypto";
import { COMMAND_MAP } from "../commands/commandMap";

export type EnvelopeType = "command" | "response" | "event";
export type EnvelopeDirection = "inbound" | "outbound";
export type MessageEnvelopeRole = "host" | "webview";

export interface BaseMessage<TPayload = unknown> {
  readonly id: number;
  readonly type: EnvelopeType;
  readonly command: string;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly token: string;
  readonly expectsAck?: boolean;
}

export type CommandMessage<TPayload = unknown> = BaseMessage<TPayload> & {
  readonly type: "command";
};

export type ResponseMessage<TPayload = unknown> = BaseMessage<TPayload> & {
  readonly type: "response";
};

export type EventMessage<TPayload = unknown> = BaseMessage<TPayload> & {
  readonly type: "event";
};

export type EnvelopeMessage<TPayload = unknown> =
  | CommandMessage<TPayload>
  | ResponseMessage<TPayload>
  | EventMessage<TPayload>;

export interface CreateMessageOptions {
  readonly expectsAck?: boolean;
  readonly timestamp?: number;
}

export interface GraphPanelNodePayload {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly filePath: string;
  readonly relativePath: string;
  readonly startLine?: number | undefined;
}

export interface GraphPanelEdgePayload {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
}

export interface LoadGraphMessage {
  readonly command: "loadGraph";
  readonly payload: {
    readonly nodes: GraphPanelNodePayload[];
    readonly edges: GraphPanelEdgePayload[];
    readonly focusFile?: string | undefined;
    readonly layout: "cose" | "radial";
    readonly nodeMode: "file" | "function";
    readonly truncated: boolean;
  };
}

export interface FocusNodeMessage {
  readonly command: "focusNode";
  readonly nodeId: string;
}

export interface WebviewReadyMessage {
  readonly command: "webviewReady";
}

export interface OpenFileMessage {
  readonly command: "openFile";
  readonly filePath: string;
  readonly startLine?: number | undefined;
}

export interface RequestFocusMessage {
  readonly command: "requestFocus";
  readonly filePath?: string | undefined;
}

export interface GraphModeChangeMessage {
  readonly command: "graphModeChange";
  readonly mode: "file" | "function";
}

export interface LayoutChangeMessage {
  readonly command: "layoutChange";
  readonly layout: "cose" | "radial";
}

export interface SendToChatMessage {
  readonly command: "sendToChat";
  readonly filePath?: string | undefined;
  readonly filePaths?: string[] | undefined;
}

export interface CopyPathMessage {
  readonly command: "copyPath";
  readonly path: string;
}

export interface ShowInExplorerMessage {
  readonly command: "showInExplorer";
  readonly filePath: string;
}

export interface ExportPngMessage {
  readonly command: "exportPng";
  readonly dataUrl: string;
}

export interface ExpandNodeMessage {
  readonly command: "expandNode";
  readonly nodeId: string;
}

export type GraphPanelMessage =
  | LoadGraphMessage
  | FocusNodeMessage
  | WebviewReadyMessage
  | OpenFileMessage
  | RequestFocusMessage
  | GraphModeChangeMessage
  | LayoutChangeMessage
  | SendToChatMessage
  | CopyPathMessage
  | ShowInExplorerMessage
  | ExportPngMessage
  | ExpandNodeMessage;

export interface ValidateOptions {
  readonly direction?: EnvelopeDirection;
  readonly requireToken?: boolean;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly reason: string;
  readonly errors: string[];
}

export interface ValidationSuccess<TMessage extends EnvelopeMessage = EnvelopeMessage> {
  readonly ok: true;
  readonly value: TMessage;
}

export type ValidationResult<TMessage extends EnvelopeMessage = EnvelopeMessage> =
  | ValidationSuccess<TMessage>
  | ValidationFailure;

const ALLOWED_TYPES: ReadonlySet<EnvelopeType> = new Set(["command", "response", "event"]);

function collectCommands(direction: EnvelopeDirection, role: MessageEnvelopeRole) {
  if (role === "webview") {
    if (direction === "outbound") {
      return new Set(Object.values(COMMAND_MAP.WEBVIEW_TO_HOST ?? {}));
    }
    return new Set(Object.values(COMMAND_MAP.HOST_TO_WEBVIEW ?? {}));
  }

  if (direction === "outbound") {
    return new Set(Object.values(COMMAND_MAP.HOST_TO_WEBVIEW ?? {}));
  }
  return new Set(Object.values(COMMAND_MAP.WEBVIEW_TO_HOST ?? {}));
}

export class WebviewMessageEnvelope {
  private readonly role: MessageEnvelopeRole;
  private readonly commandSets: {
    readonly outbound: Set<string>;
    readonly inbound: Set<string>;
  };

  private _sessionToken: string;
  private sequence = 0;
  private readonly lastTimestamps = new Map<string, number>();
  public allowedClockDriftMs = 30_000;

  constructor(options: { sessionToken?: string; role?: MessageEnvelopeRole } = {}) {
    this.role = options.role ?? "host";
    this._sessionToken = options.sessionToken ?? WebviewMessageEnvelope.generateToken();
    this.commandSets = {
      outbound: collectCommands("outbound", this.role),
      inbound: collectCommands("inbound", this.role)
    };
  }

  get sessionToken(): string {
    return this._sessionToken;
  }

  set sessionToken(token: string) {
    if (typeof token === "string" && token.length > 0) {
      this._sessionToken = token;
    }
  }

  createMessage<TPayload = unknown>(
    type: EnvelopeType,
    command: string,
    payload: TPayload,
    options: CreateMessageOptions = {}
  ): EnvelopeMessage<TPayload> {
    if (!ALLOWED_TYPES.has(type)) {
      throw new TypeError(`Unsupported message type: ${type}`);
    }

    const knownCommands = type === "command" ? this.commandSets.outbound : this.commandSets.inbound;
    if (!knownCommands.has(command)) {
      throw new Error(`Unknown command: ${command}`);
    }

    const timestamp = options.timestamp ?? Date.now();
    const id = ++this.sequence;

    return {
      id,
      type,
      command,
      payload,
      timestamp,
      token: this._sessionToken,
      expectsAck: Boolean(options.expectsAck)
    };
  }

  createResponse<TPayload = unknown>(
    reference: CommandMessage,
    payload: TPayload
  ): ResponseMessage<TPayload> {
    return {
      id: reference.id,
      type: "response",
      command: reference.command,
      payload,
      timestamp: Date.now(),
      token: this._sessionToken,
      expectsAck: false
    };
  }

  validateMessage<TMessage extends EnvelopeMessage>(
    message: TMessage,
    options: ValidateOptions = {}
  ): ValidationResult<TMessage> {
    const direction = options.direction ?? "inbound";
    const requireToken = options.requireToken !== false;
    const errors: string[] = [];

    if (!message || typeof message !== "object") {
      errors.push("message must be an object");
      return { ok: false, reason: errors[0], errors };
    }

    if (typeof message.id !== "number" || !Number.isFinite(message.id)) {
      errors.push("missing message id");
    }

    if (!ALLOWED_TYPES.has(message.type)) {
      errors.push(`invalid message type: ${String(message.type)}`);
    }

    if (typeof message.command !== "string" || message.command.length === 0) {
      errors.push("invalid command identifier");
    } else {
      const known = direction === "outbound" ? this.commandSets.outbound : this.commandSets.inbound;
      if (!known.has(message.command)) {
        errors.push(`unknown command: ${message.command}`);
      }
    }

    if (typeof message.timestamp !== "number") {
      errors.push("missing timestamp");
    } else {
      const now = Date.now();
      if (Math.abs(now - message.timestamp) > this.allowedClockDriftMs) {
        errors.push("stale message timestamp");
      } else {
        const lastTimestamp = this.lastTimestamps.get(message.command) ?? 0;
        if (message.timestamp < lastTimestamp) {
          errors.push("timestamp replay detected");
        } else {
          this.lastTimestamps.set(message.command, message.timestamp);
        }
      }
    }

    if (requireToken) {
      if (typeof message.token !== "string" || message.token.length === 0) {
        errors.push("missing session token");
      } else if (message.token !== this._sessionToken) {
        errors.push("session token mismatch");
      }
    }

    if (errors.length > 0) {
      return { ok: false, reason: errors[0], errors };
    }

    return { ok: true, value: message };
  }

  static generateToken(): string {
    try {
      return randomUUID();
  } catch {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
}