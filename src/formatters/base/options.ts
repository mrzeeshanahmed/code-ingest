import { DEFAULT_FORMATTER_OPTIONS, type FormatterOptions, type FormatterTemplateSet } from "../types";

export interface FormatterOptionsDiagnostics {
  addError(message: string, metadata?: Record<string, unknown>): void;
  addWarning?(message: string, metadata?: Record<string, unknown>): void;
  trackTelemetry?(eventName: string, properties?: Record<string, unknown>): void;
}

export function cloneFormatterOptions(options: FormatterOptions): FormatterOptions {
  const cloned: FormatterOptions = {
    includeMetadata: options.includeMetadata,
    includeSummary: options.includeSummary,
    includeFileTree: options.includeFileTree,
    includeFiles: options.includeFiles,
    sectionSeparator: options.sectionSeparator
  };

  if (options.maxFileContentLength !== undefined) {
    cloned.maxFileContentLength = options.maxFileContentLength;
  }

  if (options.outputPresetCompatible !== undefined) {
    cloned.outputPresetCompatible = options.outputPresetCompatible;
  }

  if (options.templates) {
    cloned.templates = cloneTemplates(options.templates);
  }

  if (options.markdown) {
    cloned.markdown = { ...options.markdown };
  }

  if (options.json) {
    cloned.json = { ...options.json };
  }

  if (options.text) {
    const textClone: NonNullable<FormatterOptions["text"]> = {};
    if (options.text.lineWidth !== undefined) {
      textClone.lineWidth = options.text.lineWidth;
    }
    if (options.text.useAsciiBoxes !== undefined) {
      textClone.useAsciiBoxes = options.text.useAsciiBoxes;
    }
    if (options.text.showColorCodes !== undefined) {
      textClone.showColorCodes = options.text.showColorCodes;
    }
    if (options.text.columnWidths) {
      const columnClone: NonNullable<NonNullable<FormatterOptions["text"]>["columnWidths"]> = {};
      if (options.text.columnWidths.label !== undefined) {
        columnClone.label = options.text.columnWidths.label;
      }
      if (options.text.columnWidths.value !== undefined) {
        columnClone.value = options.text.columnWidths.value;
      }
      textClone.columnWidths = columnClone;
    }
    cloned.text = textClone;
  }

  return cloned;
}

export function mergeFormatterOptions(
  baseOptions: FormatterOptions = DEFAULT_FORMATTER_OPTIONS,
  overrides?: Partial<FormatterOptions>,
  diagnostics?: FormatterOptionsDiagnostics
): FormatterOptions {
  const baseClone = cloneFormatterOptions(baseOptions);
  if (!overrides || typeof overrides !== "object") {
    return baseClone;
  }

  const sanitized = sanitizeFormatterOverrides(overrides, diagnostics);
  applyOverrides(baseClone, sanitized);
  return baseClone;
}

function applyOverrides(target: FormatterOptions, overrides: Partial<FormatterOptions>): void {
  if (overrides.includeMetadata !== undefined) {
    target.includeMetadata = overrides.includeMetadata;
  }
  if (overrides.includeSummary !== undefined) {
    target.includeSummary = overrides.includeSummary;
  }
  if (overrides.includeFileTree !== undefined) {
    target.includeFileTree = overrides.includeFileTree;
  }
  if (overrides.includeFiles !== undefined) {
    target.includeFiles = overrides.includeFiles;
  }
  if (overrides.maxFileContentLength !== undefined) {
    target.maxFileContentLength = overrides.maxFileContentLength;
  }
  if (overrides.sectionSeparator !== undefined) {
    target.sectionSeparator = overrides.sectionSeparator;
  }
  if (overrides.outputPresetCompatible !== undefined) {
    target.outputPresetCompatible = overrides.outputPresetCompatible;
  }

  if (overrides.templates) {
    target.templates = { ...(target.templates ?? {}), ...overrides.templates };
  }

  if (overrides.markdown) {
    target.markdown = { ...(target.markdown ?? {}), ...overrides.markdown };
  }

  if (overrides.json) {
    target.json = { ...(target.json ?? {}), ...overrides.json };
  }

  if (overrides.text) {
    const nextText: NonNullable<FormatterOptions["text"]> = { ...(target.text ?? {}) };
    if (overrides.text.lineWidth !== undefined) {
      nextText.lineWidth = overrides.text.lineWidth;
    }
    if (overrides.text.useAsciiBoxes !== undefined) {
      nextText.useAsciiBoxes = overrides.text.useAsciiBoxes;
    }
    if (overrides.text.showColorCodes !== undefined) {
      nextText.showColorCodes = overrides.text.showColorCodes;
    }
    if (overrides.text.columnWidths !== undefined) {
      nextText.columnWidths = { ...(nextText.columnWidths ?? {}), ...overrides.text.columnWidths };
    }
    target.text = nextText;
  }
}

function sanitizeFormatterOverrides(
  overrides: Partial<FormatterOptions>,
  diagnostics?: FormatterOptionsDiagnostics
): Partial<FormatterOptions> {
  const sanitized: Partial<FormatterOptions> = {};

  if (overrides.includeMetadata !== undefined) {
    if (typeof overrides.includeMetadata === "boolean") {
      sanitized.includeMetadata = overrides.includeMetadata;
    } else {
      reportInvalid("includeMetadata", diagnostics, "expected boolean", "controls");
    }
  }

  if (overrides.includeSummary !== undefined) {
    if (typeof overrides.includeSummary === "boolean") {
      sanitized.includeSummary = overrides.includeSummary;
    } else {
      reportInvalid("includeSummary", diagnostics, "expected boolean", "controls");
    }
  }

  if (overrides.includeFileTree !== undefined) {
    if (typeof overrides.includeFileTree === "boolean") {
      sanitized.includeFileTree = overrides.includeFileTree;
    } else {
      reportInvalid("includeFileTree", diagnostics, "expected boolean", "controls");
    }
  }

  if (overrides.includeFiles !== undefined) {
    if (typeof overrides.includeFiles === "boolean") {
      sanitized.includeFiles = overrides.includeFiles;
    } else {
      reportInvalid("includeFiles", diagnostics, "expected boolean", "controls");
    }
  }

  if (overrides.maxFileContentLength !== undefined) {
    const value = coercePositiveInteger(overrides.maxFileContentLength, 1, true);
    if (value !== undefined) {
      sanitized.maxFileContentLength = value;
    } else {
      reportInvalid("maxFileContentLength", diagnostics, "expected non-negative integer");
    }
  }

  if (overrides.sectionSeparator !== undefined) {
    if (typeof overrides.sectionSeparator === "string" && overrides.sectionSeparator.length > 0) {
      sanitized.sectionSeparator = overrides.sectionSeparator;
    } else {
      reportInvalid("sectionSeparator", diagnostics, "expected non-empty string");
    }
  }

  if (overrides.outputPresetCompatible !== undefined) {
    if (typeof overrides.outputPresetCompatible === "boolean") {
      sanitized.outputPresetCompatible = overrides.outputPresetCompatible;
    } else {
      reportInvalid("outputPresetCompatible", diagnostics, "expected boolean", "controls");
    }
  }

  if (overrides.templates !== undefined) {
    if (overrides.templates && typeof overrides.templates === "object" && !Array.isArray(overrides.templates)) {
      const normalized = sanitizeTemplates(overrides.templates as FormatterTemplateSet, diagnostics);
      if (Object.keys(normalized).length > 0) {
        sanitized.templates = normalized;
      }
    } else {
      reportInvalid("templates", diagnostics, "templates must be an object with string values");
    }
  }

  if (overrides.markdown !== undefined) {
    const markdownOverrides = sanitizeMarkdownOptions(overrides.markdown, diagnostics);
    if (markdownOverrides) {
      sanitized.markdown = markdownOverrides;
    }
  }

  if (overrides.json !== undefined) {
    const jsonOverrides = sanitizeJsonOptions(overrides.json, diagnostics);
    if (jsonOverrides) {
      sanitized.json = jsonOverrides;
    }
  }

  if (overrides.text !== undefined) {
    const textOverrides = sanitizeTextOptions(overrides.text, diagnostics);
    if (textOverrides) {
      sanitized.text = textOverrides;
    }
  }

  return sanitized;
}

function sanitizeMarkdownOptions(
  overrides: FormatterOptions["markdown"],
  diagnostics?: FormatterOptionsDiagnostics
): FormatterOptions["markdown"] | undefined {
  if (!overrides || typeof overrides !== "object") {
    reportInvalid("markdown", diagnostics, "options must be an object");
    return undefined;
  }

  const sanitized: NonNullable<FormatterOptions["markdown"]> = {};

  if (overrides.headerLevel !== undefined) {
    const value = coercePositiveInteger(overrides.headerLevel, 1, false);
    if (value !== undefined) {
      sanitized.headerLevel = value;
    } else {
      reportInvalid("markdown.headerLevel", diagnostics, "expected positive integer");
    }
  }

  if (overrides.collapsibleThresholdLines !== undefined) {
    const value = coercePositiveInteger(overrides.collapsibleThresholdLines, 0, true);
    if (value !== undefined) {
      sanitized.collapsibleThresholdLines = value;
    } else {
      reportInvalid("markdown.collapsibleThresholdLines", diagnostics, "expected non-negative integer");
    }
  }

  if (overrides.includeMermaidDiagram !== undefined) {
    if (typeof overrides.includeMermaidDiagram === "boolean") {
      sanitized.includeMermaidDiagram = overrides.includeMermaidDiagram;
    } else {
      reportInvalid("markdown.includeMermaidDiagram", diagnostics, "expected boolean");
    }
  }

  if (overrides.tableOfContentsDepth !== undefined) {
    const value = coercePositiveInteger(overrides.tableOfContentsDepth, 1, false);
    if (value !== undefined) {
      sanitized.tableOfContentsDepth = value;
    } else {
      reportInvalid("markdown.tableOfContentsDepth", diagnostics, "expected positive integer");
    }
  }

  if (overrides.codeFenceLanguageFallback !== undefined) {
    if (typeof overrides.codeFenceLanguageFallback === "string" && overrides.codeFenceLanguageFallback.trim().length > 0) {
      sanitized.codeFenceLanguageFallback = overrides.codeFenceLanguageFallback;
    } else {
      reportInvalid("markdown.codeFenceLanguageFallback", diagnostics, "expected non-empty string");
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeJsonOptions(
  overrides: FormatterOptions["json"],
  diagnostics?: FormatterOptionsDiagnostics
): FormatterOptions["json"] | undefined {
  if (!overrides || typeof overrides !== "object") {
    reportInvalid("json", diagnostics, "options must be an object");
    return undefined;
  }

  const sanitized: NonNullable<FormatterOptions["json"]> = {};

  if (overrides.schemaVersion !== undefined) {
    if (typeof overrides.schemaVersion === "string" && overrides.schemaVersion.trim().length > 0) {
      sanitized.schemaVersion = overrides.schemaVersion;
    } else {
      reportInvalid("json.schemaVersion", diagnostics, "expected non-empty string");
    }
  }

  if (overrides.pretty !== undefined) {
    if (typeof overrides.pretty === "boolean") {
      sanitized.pretty = overrides.pretty;
    } else {
      reportInvalid("json.pretty", diagnostics, "expected boolean");
    }
  }

  if (overrides.stream !== undefined) {
    if (typeof overrides.stream === "boolean") {
      sanitized.stream = overrides.stream;
    } else {
      reportInvalid("json.stream", diagnostics, "expected boolean");
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeTextOptions(
  overrides: FormatterOptions["text"],
  diagnostics?: FormatterOptionsDiagnostics
): FormatterOptions["text"] | undefined {
  if (!overrides || typeof overrides !== "object") {
    reportInvalid("text", diagnostics, "options must be an object");
    return undefined;
  }

  const sanitized: NonNullable<FormatterOptions["text"]> = {};

  if (overrides.lineWidth !== undefined) {
    const value = coercePositiveInteger(overrides.lineWidth, 10, false);
    if (value !== undefined) {
      sanitized.lineWidth = value;
    } else {
      reportInvalid("text.lineWidth", diagnostics, "expected positive integer (>= 10)");
    }
  }

  if (overrides.useAsciiBoxes !== undefined) {
    if (typeof overrides.useAsciiBoxes === "boolean") {
      sanitized.useAsciiBoxes = overrides.useAsciiBoxes;
    } else {
      reportInvalid("text.useAsciiBoxes", diagnostics, "expected boolean");
    }
  }

  if (overrides.showColorCodes !== undefined) {
    if (typeof overrides.showColorCodes === "boolean") {
      sanitized.showColorCodes = overrides.showColorCodes;
    } else {
      reportInvalid("text.showColorCodes", diagnostics, "expected boolean");
    }
  }

  if (overrides.columnWidths !== undefined) {
    if (overrides.columnWidths && typeof overrides.columnWidths === "object") {
      const columnSanitized: NonNullable<NonNullable<FormatterOptions["text"]>["columnWidths"]> = {};
      if (overrides.columnWidths.label !== undefined) {
        const value = coercePositiveInteger(overrides.columnWidths.label, 4, false);
        if (value !== undefined) {
          columnSanitized.label = value;
        } else {
          reportInvalid("text.columnWidths.label", diagnostics, "expected positive integer (>= 4)");
        }
      }
      if (overrides.columnWidths.value !== undefined) {
        const value = coercePositiveInteger(overrides.columnWidths.value, 10, false);
        if (value !== undefined) {
          columnSanitized.value = value;
        } else {
          reportInvalid("text.columnWidths.value", diagnostics, "expected positive integer (>= 10)");
        }
      }
      if (Object.keys(columnSanitized).length > 0) {
        sanitized.columnWidths = columnSanitized;
      }
    } else {
      reportInvalid("text.columnWidths", diagnostics, "columnWidths must be an object");
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeTemplates(
  templates: FormatterTemplateSet,
  diagnostics?: FormatterOptionsDiagnostics
): FormatterTemplateSet {
  const sanitized: FormatterTemplateSet = {};
  const keys: Array<keyof FormatterTemplateSet> = ["header", "summary", "fileTree", "fileContent", "footer", "finalize"];

  for (const key of keys) {
    const value = templates[key];
    if (value === undefined) {
      continue;
    }

    if (typeof value !== "string") {
      reportInvalid(`templates.${String(key)}`, diagnostics, "template overrides must be strings");
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function cloneTemplates(templates: FormatterTemplateSet): FormatterTemplateSet {
  const cloned: FormatterTemplateSet = {};
  for (const key of ["header", "summary", "fileTree", "fileContent", "footer", "finalize"] as const) {
    const value = templates[key];
    if (value !== undefined) {
      cloned[key] = value;
    }
  }
  return cloned;
}

function coercePositiveInteger(value: unknown, minimum: number, allowZero: boolean): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.floor(value);
    if (rounded > 0 || (rounded === 0 && allowZero)) {
      return Math.max(rounded, allowZero ? 0 : minimum);
    }
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const rounded = Math.floor(parsed);
      if (rounded > 0 || (rounded === 0 && allowZero)) {
        return Math.max(rounded, allowZero ? 0 : minimum);
      }
    }
  }

  return undefined;
}

function reportInvalid(
  field: string,
  diagnostics: FormatterOptionsDiagnostics | undefined,
  reason: string,
  category: "controls" | "presentation" = "presentation"
): void {
  const message = `Formatter option "${field}" ${reason}.`;
  diagnostics?.addWarning?.(message, { field, reason, category });
  diagnostics?.trackTelemetry?.("formatter.options.invalid", { field, reason, category });
}
