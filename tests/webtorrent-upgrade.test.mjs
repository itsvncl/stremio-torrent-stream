import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DownloadBudget } from "../dist/torrent/download-budget.js";
import MemoryStore from "memory-chunk-store";
import WebTorrent from "webtorrent";

const require = createRequire(import.meta.url);
const torrentURL = pathToFileURL(require.resolve("webtorrent"));
const { default: FSStore } = await import(new URL("../fs-chunk-store/index.js", torrentURL));

for (const bounded of [false, true]) {
test(bounded ? "real disk download stays within the allocation budget across 128 write cycles"
  : "upstream control reproduces writes exceeding the same memory budget", { timeout: 30000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-budget-test-"));
  const budget = new DownloadBudget(256 * 1024);
  const options = { tracker: false, dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, torrentPort: 0 };
  const seeder = new WebTorrent(options);
  const downloader = new WebTorrent({ ...options, pieceBudget: bounded ? budget : undefined });
  t.after(async () => {
    await Promise.all([seeder, downloader].map((client) => new Promise((resolve, reject) => {
      client.destroy((error) => error ? reject(error) : resolve());
    })));
    await fs.rm(path.join(directory, "local-upgrade-test"), { force: true });
    await fs.rmdir(directory);
  });

  let pendingBytes = 0;
  let peakPendingBytes = 0;
  let peakReservedBytes = 0;
  class SlowStore extends FSStore {
    put(index, buffer, callback) {
      pendingBytes += buffer.byteLength;
      peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
      peakReservedBytes = Math.max(peakReservedBytes, budget.getStats().reservedBytes);
      super.put(index, buffer, (error) => {
        setTimeout(() => {
          pendingBytes -= buffer.byteLength;
          callback(error);
        }, 30);
      });
    }
  }

  const data = Buffer.alloc((bounded ? 16 : 4) * 1024 * 1024);
  for (let offset = 0; offset < data.length; offset += 16384) {
    data.fill((offset / 16384) % 251, offset, Math.min(offset + 16384, data.length));
  }
  const listening = once(seeder, "listening");
  const seeded = once(seeder, "seed");
  seeder.seed(data, { name: "local-upgrade-test", store: MemoryStore, pieceLength: 64 * 1024 });
  const [seedTorrent] = await seeded;
  await listening;

  let peakRetainedGrowth = 0;
  let baseline;
  const sampleMemory = bounded && typeof global.gc === "function" ? () => {
    global.gc();
    peakRetainedGrowth = Math.max(peakRetainedGrowth, process.memoryUsage().arrayBuffers - baseline);
  } : undefined;
  if (sampleMemory) {
    global.gc();
    baseline = process.memoryUsage().arrayBuffers;
  }
  const sampler = sampleMemory ? setInterval(sampleMemory, 100) : undefined;
  t.after(() => clearInterval(sampler));

  const ready = once(downloader, "torrent");
  downloader.add(seedTorrent.torrentFile, { store: SlowStore, storeCacheSlots: 5, path: directory });
  const [torrent] = await ready;
  const done = once(torrent, "done");
  const readRange = async (start, end) => {
    const chunks = [];
    for await (const chunk of torrent.files[0].createReadStream({ start, end })) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), data.subarray(start, end + 1));
  };
  const ranges = bounded ? Promise.all([
    readRange(16384, 32767).then(() => assert.equal(torrent.done, false)),
    readRange(data.length - 32768, data.length - 16385),
  ]) : Promise.resolve();
  assert.equal(torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`), true);
  await ranges;
  await done;
  if (sampleMemory) {
    sampleMemory();
    clearInterval(sampler);
    assert.ok(peakRetainedGrowth <= 8 * 1024 * 1024, `Retained buffers kept growing: ${peakRetainedGrowth}`);
    t.diagnostic(`Measured peak retained ArrayBuffer growth after GC: ${peakRetainedGrowth} bytes`);
  }

  assert.equal(pendingBytes, 0);
  assert.ok(peakPendingBytes > 0);
  if (bounded) {
    assert.equal(peakReservedBytes, budget.limitBytes);
    assert.ok(peakPendingBytes <= budget.limitBytes / 2, `Unbounded writes: ${peakPendingBytes}`);
    assert.equal(budget.getStats().reservedBytes, 0);
  } else {
    assert.ok(peakPendingBytes > budget.limitBytes, "Control did not reproduce the unbounded queue");
  }
  const hash = createHash("sha256");
  for await (const chunk of torrent.files[0].createReadStream()) hash.update(chunk);
  assert.equal(hash.digest("hex"), createHash("sha256").update(data).digest("hex"));
  t.diagnostic(`${data.length} bytes downloaded to disk; peak write payload ${peakPendingBytes}, peak reserved ${peakReservedBytes}`);
});
}

test("concurrent torrents share one budget and both make progress before either finishes", { timeout: 15000 }, async (t) => {
  const options = { tracker: false, dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, torrentPort: 0 };
  const budget = new DownloadBudget(256 * 1024);
  const seeder = new WebTorrent(options);
  const downloader = new WebTorrent({ ...options, pieceBudget: budget });
  t.after(async () => {
    await Promise.all([seeder, downloader].map((client) => new Promise((resolve, reject) => {
      client.destroy((error) => error ? reject(error) : resolve());
    })));
  });
  let pending = 0;
  let peak = 0;
  class SlowStore extends MemoryStore {
    put(index, buffer, callback) {
      pending += buffer.byteLength;
      peak = Math.max(peak, pending);
      setTimeout(() => super.put(index, buffer, (error) => {
        pending -= buffer.byteLength;
        callback(error);
      }), 20);
    }
  }
  const torrents = [];
  const done = [];
  const listening = once(seeder, "listening");
  for (const fill of [7, 8]) {
    const seeded = once(seeder, "seed");
    seeder.seed(Buffer.alloc(2 * 1024 * 1024, fill), { name: `shared-budget-${fill}`, store: MemoryStore, pieceLength: 65536 });
    const [seedTorrent] = await seeded;
    const ready = once(downloader, "torrent");
    downloader.add(seedTorrent.torrentFile, { store: SlowStore, storeCacheSlots: 5 });
    const [torrent] = await ready;
    torrents.push(torrent);
    done.push(once(torrent, "done"));
  }
  await listening;
  for (const torrent of torrents) {
    torrent.once("done", () => {
      assert.ok(torrents.find((other) => other !== torrent).downloaded > 0, "Another torrent was starved");
    });
    assert.equal(torrent.addPeer(`127.0.0.1:${seeder.torrentPort}`), true);
  }
  await Promise.all(done);
  assert.ok(peak <= budget.limitBytes / 2, `Per-torrent rather than shared limit: ${peak}`);
  assert.equal(pending, 0);
  assert.equal(budget.getStats().reservedBytes, 0);
});

test("queued filesystem writes share piece storage instead of duplicating payloads", async (t) => {
  for (const fileCount of [1, 2]) {
    await t.test(`${fileCount} target file(s)`, async () => {
      const payload = new Uint8Array(64 * 1024).fill(7);
      const store = new FSStore(payload.byteLength, {
        files: Array.from({ length: fileCount }, (_, index) => ({
          path: `unused-test-file-${index}`,
          length: payload.byteLength / fileCount,
        })),
      });
      const writes = [];
      for (const file of store.files) {
        file.open = (callback) => callback(null, {
          write(_offset, buffer, done) { writes.push({ buffer, done }); },
        });
      }
      const completed = new Promise((resolve, reject) => {
        store.put(0, payload, (error) => error ? reject(error) : resolve());
      });
      assert.equal(writes.length, fileCount);
      const backingBuffers = new Set([payload.buffer, ...writes.map(({ buffer }) => buffer.buffer)]);
      const retainedBytes = [...backingBuffers].reduce((total, buffer) => total + buffer.byteLength, 0);
      assert.equal(retainedBytes, payload.byteLength);
      assert.equal(writes.reduce((total, { buffer }) => total + buffer.byteLength, 0), payload.byteLength);
      for (const { done } of writes) done(null);
      await completed;
    });
  }
});
