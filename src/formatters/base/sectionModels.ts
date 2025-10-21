import type { DigestMetadata, DigestSummary } from "../../services/digestGenerator";
import type { DigestStatistics } from "../types";

export interface FormatterKeyValuePair {
  readonly label: string;
  readonly value: string;
}

export interface FormatterMetadataView {
  readonly metadata: DigestMetadata;
  readonly frontMatter: Record<string, string | number | boolean>;
  readonly keyValues: FormatterKeyValuePair[];
}

export interface FormatterSummaryView {
  readonly summary: DigestSummary;
  readonly overview: FormatterKeyValuePair[];
  readonly tableOfContents: DigestSummary["tableOfContents"];
  readonly notes: string[];
}

export interface FormatterStatisticsView {
  readonly statistics: DigestStatistics;
  readonly keyValues: FormatterKeyValuePair[];
  readonly warnings: string[];
  readonly errors: string[];
}
