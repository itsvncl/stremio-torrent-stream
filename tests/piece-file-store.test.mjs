import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WebTorrent from "webtorrent";
import MemoryStore from "memory-chunk-store";
import { PieceFileStore, createPieceFileStore } from "../dist/torrent/piece-file-store.js";
import { DownloadBudget } from "../dist/torrent/download-budget.js";

const hash = (data) => createHash("sha1").update(data).digest("hex");
const put = (store, index, data) => new Promise((resolve, reject) =>
  store.put(index, data, (error) => error ? reject(error) : resolve()));
const get = (store, index, options = {}) => new Promise((resolve, reject) =>
  store.get(index, options, (error, data) => error ? reject(error) : resolve(data)));
const close = (store) => new Promise((resolve, reject) => store.close((error) => error ? reject(error) : resolve()));
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Storage operation timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const makeTorrent = (chunks) => Object.assign(new EventEmitter(), {
  infoHash: hash(Buffer.concat(chunks)), _hashes: chunks.map(hash),
});
const temporary = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test("a tail piece of a 13 GiB movie never extends the movie, and survives restart", async (t) => {
  const directory = await temporary(t);
  const chunkLength = 2097152;
  const length = 14097120452;
  const data = Buffer.alloc(length % chunkLength, 17);
  const torrent = makeTorrent([data]);
  const options = { path: directory, torrent, files: [{ path: "movie.mkv", length }] };
  let store = new PieceFileStore(chunkLength, options);
  t.after(() => close(store));
  const index = Math.floor(length / chunkLength);
  await put(store, index, data);
  await assert.rejects(fs.stat(path.join(directory, "movie.mkv")), { code: "ENOENT" });
  const spool = path.join(directory, `.stremio-pieces-${torrent.infoHash}`, String(Math.floor(index / 256)), `${index}.piece`);
  assert.equal((await fs.stat(spool)).size, data.length);
  assert.deepEqual(await get(store, index, { offset: 100, length: 1000 }), data.subarray(100, 1100));
  await close(store);
  store = new PieceFileStore(chunkLength, options);
  assert.deepEqual(await get(store, index), data);
});

test("out-of-order chunks assemble across nested file boundaries and reclaim spool data", async (t) => {
  const directory = await temporary(t);
  const chunks = [Buffer.from("abcd"), Buffer.from("efgh"), Buffer.from("ij")];
  const torrent = makeTorrent(chunks);
  const files = [{ path: path.join("movie", "sample", "a"), length: 3 },
    { path: path.join("movie", "b"), length: 7 }];
  const store = new createPieceFileStore(4, { path: directory, torrent, files });
  t.after(() => close(store));
  for (const index of [2, 0, 1]) await put(store, index, chunks[index]);
  const output = path.join(directory, "movie", "b");
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
  const spool = path.join(directory, "movie", `.stremio-pieces-${torrent.infoHash}`);
  torrent.emit("done");
  await waitFor(() => store.getStats().status === "ready");
  assert.deepEqual(await fs.readFile(path.join(directory, "movie", "sample", "a")), Buffer.from("abc"));
  assert.deepEqual(await fs.readFile(output), Buffer.from("defghij"));
  for (const index of [0, 1, 2]) {
    await assert.rejects(fs.stat(path.join(spool, "0", `${index}.piece`)), { code: "ENOENT" });
    assert.deepEqual(await get(store, index), chunks[index]);
  }
  await assert.rejects(fs.stat(`${output}.stremio-incomplete`), { code: "ENOENT" });
});

test("close waits for an actual pending spool flush, then safely destroys a closed store", async (t) => {
  const directory = await temporary(t);
  const chunks = [Buffer.from("abcd")];
  const torrent = makeTorrent(chunks);
  const store = new PieceFileStore(4, { path: directory, torrent, files: [{ path: "a", length: 4 }] });
  const original = fs.writeFile;
  let release;
  let flushing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "writeFile", async (file, data, options) => {
    if (String(file).endsWith(".piece.tmp")) {
      assert.equal(options.flush, true);
      flushing = true;
      await gate;
    }
    return original(file, data, options);
  });
  const write = put(store, 0, chunks[0]);
  await waitFor(() => flushing);
  let closed = false;
  const stopped = close(store).then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  release();
  await Promise.all([write, stopped]);
  await new Promise((resolve, reject) => store.destroy((error) => error ? reject(error) : resolve()));
  await assert.rejects(fs.stat(path.join(directory, `.stremio-pieces-${torrent.infoHash}`)), { code: "ENOENT" });
});

test("interrupted materialization retains pieces and repairs a previously materialized prefix", async (t) => {
  const directory = await temporary(t);
  const chunks = [Buffer.from("abcd"), Buffer.from("efgh"), Buffer.from("ij")];
  const torrent = makeTorrent(chunks);
  const options = { path: directory, torrent, files: [{ path: "a", length: 10 }], assemblyBatchBytes: 8 };
  let store = new PieceFileStore(4, options);
  t.after(() => close(store));
  for (let index = 0; index < chunks.length; index++) await put(store, index, chunks[index]);
  const original = fs.open;
  let release;
  let syncing = false;
  let syncCalls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[1] === "r+") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (++syncCalls === 2) { syncing = true; await gate; }
        return sync();
      };
    }
    return handle;
  });
  torrent.emit("done");
  await waitFor(() => syncing);
  const stopped = close(store);
  release();
  await stopped;
  assert.equal(store.getStats().assembledPieces, 2);
  assert.equal(syncCalls, 2, "Two four-byte pieces must share one durability flush");
  const output = await original(path.join(directory, "a"), "r+");
  await output.write(Buffer.from("XXXX"), 0, 4, 0);
  await output.close();
  t.mock.restoreAll();
  store = new PieceFileStore(4, options);
  await assert.rejects(get(store, 0), /No verified stored data/);
  await put(store, 0, chunks[0]);
  torrent.emit("done");
  await waitFor(() => store.getStats().status === "ready");
  assert.deepEqual(await fs.readFile(path.join(directory, "a")), Buffer.concat(chunks));
});

test("assembly errors remain visible and preserve recoverable chunks and incomplete markers", async (t) => {
  const directory = await temporary(t);
  const chunks = [Buffer.from("abcd")];
  const torrent = makeTorrent(chunks);
  const store = new PieceFileStore(4, { path: directory, torrent, files: [{ path: "a", length: 4 }] });
  t.after(() => close(store));
  await put(store, 0, chunks[0]);
  await fs.mkdir(path.join(directory, "a"));
  torrent.emit("done");
  await waitFor(() => store.getStats().status === "error");
  assert.match(store.getStats().error, /directory|EISDIR|EPERM/i);
  assert.deepEqual(await get(store, 0), chunks[0]);
  assert.equal(await fs.readFile(path.join(directory, "a.stremio-incomplete"), "utf8"), torrent.infoHash);
});

test("already-completed direct files are supported and wrong data is never served as a missing spool piece", async (t) => {
  const directory = await temporary(t);
  const chunks = [Buffer.from("abcd")];
  const torrent = makeTorrent(chunks);
  const store = new PieceFileStore(4, { path: directory, torrent, files: [{ path: "a", length: 4 }] });
  t.after(() => close(store));
  await fs.writeFile(path.join(directory, "a"), chunks[0]);
  assert.deepEqual(await get(store, 0, { offset: 1, length: 2 }), Buffer.from("bc"));
  torrent.emit("done");
  await waitFor(() => store.getStats().status === "ready");
  await fs.writeFile(path.join(directory, "a"), Buffer.from("XXXX"));
  await assert.rejects(get(store, 0), /No verified stored data/);
});

test("closing a queued materialization preserves its spool without blocking on another torrent", async (t) => {
  const directory = await temporary(t);
  const firstTorrent = makeTorrent([Buffer.from("abcd")]);
  const secondTorrent = makeTorrent([Buffer.from("wxyz")]);
  const first = new PieceFileStore(4, { path: directory, torrent: firstTorrent, files: [{ path: "a", length: 4 }] });
  let second = new PieceFileStore(4, { path: directory, torrent: secondTorrent, files: [{ path: "b", length: 4 }] });
  t.after(() => Promise.all([close(first), close(second)]));
  await put(first, 0, Buffer.from("abcd"));
  await put(second, 0, Buffer.from("wxyz"));
  const original = fs.open;
  let release;
  let syncing = false;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "open", async (...args) => {
    const handle = await original(...args);
    if (args[1] === "r+") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { syncing = true; await gate; return sync(); };
    }
    return handle;
  });
  firstTorrent.emit("done");
  await waitFor(() => syncing);
  secondTorrent.emit("done");
  assert.equal(second.getStats().status, "queued");
  await close(second);
  await assert.rejects(fs.stat(path.join(directory, "b")), { code: "ENOENT" });
  release();
  await waitFor(() => first.getStats().status === "ready");
  t.mock.restoreAll();
  second = new PieceFileStore(4, { path: directory, torrent: secondTorrent, files: [{ path: "b", length: 4 }] });
  secondTorrent.emit("done");
  await waitFor(() => second.getStats().status === "ready");
  assert.deepEqual(await fs.readFile(path.join(directory, "b")), Buffer.from("wxyz"));
});

test("real peers download, seek before completion and seed from the sparse-safe store", { timeout: 30000 }, async (t) => {
  const directory = await temporary(t);
  const budget = new DownloadBudget(256 * 1024);
  const options = { tracker: false, dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, torrentPort: 0 };
  const seeder = new WebTorrent(options);
  const downloader = new WebTorrent({ ...options, pieceBudget: budget });
  const receiver = new WebTorrent(options);
  t.after(() => Promise.all([seeder, downloader, receiver].map((client) => new Promise((resolve, reject) =>
    client.destroy((error) => error ? reject(error) : resolve())))));
  const data = Buffer.alloc(4 * 1024 * 1024);
  for (let offset = 0; offset < data.length; offset += 16384) data.fill(offset / 16384 % 251, offset, offset + 16384);
  const listening = once(seeder, "listening");
  const seeded = once(seeder, "seed");
  seeder.seed(data, { name: "movie", store: MemoryStore, pieceLength: 64 * 1024 });
  const [seedTorrent] = await seeded;
  await listening;
  const ready = once(downloader, "torrent");
  downloader.add(seedTorrent.torrentFile, { path: directory, store: createPieceFileStore, storeCacheSlots: 5 });
  const [torrent] = await ready;
  const requests = [];
  let peakReserved = 0;
  torrent.on("wire", (wire) => {
    const request = wire.request;
    t.mock.method(wire, "request", function (index, ...args) {
      requests.push(index);
      peakReserved = Math.max(peakReserved, budget.getStats().reservedBytes);
      return request.call(this, index, ...args);
    });
  });
  const done = once(torrent, "done");
  const seeking = (async () => {
    const chunks = [];
    for await (const chunk of torrent.files[0].createReadStream({ start: data.length - 32768, end: data.length - 16385 })) {
      chunks.push(chunk);
    }
    assert.equal(torrent.done, false);
    assert.deepEqual(Buffer.concat(chunks), data.subarray(data.length - 32768, data.length - 16384));
    await assert.rejects(fs.stat(path.join(directory, "movie")), { code: "ENOENT" });
  })();
  assert.equal(torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`), true);
  await seeking;
  await done;
  const { getPieceStorageStats } = await import("../dist/torrent/piece-file-store.js");
  await waitFor(() => getPieceStorageStats(torrent.infoHash)?.status === "ready");
  assert.equal(requests[0], 0, "Sequential bootstrap must not start at the end of the movie");
  assert.equal(budget.getStats().reservedBytes, 0);
  assert.ok(peakReserved > 0 && peakReserved <= budget.limitBytes);
  assert.ok((await fs.readFile(path.join(directory, "movie"))).equals(data), "Materialized movie bytes differ");
  const uploaded = [];
  for await (const chunk of torrent.files[0].createReadStream({ start: 0, end: 32767 })) uploaded.push(chunk);
  assert.deepEqual(Buffer.concat(uploaded), data.subarray(0, 32768));
  const received = once(receiver, "torrent");
  receiver.add(seedTorrent.torrentFile, { store: MemoryStore });
  const [receivingTorrent] = await received;
  const receivedAll = once(receivingTorrent, "done");
  assert.equal(receivingTorrent.addPeer(`127.0.0.1:${downloader.torrentPort}`), true);
  await receivedAll;
  const receivedChunks = [];
  for await (const chunk of receivingTorrent.files[0].createReadStream()) receivedChunks.push(chunk);
  assert.ok(Buffer.concat(receivedChunks).equals(data), "Peer received incorrect seeded bytes");
  assert.ok(torrent.uploaded >= data.length);
});
