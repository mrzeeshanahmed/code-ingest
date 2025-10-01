import { createFormatter, type FormatterIdentifier } from "../formatters/factory";
import type { FormatterOptions, FormatterTemplateSet } from "../formatters/types";
import type { DigestResult } from "../services/digestGenerator";

export type DigestOutputFormat = FormatterIdentifier;

export interface DigestFormatOptions {
  readonly format?: DigestOutputFormat;
  readonly formatterOptions?: Partial<FormatterOptions>;
  readonly templates?: FormatterTemplateSet;
}

export function formatDigest(result: DigestResult, options: DigestFormatOptions = {}): string {
  const format = options.format ?? "markdown";
  const formatter = createFormatter(format, options.formatterOptions, options.templates);
  return formatter.finalize(result);
}
