/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { ConfigurationService } from "../services/configurationService";
import { GENERATED_COMMAND_SCHEMAS } from "../config/generatedCommandSchemas";
import type { ErrorReporter } from "../services/errorReporter";
import type { JSONSchema } from "../types/jsonSchema";
import { wrapError } from "../utils/errorHandling";

export interface MessageEnvelope {
  readonly id: string;
  readonly type: "command" | "response" | "event";
  readonly command: string;
  readonly payload: unknown;
  readonly timestamp: number;
  readonly token: string;
}

export interface ControllerOptions {
  readonly enableRateLimit: boolean;
  readonly rateLimitWindowMs: number;
  readonly maxRequestsPerWindow: number;
  readonly messageTimeoutMs: number;
  readonly enableSchemaValidation: boolean;
  readonly enableLogging: boolean;
}

export interface ValidationError extends Error {
  errors?: string[];
}

export type ValidationResult<TValue = unknown> = ValidationSuccess<TValue> | ValidationFailure;

interface ValidationSuccess<TValue> {
  ok: true;
  value: TValue;
}

interface ValidationFailure {
  ok: false;
  reason?: string;
  errors?: string[];
}

export interface SecurityValidator {
  validateMessageStructure(message: unknown): ValidationResult<MessageEnvelope>;
  validateToken(token: string, sessionId: string): boolean;
  validatePayload(command: string, payload: unknown): ValidationResult<unknown>;
  sanitizeStringInputs<TValue>(payload: TValue): TValue;
  checkPathTraversal(filePath: string): boolean;
  registerSession(sessionId: string, token: string, ttlMs: number): void;
}

export interface RateLimitEntry {
  timestamps: number[];
  blocked: boolean;
  blockExpires: number;
}

export interface EventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;
  off(event: string, handler: (data: unknown) => void): void;
}

export interface ErrorHandler {
  handleValidationError(command: string, error: ValidationError): void;
  handleRateLimitError(clientId: string): void;
  handleCommandError(command: string, error: Error): void;
  handleTimeoutError(command: string): void;
}

export interface DiagnosticLogger {
  logMessageReceived(message: MessageEnvelope): void;
  logMessageSent(message: MessageEnvelope): void;
  logValidationFailure(command: string, error: ValidationError): void;
  logRateLimitHit(clientId: string): void;
  logPerformanceMetrics(command: string, duration: number): void;
}

export interface CommandRegistry {
  has(command: string): boolean;
  execute(command: string, payload: unknown): Promise<unknown>;
}

export interface SessionDescriptor {
  readonly id: string;
  readonly token: string;
  readonly expiresAt?: number;
}

export interface CodeIngestWebviewViewProvider {
  postMessage(message: MessageEnvelope): Thenable<boolean> | void;
  getSession?(): SessionDescriptor | undefined;
  getErrorReporter?(): ErrorReporter | undefined;
}

const COMMAND_SCHEMAS: Record<string, JSONSchema> = GENERATED_COMMAND_SCHEMAS;

class MessageValidator implements SecurityValidator {
  private schemas: Map<string, JSONSchema> = new Map();
  private sessionTokens: Map<string, { token: string; expires: number }> = new Map();

  constructor() {
    this.loadCommandSchemas();
    this.initializeSessionManagement();
  }

  registerSession(sessionId: string, token: string, ttlMs: number): void {
    if (!sessionId || !token) {
      return;
    }

    const expires = Date.now() + ttlMs;
    this.sessionTokens.set(sessionId, { token, expires });
  }

  validateMessageStructure(message: unknown): ValidationResult<MessageEnvelope> {
    const errors: string[] = [];
    if (!message || typeof message !== "object") {
      return { ok: false, reason: "message_not_object", errors: ["Message must be an object"] };
    }

  const candidate = message as Partial<MessageEnvelope>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      errors.push("invalid_id");
    }
    if (candidate.type !== "command" && candidate.type !== "response" && candidate.type !== "event") {
      errors.push("invalid_type");
    }
    if (typeof candidate.command !== "string" || candidate.command.length === 0) {
      errors.push("invalid_command");
    }
    if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp)) {
      errors.push("invalid_timestamp");
    }
    if (typeof candidate.token !== "string" || candidate.token.length === 0) {
      errors.push("invalid_token");
    }

    if (errors.length > 0) {
      return { ok: false, reason: errors[0], errors };
    }

    const sanitizedPayload = this.sanitizeStringInputs(candidate.payload);
    const normalised: MessageEnvelope = {
      id: candidate.id as string,
      type: candidate.type as MessageEnvelope["type"],
      command: candidate.command as string,
      payload: sanitizedPayload,
      timestamp: candidate.timestamp as number,
      token: candidate.token as string
    };

    return { ok: true, value: normalised };
  }

  validateToken(token: string, sessionId: string): boolean {
    if (!sessionId || !token) {
      return false;
    }

    const record = this.sessionTokens.get(sessionId);
    if (!record) {
      return false;
    }
    if (record.expires <= Date.now()) {
      this.sessionTokens.delete(sessionId);
      return false;
    }

    return record.token === token;
  }

  validatePayload(command: string, payload: unknown): ValidationResult<unknown> {
    const schema = this.schemas.get(command);
    if (!schema) {
      return { ok: true, value: payload };
    }

    const errors: string[] = [];
    const validated = this.validateAgainstSchema(schema, payload, `payload.${command}`, errors);
    if (!validated) {
      return { ok: false, reason: errors[0] ?? "schema_validation_failed", errors };
    }

    return { ok: true, value: validated };
  }

  sanitizeStringInputs<TValue>(payload: TValue): TValue {
    if (typeof payload === "string") {
      return this.sanitiseString(payload) as unknown as TValue;
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.sanitizeStringInputs(item)) as unknown as TValue;
    }

    if (payload && typeof payload === "object") {
      const entries = Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
        key,
        this.sanitizeStringInputs(value)
      ] as const);
      return Object.fromEntries(entries) as unknown as TValue;
    }

    return payload;
  }

  checkPathTraversal(filePath: string): boolean {
    if (!filePath) {
      return true;
    }

    const normalised = path.normalize(filePath).replace(/\\+/g, "/");
    return !normalised.split("/").some((segment) => segment === ".." || segment === "");
  }

  private initialiseSchema(command: string, schema: JSONSchema): void {
    this.schemas.set(command, schema);
  }

  private loadCommandSchemas(): void {
    Object.entries(COMMAND_SCHEMAS).forEach(([command, schema]) => this.initialiseSchema(command, schema));
  }

  private initializeSessionManagement(): void {
    this.sessionTokens.clear();
  }

  private sanitiseString(input: string): string {
    const trimmed = input.trim();
    return trimmed.replace(/[\u0000-\u001F\u007F]/g, "");
  }

  private validateAgainstSchema(schema: JSONSchema, payload: unknown, context: string, errors: string[]): unknown {
    switch (schema.type) {
      case "string":
        if (typeof payload !== "string") {
          errors.push(`${context}: expected string`);
          return undefined;
        }
        if (schema.minLength !== undefined && payload.length < schema.minLength) {
          errors.push(`${context}: below minimum length`);
          return undefined;
        }
        if (schema.maxLength !== undefined && payload.length > schema.maxLength) {
          errors.push(`${context}: exceeds maximum length`);
          return undefined;
        }
        if (schema.pattern) {
          const pattern = new RegExp(schema.pattern);
          if (!pattern.test(payload)) {
            errors.push(`${context}: pattern mismatch`);
            return undefined;
          }
        }
        return this.sanitiseString(payload);

      case "boolean":
        if (typeof payload !== "boolean") {
          errors.push(`${context}: expected boolean`);
          return undefined;
        }
        return payload;

      case "array":
        if (!Array.isArray(payload)) {
          errors.push(`${context}: expected array`);
          return undefined;
        }
        if (schema.maxItems !== undefined && payload.length > schema.maxItems) {
          errors.push(`${context}: too many items`);
          return undefined;
        }
        if (!schema.items) {
          return payload.map((item) => this.sanitizeStringInputs(item));
        }
        let arrayValid = true;
        const validatedItems = payload.map((item, index) => {
          const validated = this.validateAgainstSchema(schema.items as JSONSchema, item, `${context}[${index}]`, errors);
          if (validated === undefined) {
            arrayValid = false;
          }
          return validated;
        });
        return arrayValid ? validatedItems : undefined;

      case "object":
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          errors.push(`${context}: expected object`);
          return undefined;
        }

        const result: Record<string, unknown> = {};
        const required = new Set(schema.required ?? []);
  let objectValid = true;

        for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
          const propertySchema = schema.properties?.[key];
          if (!propertySchema) {
            if (schema.additionalProperties === false) {
              errors.push(`${context}.${key}: unexpected property`);
              objectValid = false;
            } else {
              result[key] = this.sanitizeStringInputs(value);
            }
            continue;
          }

          const validatedValue = this.validateAgainstSchema(propertySchema, value, `${context}.${key}`, errors);
          if (validatedValue === undefined) {
            objectValid = false;
            continue;
          }
          result[key] = validatedValue;
          required.delete(key);
        }

        if (required.size > 0) {
          required.forEach((key) => errors.push(`${context}.${key}: missing required property`));
          return undefined;
        }

  return objectValid ? result : undefined;

      default:
        errors.push(`${context}: unsupported schema type ${(schema as { type?: string }).type ?? "unknown"}`);
        return undefined;
    }
  }
}

class RateLimiter {
  private readonly requests = new Map<string, RateLimitEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly blockDurationMs: number
  ) {}

  isAllowed(clientId: string): boolean {
    if (!clientId) {
      return true;
    }

    const now = Date.now();
    const entry = this.requests.get(clientId);
    if (entry?.blocked) {
      if (entry.blockExpires > now) {
        return false;
      }
      entry.blocked = false;
      entry.timestamps = [];
    }

    if (!entry) {
      this.requests.set(clientId, { timestamps: [], blocked: false, blockExpires: 0 });
      return true;
    }

    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > now - this.windowMs);
    if (entry.timestamps.length >= this.maxRequests) {
      entry.blocked = true;
      entry.blockExpires = now + this.blockDurationMs;
      return false;
    }

    return true;
  }

  recordRequest(clientId: string): void {
    if (!clientId) {
      return;
    }

    const now = Date.now();
    const entry = this.requests.get(clientId);
    if (!entry) {
      this.requests.set(clientId, {
        timestamps: [now],
        blocked: false,
        blockExpires: 0
      });
      return;
    }

    entry.timestamps.push(now);
  }
}

class SidebarEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    }
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
}

class SidebarErrorHandler implements ErrorHandler {
  constructor(
    private readonly errorReporter: ErrorReporter | undefined,
    private readonly webviewViewProvider: CodeIngestWebviewViewProvider
  ) {}

  handleValidationError(command: string, error: ValidationError): void {
    this.reportSecurityEvent({ type: "validation_failure", command, error: error.message });
    const session = this.webviewViewProvider.getSession?.();
    void this.webviewViewProvider.postMessage({
      id: randomUUID(),
      type: "event",
      command: "validationError",
      payload: {
        message: "Invalid request format",
        canRetry: false
      },
      timestamp: Date.now(),
      token: session?.token ?? ""
    });
  }

  handleRateLimitError(clientId: string): void {
    this.errorReporter?.report(new Error("Sidebar rate limit exceeded"), {
      source: "sidebar-controller",
      command: "rate-limit",
      metadata: { clientId }
    });
  }

  handleCommandError(command: string, error: Error): void {
    this.errorReporter?.report(error, {
      source: "sidebar-controller",
      command
    });
  }

  handleTimeoutError(command: string): void {
    this.errorReporter?.report(new Error(`Message timeout for ${command}`), {
      source: "sidebar-controller",
      command
    });
  }

  private reportSecurityEvent(event: { type: string; command: string; error: string }): void {
    const reporter = this.errorReporter as unknown as { reportSecurityEvent?: (payload: unknown) => void } | undefined;
    if (reporter?.reportSecurityEvent) {
      reporter.reportSecurityEvent({
        ...event,
        timestamp: Date.now()
      });
      return;
    }

    this.errorReporter?.report(new Error(event.error), {
      source: "sidebar-controller",
      command: event.command,
      metadata: { type: event.type }
    });
  }
}

class SidebarDiagnosticLogger implements DiagnosticLogger {
  private readonly metricsBuffer: Array<{ command: string; duration: number; timestamp: number }> = [];

  constructor(private readonly isEnabled: boolean) {}

  logMessageReceived(message: MessageEnvelope): void {
    if (!this.isEnabled) {
      return;
    }
    console.debug("[SidebarController] Message received", {
      id: message.id,
      type: message.type,
      command: message.command,
      timestamp: message.timestamp
    });
  }

  logMessageSent(message: MessageEnvelope): void {
    if (!this.isEnabled) {
      return;
    }
    console.debug("[SidebarController] Message sent", {
      id: message.id,
      type: message.type,
      command: message.command,
      timestamp: message.timestamp
    });
  }

  logValidationFailure(command: string, error: ValidationError): void {
    if (!this.isEnabled) {
      return;
    }
    console.warn("[SidebarController] Validation failed", {
      command,
      error: error.message,
      errors: error.errors
    });
  }

  logRateLimitHit(clientId: string): void {
    if (!this.isEnabled) {
      return;
    }
    console.warn("[SidebarController] Rate limit hit", { clientId });
  }

  logPerformanceMetrics(command: string, duration: number): void {
    if (!this.isEnabled) {
      return;
    }
    const entry = { command, duration, timestamp: Date.now() };
    this.metricsBuffer.push(entry);
    if (this.metricsBuffer.length >= 50) {
      this.flush();
    }
  }

  private flush(): void {
    if (!this.isEnabled || this.metricsBuffer.length === 0) {
      return;
    }
    const snapshot = [...this.metricsBuffer];
    this.metricsBuffer.length = 0;
    console.debug("[SidebarController] Performance snapshot", snapshot);
  }
}

interface PendingResponse {
  readonly command: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class SidebarController {
  private readonly validator: MessageValidator;
  private readonly rateLimiter: RateLimiter;
  private readonly eventBus: SidebarEventBus;
  private readonly errorHandler: SidebarErrorHandler;
  private readonly logger: SidebarDiagnosticLogger;
  private readonly pendingResponses = new Map<string, PendingResponse>();

  constructor(
    private readonly webviewViewProvider: CodeIngestWebviewViewProvider,
    private readonly commandRegistry: CommandRegistry,
    private readonly configService: ConfigurationService,
    private readonly options: ControllerOptions
  ) {
    this.validator = new MessageValidator();
    this.rateLimiter = new RateLimiter(
      options.rateLimitWindowMs,
      options.maxRequestsPerWindow,
      options.rateLimitWindowMs * 2
    );
    this.eventBus = new SidebarEventBus();
    this.errorHandler = new SidebarErrorHandler(this.resolveErrorReporter(), this.webviewViewProvider);
  this.logger = new SidebarDiagnosticLogger(options.enableLogging);
  void this.configService.loadConfig();
    this.registerSession();
  }

  async handleWebviewMessage(message: MessageEnvelope): Promise<void> {
    const start = Date.now();
    const structure = this.validator.validateMessageStructure(message);
    if (!structure.ok) {
      const error = this.toValidationError(structure.reason ?? "invalid_structure", structure.errors);
      this.logger.logValidationFailure(message.command ?? "unknown", error);
      this.errorHandler.handleValidationError(message.command ?? "unknown", error);
      return;
    }

    const normalised = structure.value;
    this.logger.logMessageReceived(normalised);

    if (normalised.type === "response") {
      this.resolveResponse(normalised);
      return;
    }

    const session = this.getSession();
    if (!this.validator.validateToken(normalised.token, session.id)) {
      const error = this.toValidationError("token_mismatch", ["Invalid session token"]);
      this.logger.logValidationFailure(normalised.command, error);
      this.errorHandler.handleValidationError(normalised.command, error);
      return;
    }

    const clientId = session.id;
    if (this.options.enableRateLimit) {
      if (!this.rateLimiter.isAllowed(clientId)) {
        this.logger.logRateLimitHit(clientId);
        this.errorHandler.handleRateLimitError(clientId);
        return;
      }
      this.rateLimiter.recordRequest(clientId);
    }

    if (!this.commandRegistry.has(normalised.command)) {
      const error = this.toValidationError("unknown_command", ["Command not registered"]);
      this.logger.logValidationFailure(normalised.command, error);
      this.errorHandler.handleValidationError(normalised.command, error);
      return;
    }

    const sanitizedPayload = this.validator.sanitizeStringInputs(normalised.payload);
    const payloadValidation: ValidationResult<unknown> = this.options.enableSchemaValidation
      ? this.validator.validatePayload(normalised.command, sanitizedPayload)
      : { ok: true as const, value: sanitizedPayload };

    if (!payloadValidation.ok) {
      const error = this.toValidationError(payloadValidation.reason ?? "schema_validation_failed", payloadValidation.errors);
      this.logger.logValidationFailure(normalised.command, error);
      this.errorHandler.handleValidationError(normalised.command, error);
      await this.sendResponse(normalised, { ok: false, reason: error.message });
      return;
    }

    try {
      const result = await this.commandRegistry.execute(normalised.command, payloadValidation.value);
      await this.sendResponse(normalised, { ok: true, result });
      this.logger.logPerformanceMetrics(normalised.command, Date.now() - start);
    } catch (rawError) {
      const error = wrapError(rawError, { scope: "sidebar-controller", command: normalised.command });
      this.errorHandler.handleCommandError(normalised.command, error);
      await this.sendResponse(normalised, { ok: false, reason: error.message });
    }
  }

  async sendToWebview(type: string, command: string, payload: unknown): Promise<void> {
    if (type !== "command" && type !== "response" && type !== "event") {
      throw new TypeError(`Unsupported message type: ${type}`);
    }

    const session = this.getSession();
    const sanitizedPayload = this.validator.sanitizeStringInputs(payload);

    if (type === "command" && this.options.enableSchemaValidation) {
      const result = this.validator.validatePayload(command, sanitizedPayload);
      if (!result.ok) {
        const error = this.toValidationError(result.reason ?? "schema_validation_failed", result.errors);
        this.logger.logValidationFailure(command, error);
        throw error;
      }
    }

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: type as MessageEnvelope["type"],
      command,
      payload: sanitizedPayload,
      timestamp: Date.now(),
      token: session.token
    };

    this.logger.logMessageSent(envelope);

    const sendPromise = Promise.resolve(this.webviewViewProvider.postMessage(envelope)).catch((error) => {
      const wrapped = wrapError(error, { scope: "sidebar-controller", phase: "send" });
      this.errorHandler.handleCommandError(command, wrapped);
      throw wrapped;
    });

    if (envelope.type !== "command") {
      await sendPromise;
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(envelope.id);
        const timeoutError = wrapError(new Error("Webview acknowledgement timeout"), {
          scope: "sidebar-controller",
          command
        });
        this.errorHandler.handleTimeoutError(command);
        reject(timeoutError);
      }, this.options.messageTimeoutMs);

      this.pendingResponses.set(envelope.id, {
        command,
        timer,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      void sendPromise.catch((error) => {
        this.pendingResponses.delete(envelope.id);
        reject(error);
      });
    });
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    return this.eventBus.on(event, handler);
  }

  off(event: string, handler: (data: unknown) => void): void {
    this.eventBus.off(event, handler);
  }

  private async sendResponse(reference: MessageEnvelope, payload: unknown): Promise<void> {
    const envelope: MessageEnvelope = {
      id: reference.id,
      type: "response",
      command: reference.command,
      payload: this.validator.sanitizeStringInputs(payload),
      timestamp: Date.now(),
      token: reference.token
    };

    this.logger.logMessageSent(envelope);
    await this.webviewViewProvider.postMessage(envelope);
  }

  private resolveResponse(message: MessageEnvelope): void {
    const entry = this.pendingResponses.get(message.id);
    if (!entry) {
      return;
    }

    this.pendingResponses.delete(message.id);
    entry.resolve();
  }

  private registerSession(): void {
    const session = this.getSession();
    this.validator.registerSession(session.id, session.token, this.options.messageTimeoutMs * 5);
  }

  private getSession(): SessionDescriptor {
    const session = this.webviewViewProvider.getSession?.();
    if (session && session.id && session.token) {
      this.validator.registerSession(session.id, session.token, session.expiresAt ?? this.options.messageTimeoutMs * 5);
      return session;
    }

    const fallback: SessionDescriptor = { id: "default-session", token: "" };
    return fallback;
  }

  private resolveErrorReporter(): ErrorReporter | undefined {
    return this.webviewViewProvider.getErrorReporter?.();
  }

  private toValidationError(reason: string, errors?: string[]): ValidationError {
    const error = new Error(reason) as ValidationError;
    if (errors) {
      error.errors = errors;
    }
    return error;
  }
}
