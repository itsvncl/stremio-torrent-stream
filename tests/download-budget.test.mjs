import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { DownloadBudget } from "../dist/torrent/download-budget.js";

const require = createRequire(import.meta.url);
const base = pathToFileURL(require.resolve("webtorrent"));
const { default: Torrent } = await import(new URL("./lib/torrent.js", base));
const { default: Piece } = await import(new URL("../torrent-piece/index.js", base));
const pieceLength = 64 * 1024;

function fixture(budget, length = pieceLength) {
  const requests = [];
  const writes = [];
  const wire = {
    type: "tcp", requests: [], downloadSpeed: () => 1024 * 1024,
    request(index, offset, size, callback) {
      const request = { index, offset, size, callback };
      requests.push(request);
      this.requests.push(request);
    },
    have() {},
  };
  const verified = new Set();
  const torrent = Object.assign(Object.create(Torrent.prototype), {
    client: { _pieceBudget: budget }, ready: true, destroyed: false, done: false,
    pieceLength: length, maxWebConns: 4,
    pieces: Array.from({ length: 3 }, () => new Piece(length)),
    _reservations: [null, null, null],
    _hashes: Array(3).fill(createHash("sha1").update(Buffer.alloc(length, 7)).digest("hex")),
    bitfield: { get: (index) => verified.has(index), set: (index) => verified.add(index) },
    _selections: { length: 1, get: () => ({ from: 0, to: 2, offset: 0 }) },
    wires: [wire],
    store: { put(index, buffer, callback) { writes.push({ index, buffer, callback }); } },
    _update() {},
    _checkDone() {},
    _debug() {},
    _destroy(error) {
      this.failure = error;
      this.destroyed = true;
      budget.cancelTorrent(this);
      this.client = null;
    },
  });
  return {
    torrent, wire, writes,
    request(index) { return torrent._request(wire, index, false); },
    async deliver(fill = 7, error) {
      const request = requests.shift();
      wire.requests.splice(wire.requests.indexOf(request), 1);
      await request.callback(error, error ? undefined : Buffer.alloc(request.size, fill));
      await nextTick();
    },
    async complete(index, fill = 7) {
      for (let i = 0; i < length / 16384; i++) {
        assert.equal(this.request(index), true);
        await this.deliver(fill);
      }
    },
  };
}

test("capacity is acquired before partial blocks and retained through hashing and writes", async () => {
  const budget = new DownloadBudget(2 * pieceLength);
  const source = fixture(budget);
  assert.equal(source.request(0), true);
  assert.equal(source.request(1), false);
  assert.equal(source.torrent.pieces[1]._buffer, null);
  await source.deliver();
  assert.equal(budget.getStats().partialBytes, 16384);
  assert.equal(budget.getStats().reservedBytes, 2 * pieceLength);
  for (let i = 0; i < 3; i++) {
    assert.equal(source.request(0), true);
    await source.deliver();
  }
  assert.equal(budget.getStats().pendingWriteBytes, pieceLength);
  assert.equal(source.request(1), false);
  source.writes[0].callback(null);
  await nextTick();
  assert.equal(budget.getStats().reservedBytes, 0);
  assert.equal(source.request(1), true);
  source.torrent._destroy();
});

test("destroyed torrents keep pending-write capacity until the real callback finishes", async () => {
  const budget = new DownloadBudget(2 * pieceLength);
  const first = fixture(budget);
  const second = fixture(budget);
  await first.complete(0);
  first.torrent._destroy();
  assert.equal(second.request(0), false);
  assert.equal(budget.getStats().pendingWriteBytes, pieceLength);
  first.writes[0].callback(null);
  await nextTick();
  assert.equal(second.request(0), true);
  second.torrent._destroy();
  assert.equal(budget.getStats().reservedBytes, 0);
});

test("write failures, bad hashes and failed empty requests release allocations explicitly", async () => {
  const budget = new DownloadBudget(2 * pieceLength);
  const failed = fixture(budget);
  await failed.complete(0);
  const error = new Error("Disk write failed");
  failed.writes[0].callback(error);
  assert.equal(failed.torrent.failure, error);
  assert.equal(budget.getStats().reservedBytes, 0);
  const corrupt = fixture(budget);
  await corrupt.complete(0, 8);
  assert.equal(corrupt.writes.length, 0);
  assert.equal(budget.getStats().reservedBytes, 0);
  assert.equal(corrupt.request(0), true);
  await corrupt.deliver(undefined, new Error("Peer disconnected"));
  assert.equal(budget.getStats().reservedBytes, 0);
});

test("stalled partials are reclaimed but outstanding requests are not evicted", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budget = new DownloadBudget(2 * pieceLength);
  const source = fixture(budget);
  source.request(0);
  assert.equal(source.request(1), false);
  t.mock.timers.tick(30000);
  await nextTick();
  assert.equal(budget.getStats().discardedPartialPieces, 0);
  await source.deliver();
  t.mock.timers.tick(30000);
  await nextTick();
  assert.equal(budget.getStats().discardedPartialPieces, 1);
  assert.equal(source.torrent.pieces[0]._buffer, null);
  assert.equal(source.request(1), true);
  source.torrent._destroy();
});

test("one oversized piece is serialized rather than deadlocking downloads", async () => {
  const budget = new DownloadBudget(pieceLength);
  const source = fixture(budget);
  await source.complete(0);
  assert.equal(budget.getStats().effectiveLimitBytes, 2 * pieceLength);
  assert.equal(source.request(1), false);
  source.writes[0].callback(null);
  await nextTick();
  assert.equal(source.request(1), true);
  source.torrent._destroy();
});

test("pending-write age measures disk wait and clears only after the callback", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const budget = new DownloadBudget(2 * pieceLength);
  const source = fixture(budget);
  await source.complete(0);
  t.mock.timers.tick(60000);
  assert.equal(budget.getStats().oldestPendingWriteMs, 60000);
  assert.equal(budget.getStats().reservedBytes, 2 * pieceLength);
  source.writes[0].callback(null);
  assert.equal(budget.getStats().oldestPendingWriteMs, 0);
  assert.equal(budget.getStats().reservedBytes, 0);
});
