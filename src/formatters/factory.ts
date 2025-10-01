import { JsonFormatter } from "./jsonFormatter";
import { MarkdownFormatter } from "./markdownFormatter";
import { TextFormatter } from "./textFormatter";
import type { Formatter } from "./base/formatter.interface";
import type { FormatterOptions, FormatterTemplateSet } from "./types";

export type FormatterIdentifier = "markdown" | "json" | "text" | (string & {});

export type FormatterFactoryFn = (options?: Partial<FormatterOptions>, templates?: FormatterTemplateSet) => Formatter;

const builtinFactories: Map<FormatterIdentifier, FormatterFactoryFn> = new Map();

builtinFactories.set("markdown", (options, templates) => new MarkdownFormatter(options, templates));
builtinFactories.set("json", (options, templates) => new JsonFormatter(options, templates));
builtinFactories.set("text", (options, templates) => new TextFormatter(options, templates));

const customFactories: Map<FormatterIdentifier, FormatterFactoryFn> = new Map();

export function registerFormatter(identifier: FormatterIdentifier, factory: FormatterFactoryFn): void {
  customFactories.set(identifier, factory);
}

export function unregisterFormatter(identifier: FormatterIdentifier): void {
  customFactories.delete(identifier);
}

export function listFormatters(): FormatterIdentifier[] {
  return Array.from(new Set([...builtinFactories.keys(), ...customFactories.keys()]));
}

export function createFormatter(
  identifier: FormatterIdentifier,
  options?: Partial<FormatterOptions>,
  templates?: FormatterTemplateSet
): Formatter {
  const factory = customFactories.get(identifier) ?? builtinFactories.get(identifier);
  if (!factory) {
    throw new Error(`Unknown formatter: ${identifier}`);
  }
  return factory(options, templates);
}
