import { wrapError } from "../utils/errorHandling";
import type { FormatterTemplateSet, TemplateValidationError, TemplateValidationResult, TemplateVariables } from "./types";

const TEMPLATE_PATTERN = /{{\s*([\w.]+)\s*}}/g;

function getValueFromPath(source: TemplateVariables, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export class TemplateEngine {
  public constructor(private readonly templates: FormatterTemplateSet = {}) {}

  public get templateNames(): string[] {
    return Object.keys(this.templates);
  }

  public has(name: keyof FormatterTemplateSet): boolean {
    return Boolean(this.templates[name]);
  }

  public validate(): TemplateValidationResult {
    const errors: TemplateValidationError[] = [];
    for (const [name, template] of Object.entries(this.templates)) {
      if (!template) {
        continue;
      }
      try {
        this.performDryRun(template, {});
      } catch (error) {
        errors.push({
          templateName: name,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  public apply(templateName: keyof FormatterTemplateSet, fallback: string, variables: TemplateVariables): string {
    const template = this.templates[templateName];
    if (!template) {
      return fallback;
    }
    return this.performDryRun(template, variables);
  }

  private performDryRun(template: string, variables: TemplateVariables): string {
    try {
      return template.replace(TEMPLATE_PATTERN, (match, key) => {
        const value = getValueFromPath(variables, key);
        if (value === undefined || value === null) {
          return "";
        }
        if (typeof value === "object") {
          return JSON.stringify(value, null, 2);
        }
        return String(value);
      });
    } catch (error) {
      throw wrapError(error, { scope: "templateEngine", template });
    }
  }
}
