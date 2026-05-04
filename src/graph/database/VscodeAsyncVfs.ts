import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSqliteConstants } from "./waSqliteLoader";

const { O_RDONLY, O_RDWR, O_CREAT } = nodeFs.constants;

export interface VscodeAsyncVfs {
  name: string;
  mxPathName: number;
  handleAsync(f: () => Promise<number>): number;
  xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number;
  xClose(fileId: number): number;
  xRead(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number;
  xWrite(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number;
  xTruncate(fileId: number, iSize: number): number;
  xSync(fileId: number, flags: number): number;
  xFileSize(fileId: number, pSize64: DataView): number;
  xLock(fileId: number, flags: number): number;
  xUnlock(fileId: number, flags: number): number;
  xCheckReservedLock(fileId: number, pResOut: DataView): number;
  xFileControl(fileId: number, op: number, pArg: DataView): number;
  xDeviceCharacteristics(fileId: number): number;
  xDelete(name: string, syncDir: number): number;
  xAccess(name: string, flags: number, pResOut: DataView): number;
}

export async function createVscodeAsyncVfs(): Promise<VscodeAsyncVfs> {
  const VFS = await loadSqliteConstants();
  const handles = new Map<number, fs.FileHandle>();

  function translateFlags(sqliteFlags: number): number {
    let flags = 0;
    if (sqliteFlags & VFS.SQLITE_OPEN_READONLY) {
      flags = O_RDONLY;
    } else {
      flags = O_RDWR;
    }
    if (sqliteFlags & VFS.SQLITE_OPEN_CREATE) {
      flags |= O_CREAT;
    }
    return flags;
  }

  function generateTempName(): string {
    return path.join(os.tmpdir(), `wa-sqlite-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  function handleAsync(f: () => Promise<number>): number {
    return f() as unknown as number;
  }

  return {
    name: "vscode-async-vfs",
    mxPathName: 512,

    handleAsync,

    xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
      return handleAsync(async () => {
        const filePath = name ?? generateTempName();
        try {
          const nodeFlags = translateFlags(flags);
          const handle = await fs.open(filePath, nodeFlags, 0o644);
          handles.set(fileId, handle);
          pOutFlags.setInt32(0, flags, true);
          return VFS.SQLITE_OK;
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException).code;
          if (errno === "ENOENT") return VFS.SQLITE_CANTOPEN;
          if (errno === "EACCES" || errno === "EPERM") return VFS.SQLITE_PERM;
          return VFS.SQLITE_IOERR;
        }
      });
    },

    xClose(fileId: number): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_OK;
        handles.delete(fileId);
        try {
          await handle.close();
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_CLOSE;
        }
      });
    },

    xRead(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_IOERR_READ;
        const buffer = pData instanceof Uint8Array ? pData : pData.value;
        try {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, iOffset);
          if (bytesRead < buffer.length) {
            buffer.fill(0, bytesRead);
            return VFS.SQLITE_IOERR_SHORT_READ;
          }
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_READ;
        }
      });
    },

    xWrite(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_IOERR_WRITE;
        const buffer = pData instanceof Uint8Array ? pData : pData.value;
        try {
          const { bytesWritten } = await handle.write(buffer, 0, buffer.length, iOffset);
          if (bytesWritten !== buffer.length) return VFS.SQLITE_IOERR_WRITE;
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_WRITE;
        }
      });
    },

    xTruncate(fileId: number, iSize: number): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_IOERR_TRUNCATE;
        try {
          await handle.truncate(iSize);
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_TRUNCATE;
        }
      });
    },

    xSync(fileId: number, _flags: number): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_OK;
        try {
          await handle.sync();
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_FSYNC;
        }
      });
    },

    xFileSize(fileId: number, pSize64: DataView): number {
      return handleAsync(async () => {
        const handle = handles.get(fileId);
        if (!handle) return VFS.SQLITE_IOERR_FSTAT;
        try {
          const stats = await handle.stat();
          pSize64.setBigInt64(0, BigInt(stats.size), true);
          return VFS.SQLITE_OK;
        } catch {
          return VFS.SQLITE_IOERR_FSTAT;
        }
      });
    },

    xDelete(name: string, _syncDir: number): number {
      return handleAsync(async () => {
        try {
          await fs.unlink(name);
          return VFS.SQLITE_OK;
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException).code;
          if (errno === "ENOENT") return VFS.SQLITE_IOERR_DELETE_NOENT;
          return VFS.SQLITE_IOERR_DELETE;
        }
      });
    },

    xAccess(name: string, flags: number, pResOut: DataView): number {
      return handleAsync(async () => {
        try {
          await fs.access(name);
          if (flags === VFS.SQLITE_ACCESS_READWRITE) {
            try {
              const h = await fs.open(name, "r+");
              await h.close();
              pResOut.setInt32(0, 1, true);
            } catch {
              pResOut.setInt32(0, 0, true);
            }
          } else {
            pResOut.setInt32(0, 1, true);
          }
          return VFS.SQLITE_OK;
        } catch {
          pResOut.setInt32(0, 0, true);
          return VFS.SQLITE_OK;
        }
      });
    },

    xLock(_fileId: number, _flags: number): number {
      return VFS.SQLITE_OK;
    },

    xUnlock(_fileId: number, _flags: number): number {
      return VFS.SQLITE_OK;
    },

    xCheckReservedLock(_fileId: number, pResOut: DataView): number {
      pResOut.setInt32(0, 0, true);
      return VFS.SQLITE_OK;
    },

    xFileControl(_fileId: number, _op: number, _pArg: DataView): number {
      return VFS.SQLITE_NOTFOUND;
    },

    xDeviceCharacteristics(_fileId: number): number {
      return 0;
    }
  };
}
