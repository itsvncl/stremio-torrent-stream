import FSStore from "fs-chunk-store";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

type Callback = (error?: Error | null) => void;
type ReadCallback = (error: Error | null, buffer?: Buffer) => void;
interface ReadOptions { offset?: number; length?: number; }
interface StoredFile { path: string; length: number; offset: number; }
interface StoreTorrent {
  infoHash: string;
  _hashes?: string[];
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}
interface StoreOptions {
  torrent?: object;
  path?: string;
  files?: { path: string; length: number; offset?: number }[];
  length?: number;
  assemblyBatchBytes?: number;
}

const instances = new Map<string, PieceFileStore>();
const assemblyQueue = new Map<PieceFileStore, () => Promise<void>>();
let assembling = false;
const startNextAssembly = () => {
  if (assembling) return;
  const next = assemblyQueue.entries().next();
  if (next.done) return;
  const [store, run] = next.value;
  assemblyQueue.delete(store);
  assembling = true;
  run().finally(() => {
    assembling = false;
    startNextAssembly();
  });
};
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const isStoreTorrent = (value: unknown): value is StoreTorrent =>
  typeof value === "object" && value !== null &&
  "infoHash" in value && typeof value.infoHash === "string" &&
  "once" in value && typeof value.once === "function" &&
  "removeListener" in value && typeof value.removeListener === "function";

export const getPieceStorageStats = (hash: string) => instances.get(hash)?.getStats();
export const waitForPieceStorage = async (folder: string) => {
  const stores = [...instances.values()].filter((store) => store.files.some((file) => {
    const relative = path.relative(folder, file.path);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }));
  await Promise.all(stores.map((store) => new Promise<void>((resolve, reject) => {
    store.close((error) => error ? reject(error) : resolve());
  })));
};
// The legacy WebTorrent typings describe a callable store factory; WebTorrent also constructs it with `new`.
export function createPieceFileStore(chunkLength: number, options: unknown) {
  if (!isStoreOptions(options)) throw new Error("Invalid piece-file storage options");
  return new PieceFileStore(chunkLength, options);
}

const isStoreOptions = (value: unknown): value is StoreOptions => {
  if (typeof value !== "object" || value === null ||
    !("torrent" in value) || !isStoreTorrent(value.torrent)) return false;
  if ("path" in value && value.path !== undefined && typeof value.path !== "string") return false;
  if ("length" in value && value.length !== undefined && typeof value.length !== "number") return false;
  if ("assemblyBatchBytes" in value && value.assemblyBatchBytes !== undefined &&
    (!Number.isSafeInteger(value.assemblyBatchBytes) || Number(value.assemblyBatchBytes) <= 0)) return false;
  return "files" in value && Array.isArray(value.files) && value.files.every((file: unknown) =>
    typeof file === "object" && file !== null &&
    "path" in file && typeof file.path === "string" &&
    "length" in file && typeof file.length === "number" &&
    (!("offset" in file) || file.offset === undefined || typeof file.offset === "number"));
};

export class PieceFileStore extends FSStore {
  declare files: StoredFile[];
  declare length: number;
  declare closed: boolean;
  private readonly torrent: StoreTorrent;
  private readonly directory: string;
  declare chunkLength: number;
  private readonly totalPieces: number;
  private readonly assemblyBatchBytes: number;
  private cursor = 0;
  private stopping = false;
  private status = "downloading";
  private failure?: Error;
  private initialization: Promise<void>;
  private journal: Promise<void> = Promise.resolve();
  private assembly?: Promise<void>;
  private markers?: Promise<void>;
  private pendingWrites = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private readonly onDone = () => this.beginAssembly();

  constructor(chunkLength: number, options?: StoreOptions) {
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) throw new Error("Invalid chunk length");
    if (!isStoreTorrent(options?.torrent) || !/^[a-f0-9]{40}$/i.test(options.torrent.infoHash)) {
      throw new Error("Piece-file storage requires a torrent info hash");
    }
    super(chunkLength, options);
    this.torrent = options.torrent;
    this.totalPieces = Math.ceil(this.length / chunkLength);
    this.assemblyBatchBytes = options.assemblyBatchBytes ?? 64 * 1024 * 1024;
    let parent = this.files.length ? path.dirname(this.files[0].path) : options.path;
    if (!parent) throw new Error("Piece-file storage requires an output directory");
    for (const file of this.files) {
      while (path.relative(parent, file.path) === ".." || path.relative(parent, file.path).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(parent, file.path))) {
        const ancestor = path.dirname(parent);
        if (ancestor === parent) throw new Error("Output files must share a filesystem");
        parent = ancestor;
      }
    }
    this.directory = path.join(parent, `.stremio-pieces-${this.torrent.infoHash}`);
    this.initialization = this.loadCursor().catch((error) => this.report(error));
    instances.set(this.torrent.infoHash, this);
    this.torrent.once("done", this.onDone);
  }

  private piecePath(index: number) {
    return path.join(this.directory, String(Math.floor(index / 256)), `${index}.piece`);
  }

  private pieceSize(index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.totalPieces) {
      throw new Error(`Invalid piece index: ${index}`);
    }
    return Math.min(this.chunkLength, this.length - index * this.chunkLength);
  }

  put(index: number, buffer: Uint8Array, callback: Callback = () => {}) {
    const write = async () => {
      await this.initialization;
      if (this.failure) throw this.failure;
      if (this.stopping || this.closed) throw new Error("Storage is closed");
      if (buffer.byteLength !== this.pieceSize(index)) throw new Error("Invalid piece length");
      this.markers ??= this.createMarkers();
      await this.markers;
      const destination = this.piecePath(index);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(`${destination}.tmp`, buffer, { flush: true });
      await fs.rename(`${destination}.tmp`, destination);
      if (index < this.cursor) {
        this.cursor = index;
        await this.saveCursor();
      }
    };
    const pending = write();
    this.pendingWrites.add(pending);
    pending.then(() => {
      this.pendingWrites.delete(pending);
      callback(null);
    }, (error) => {
      this.pendingWrites.delete(pending);
      callback(asError(error));
    });
  }

  private async createMarkers() {
    for (const file of this.files) {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      const marker = `${file.path}.stremio-incomplete`;
      try {
        await fs.writeFile(marker, this.torrent.infoHash, { flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (await fs.readFile(marker, "utf8") !== this.torrent.infoHash) {
          throw new Error(`Another torrent owns the output file: ${file.path}`);
        }
      }
    }
  }

  get(index: number, options: ReadOptions | ReadCallback, callback?: ReadCallback) {
    const opts = typeof options === "function" ? {} : options || {};
    const done = typeof options === "function" ? options : callback;
    if (!done) throw new Error("A piece read callback is required");
    const read = async () => {
      await this.initialization;
      if (this.stopping || this.closed) throw new Error("Storage is closed");
      const size = this.pieceSize(index);
      const offset = opts.offset ?? 0;
      const length = opts.length ?? size - offset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new Error("Invalid piece read range");
      }
      let handle;
      try {
        handle = await fs.open(this.piecePath(index), "r");
      } catch (error) {
        if (!missing(error)) throw error;
        const data = await this.readFinal(index);
        if (createHash("sha1").update(data).digest("hex") !== this.torrent._hashes?.[index]) {
          throw new Error(`No verified stored data for piece ${index}`);
        }
        return data.subarray(offset, offset + length);
      }
      try {
        const buffer = Buffer.allocUnsafe(length);
        let received = 0;
        while (received < length) {
          const result = await handle.read(buffer, received, length - received, offset + received);
          if (!result.bytesRead) throw new Error(`Piece ${index} ended early`);
          received += result.bytesRead;
        }
        return buffer;
      } finally {
        await handle.close();
      }
    };
    read().then((buffer) => done(null, buffer), (error) => done(asError(error)));
  }

  private readFinal(index: number, options: ReadOptions = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      super.get(index, options, (error: Error | null, data?: Uint8Array) => {
        if (error) reject(error);
        else if (!data) reject(new Error(`No stored data for piece ${index}`));
        else resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      });
    });
  }

  private async loadCursor() {
    let value: string;
    try {
      value = await fs.readFile(path.join(this.directory, "progress"), "utf8");
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const cursor = Number(value);
    if (value.trim() === "" || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.totalPieces) {
      throw new Error("Invalid piece-file assembly progress");
    }
    this.cursor = cursor;
  }

  private saveCursor() {
    this.journal = this.journal.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, "progress.tmp");
      await fs.writeFile(temporary, String(this.cursor), { flush: true });
      await fs.rename(temporary, path.join(this.directory, "progress"));
    });
    return this.journal;
  }

  private beginAssembly() {
    if (this.status !== "downloading" || this.stopping) return;
    this.status = "queued";
    assemblyQueue.set(this, () => {
      this.assembly = this.assemble().catch((error) => this.report(error));
      return this.assembly;
    });
    startNextAssembly();
  }

  private async assemble() {
    await this.initialization;
    if (this.failure) throw this.failure;
    if (this.stopping) return;
    this.status = "assembling";
    try {
      await fs.stat(this.directory);
    } catch (error) {
      if (!missing(error)) throw error;
      // With no spool, WebTorrent has already verified the existing output files.
      this.cursor = this.totalPieces;
    }
    while (this.cursor < this.totalPieces && !this.stopping) {
      const first = this.cursor;
      let next = first;
      let batchBytes = 0;
      // Batches keep writes sequential while paying the slow USB/exFAT durability cost once per batch.
      while (next < this.totalPieces && !this.stopping && (next === first || batchBytes < this.assemblyBatchBytes)) {
        let data: Buffer;
        try {
          data = await fs.readFile(this.piecePath(next));
        } catch (error) {
          if (!missing(error)) throw error;
          data = await this.readFinal(next);
          if (createHash("sha1").update(data).digest("hex") !== this.torrent._hashes?.[next]) {
            throw new Error(`Missing or corrupted assembly piece ${next}`);
          }
        }
        // Only ascending, contiguous writes reach the movie files; far-offset pieces stay in the spool.
        await new Promise<void>((resolve, reject) => {
          super.put(next, data, (error: Error | null) => error ? reject(error) : resolve());
        });
        batchBytes += data.length;
        next++;
      }
      if (this.stopping) return;
      await this.syncOutput(first, next);
      if (this.stopping) return;
      if (this.cursor !== first) continue;
      this.cursor = next;
      await this.saveCursor();
      for (let index = first; index < next; index++) await fs.rm(this.piecePath(index), { force: true });
    }
    if (!this.stopping) {
      for (const file of this.files) {
        if (file.length === 0) {
          await fs.mkdir(path.dirname(file.path), { recursive: true });
          await fs.writeFile(file.path, Buffer.alloc(0));
        }
        try {
          const marker = `${file.path}.stremio-incomplete`;
          if (await fs.readFile(marker, "utf8") === this.torrent.infoHash) await fs.unlink(marker);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      this.status = "ready";
    }
  }

  private async syncOutput(first: number, next: number) {
    const start = first * this.chunkLength;
    const end = Math.min(this.length, next * this.chunkLength);
    for (const file of this.files) {
      if (file.offset >= end || file.offset + file.length <= start) continue;
      const handle = await fs.open(file.path, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private report(error: unknown) {
    this.failure = asError(error);
    this.status = "error";
    console.error(`Piece-file storage ${this.torrent.infoHash}: ${this.failure.message}`);
  }

  getStats() {
    return { mode: "piece-files", status: this.status, assembledPieces: this.cursor, totalPieces: this.totalPieces, error: this.failure?.message };
  }

  close(callback: Callback = () => {}) {
    if (!this.closing) {
      const active = this.status === "assembling";
      this.stopping = true;
      assemblyQueue.delete(this);
      this.torrent.removeListener("done", this.onDone);
      const finish = async () => {
        const writes = await Promise.allSettled([...this.pendingWrites]);
        if (active) await this.assembly;
        await new Promise<void>((resolve, reject) => super.close((error: Error | null) => error ? reject(error) : resolve()));
        const failed = writes.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      };
      this.closing = finish().finally(() => {
        if (instances.get(this.torrent.infoHash) === this) instances.delete(this.torrent.infoHash);
      });
    }
    this.closing.then(() => callback(null), (error) => callback(asError(error)));
  }

  destroy(callback: Callback = () => {}) {
    this.close((error) => {
      if (error) return callback(error);
      const remove = async () => {
        for (const file of this.files) {
          try {
            const owner = await fs.readFile(`${file.path}.stremio-incomplete`, "utf8");
            if (owner !== this.torrent.infoHash) throw new Error(`Another torrent owns the output file: ${file.path}`);
          } catch (failure) {
            if (!missing(failure)) throw failure;
          }
        }
        for (const file of this.files) {
          await fs.rm(file.path, { force: true });
          await fs.rm(`${file.path}.stremio-incomplete`, { force: true });
        }
        await fs.rm(this.directory, { recursive: true, force: true });
      };
      remove().then(() => callback(null), (failure) => callback(asError(failure)));
    });
  }
}
