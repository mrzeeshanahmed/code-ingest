declare module "@dqbd/tiktoken" {
  export interface TikTokenEncoding {
    encode(value: string): number[];
  }

  export function encoding_for_model(model: string): TikTokenEncoding;
  export function get_encoding(encoding: string): TikTokenEncoding;
}

declare module "semver" {
  export interface SemVer {
    version: string;
  }

  export function parse(version: string): SemVer | null;
  export function coerce(version: string): SemVer | null;
  export function minVersion(range: string): SemVer | null;
  export function lt(v1: SemVer | string, v2: SemVer | string): boolean;
}
