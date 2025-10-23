/*
 * Follow instructions in copilot-instructions.md exactly.
 */

export interface JSONSchema {
  readonly type: "object" | "array" | "string" | "boolean";
  readonly properties?: Record<string, JSONSchema>;
  readonly items?: JSONSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly additionalProperties?: boolean;
  readonly default?: unknown;
}
