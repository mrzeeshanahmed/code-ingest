import * as fs from "node:fs";
import { createRequire } from "node:module";

type WaSqliteModule = typeof import("wa-sqlite");
export type SQLiteAPI = ReturnType<WaSqliteModule["Factory"]>;

export async function loadWaSqliteFactory(): Promise<(module: any) => SQLiteAPI> {
  const waSqlite = await import("wa-sqlite");
  return waSqlite.Factory;
}

export async function loadWaSqliteAsyncModule(): Promise<any> {
  const waSqliteModule = await import("wa-sqlite/dist/wa-sqlite-async.mjs");
  const SQLiteAsyncESMFactory = (waSqliteModule as any).default ?? waSqliteModule;
  return async () => {
    const require = createRequire(__filename);
    const wasmPath = require.resolve("wa-sqlite/dist/wa-sqlite-async.wasm");
    const wasmBinary = fs.readFileSync(wasmPath);
    return SQLiteAsyncESMFactory({ wasmBinary });
  };
}

export async function loadSqliteConstants(): Promise<any> {
  return await import("wa-sqlite/src/sqlite-constants.js");
}
