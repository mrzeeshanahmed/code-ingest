declare module "@dqbd/tiktoken" {
  export interface TikTokenEncoding {
    encode(value: string): number[];
  }

  export function encoding_for_model(model: string): TikTokenEncoding;
  export function get_encoding(encoding: string): TikTokenEncoding;
}
