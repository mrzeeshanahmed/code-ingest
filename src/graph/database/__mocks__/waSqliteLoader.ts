// @ts-nocheck
import Database from "better-sqlite3";

const databases = new Map<number, Database.Database>();
let nextDbId = 1;

export type SQLiteAPI = any;

export async function loadWaSqliteFactory(): Promise<(module: any) => any> {
  return () => createFakeSQLiteAPI();
}

export async function loadWaSqliteAsyncModule(): Promise<any> {
  return () => ({});
}

export async function loadSqliteConstants(): Promise<any> {
  return {
    SQLITE_OPEN_READONLY: 0x00000001,
    SQLITE_OPEN_READWRITE: 0x00000002,
    SQLITE_OPEN_CREATE: 0x00000004,
    SQLITE_OK: 0,
    SQLITE_IOERR: 10,
    SQLITE_IOERR_READ: 266,
    SQLITE_IOERR_SHORT_READ: 522,
    SQLITE_IOERR_WRITE: 778,
    SQLITE_IOERR_FSYNC: 1034,
    SQLITE_IOERR_TRUNCATE: 1290,
    SQLITE_IOERR_FSTAT: 1802,
    SQLITE_IOERR_CLOSE: 4106,
    SQLITE_IOERR_DELETE: 2570,
    SQLITE_IOERR_DELETE_NOENT: 5898,
    SQLITE_CANTOPEN: 14,
    SQLITE_PERM: 3,
    SQLITE_ACCESS_READWRITE: 1,
  };
}

function createFakeSQLiteAPI(): any {
  return {
    vfs_register() {
      return 0;
    },
    open_v2(filename: string, _flags: number, _vfsName: string) {
      const dbId = nextDbId++;
      const db = new Database(filename);
      databases.set(dbId, db);
      return dbId;
    },
    close(dbId: number) {
      const db = databases.get(dbId);
      if (db) {
        db.close();
        databases.delete(dbId);
      }
      return 0;
    },
    run(dbId: number, sql: string, params?: any[]) {
      const db = databases.get(dbId);
      if (!db) throw new Error("DB not found");
      const stmt = db.prepare(sql);
      if (params && params.length > 0) {
        stmt.run(...params);
      } else {
        stmt.run();
      }
      return 0;
    },
    execWithParams(dbId: number, sql: string, params?: any[]) {
      const db = databases.get(dbId);
      if (!db) throw new Error("DB not found");
      const stmt = db.prepare(sql);
      let rows: any[];
      if (params && params.length > 0) {
        rows = stmt.all(...params);
      } else {
        rows = stmt.all();
      }
      const columns = stmt.columns().map((c) => c.name);
      const rowArrays = rows.map((row: any) => columns.map((col) => row[col]));
      return { rows: rowArrays };
    },
  };
}
