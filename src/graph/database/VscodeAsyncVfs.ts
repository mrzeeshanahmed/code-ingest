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
  xSectorSize(fileId: number): number;
  xDeviceCharacteristics(fileId: number): number;
  xDelete(name: string, syncDir: number): number;
  xAccess(name: string, flags: number, pResOut: DataView): number;
  dispose(): Promise<void>;
}

export class VscodeAsyncVfsImpl implements VscodeAsyncVfs {
  public readonly name = "vscode-async-vfs";
  public readonly mxPathName = 512;
  private handles = new Map<number, fs.FileHandle>();
  private VFS: any;

  constructor(VFS: any) {
    this.VFS = VFS;
  }

  private translateFlags(sqliteFlags: number): number {
    let flags = 0;
    if (sqliteFlags & this.VFS.SQLITE_OPEN_READONLY) {
      flags = O_RDONLY;
    } else {
      flags = O_RDWR;
    }
    if (sqliteFlags & this.VFS.SQLITE_OPEN_CREATE) {
      flags |= O_CREAT;
    }
    return flags;
  }

  private generateTempName(): string {
    return path.join(os.tmpdir(), `wa-sqlite-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  public handleAsync(f: () => Promise<number>): number {
    return f() as unknown as number;
  }

  public xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    return this.handleAsync(async () => {
      const filePath = name ?? this.generateTempName();
      try {
        const nodeFlags = this.translateFlags(flags);
        const handle = await fs.open(filePath, nodeFlags, 0o644);
        this.handles.set(fileId, handle);
        pOutFlags.setInt32(0, flags, true);
        return this.VFS.SQLITE_OK;
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") return this.VFS.SQLITE_CANTOPEN;
        if (errno === "EACCES" || errno === "EPERM") return this.VFS.SQLITE_PERM;
        return this.VFS.SQLITE_IOERR;
      }
    });
  }

  public xClose(fileId: number): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_OK;
      this.handles.delete(fileId);
      try {
        await handle.close();
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_CLOSE;
      }
    });
  }

  public xRead(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_IOERR_READ;
      const buffer = pData instanceof Uint8Array ? pData : pData.value;
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, iOffset);
        if (bytesRead < buffer.length) {
          buffer.fill(0, bytesRead);
          return this.VFS.SQLITE_IOERR_SHORT_READ;
        }
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_READ;
      }
    });
  }

  public xWrite(fileId: number, pData: Uint8Array | { size: number; value: Uint8Array }, iOffset: number): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_IOERR_WRITE;
      const buffer = pData instanceof Uint8Array ? pData : pData.value;
      try {
        const { bytesWritten } = await handle.write(buffer, 0, buffer.length, iOffset);
        if (bytesWritten !== buffer.length) return this.VFS.SQLITE_IOERR_WRITE;
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_WRITE;
      }
    });
  }

  public xTruncate(fileId: number, iSize: number): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_IOERR_TRUNCATE;
      try {
        await handle.truncate(iSize);
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_TRUNCATE;
      }
    });
  }

  public xSync(fileId: number, _flags: number): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_OK;
      try {
        await handle.sync();
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_FSYNC;
      }
    });
  }

  public xFileSize(fileId: number, pSize64: DataView): number {
    return this.handleAsync(async () => {
      const handle = this.handles.get(fileId);
      if (!handle) return this.VFS.SQLITE_IOERR_FSTAT;
      try {
        const stats = await handle.stat();
        pSize64.setBigInt64(0, BigInt(stats.size), true);
        return this.VFS.SQLITE_OK;
      } catch {
        return this.VFS.SQLITE_IOERR_FSTAT;
      }
    });
  }

  public xDelete(name: string, _syncDir: number): number {
    return this.handleAsync(async () => {
      try {
        await fs.unlink(name);
        return this.VFS.SQLITE_OK;
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") return this.VFS.SQLITE_IOERR_DELETE_NOENT;
        return this.VFS.SQLITE_IOERR_DELETE;
      }
    });
  }

  public xAccess(name: string, flags: number, pResOut: DataView): number {
    return this.handleAsync(async () => {
      try {
        await fs.access(name);
        if (flags === this.VFS.SQLITE_ACCESS_READWRITE) {
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
        return this.VFS.SQLITE_OK;
      } catch {
        pResOut.setInt32(0, 0, true);
        return this.VFS.SQLITE_OK;
      }
    });
  }

  public xLock(_fileId: number, _flags: number): number {
    return this.VFS.SQLITE_OK;
  }

  public xUnlock(_fileId: number, _flags: number): number {
    return this.VFS.SQLITE_OK;
  }

  public xCheckReservedLock(_fileId: number, pResOut: DataView): number {
    pResOut.setInt32(0, 0, true);
    return this.VFS.SQLITE_OK;
  }

  public xFileControl(_fileId: number, _op: number, _pArg: DataView): number {
    return this.VFS.SQLITE_NOTFOUND;
  }

  public xSectorSize(_fileId: number): number {
    return 4096;
  }

  public xDeviceCharacteristics(_fileId: number): number {
    return 0;
  }

  public async dispose(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [fileId, handle] of this.handles.entries()) {
      closePromises.push(handle.close().catch(() => {}));
    }
    this.handles.clear();
    await Promise.all(closePromises);
  }
}

export async function createVscodeAsyncVfs(): Promise<VscodeAsyncVfs> {
  const VFS = await loadSqliteConstants();
  return new VscodeAsyncVfsImpl(VFS);
}
