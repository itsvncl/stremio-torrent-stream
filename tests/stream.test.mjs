import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { pipeTorrentStream } from "../dist/utils/stream.js";

const require = createRequire(import.meta.url);
const { default: File } = await import(
  new URL("./lib/file.js", pathToFileURL(require.resolve("webtorrent")))
);

function createFile(length, { stalled = false, error } = {}) {
  let bytesRead = 0;
  let selections = 0;
  let available = !stalled;
  const torrent = Object.assign(new EventEmitter(), {
    client: {},
    pieceLength: 64 * 1024,
    bitfield: { get: () => available },
    _select() { selections++; },
    _deselect() { selections--; },
    critical() {},
    store: {
      get(_index, options, callback) {
        bytesRead += options.length;
        setImmediate(() => callback(error, error ? undefined : Buffer.alloc(options.length, 7)));
      },
    },
  });
  const file = new File(torrent, { name: "video.mkv", path: "video.mkv", length, offset: 0 });
  return {
    file,
    bytesRead: () => bytesRead,
    selections: () => selections,
    release() {
      available = true;
      torrent.emit("verified", 0);
    },
  };
}

test("slow consumers do not buffer the whole torrent file", async () => {
  const { file, bytesRead, selections } = createFile(64 * 1024 * 1024);
  const source = file.createReadStream();
  const response = new Writable({ write() {} });
  const closed = new Promise((resolve) => source.once("close", resolve));
  pipeTorrentStream(source, response, file.length);

  for (let i = 0; i < 10; i++) await nextTick();
  assert.ok(bytesRead() > 0);
  assert.ok(bytesRead() <= 4 * 64 * 1024, `Read ahead ${bytesRead()} bytes`);
  response.destroy();
  await closed;
  assert.equal(selections(), 0);
  assert.equal(file._fileStreams.size, 0);
});

test("successful streams preserve bytes and clear timeout work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = t.mock.method(console, "error", () => {});
  const { file, selections } = createFile(128 * 1024);
  const chunks = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  pipeTorrentStream(file.createReadStream(), response, file.length);
  await once(response, "finish");
  await nextTick();
  t.mock.timers.tick(60000);

  assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(128 * 1024, 7));
  assert.equal(selections(), 0);
  assert.equal(file._fileStreams.size, 0);
  assert.equal(errors.mock.calls.filter((call) => call.arguments[0].startsWith("Torrent stream failed:")).length, 0);
});

test("the first-data timeout destroys the torrent read and response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = t.mock.method(console, "error", () => {});
  const { file, selections, release } = createFile(128 * 1024, { stalled: true });
  const source = file.createReadStream();
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.on("error", () => {});
  const closed = new Promise((resolve) => response.once("close", resolve));
  pipeTorrentStream(source, response, file.length);
  await nextTick();
  t.mock.timers.tick(10000);
  await closed;
  await nextTick();

  assert.equal(source.destroying, true);
  assert.equal(response.destroyed, true);
  assert.equal(selections(), 0);
  release();
  for (let i = 0; i < 3; i++) await nextTick();
  assert.equal(file._fileStreams.size, 0);
  assert.match(errors.mock.calls[0].arguments[0], /no data/);
});

test("upstream read failures ending the iterator early terminate the response", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { file, selections } = createFile(128 * 1024, { error: new Error("Disk read failed") });
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.on("error", () => {});
  const closed = new Promise((resolve) => response.once("close", resolve));
  pipeTorrentStream(file.createReadStream(), response, file.length);
  await closed;
  await nextTick();

  assert.equal(selections(), 0);
  assert.equal(file._fileStreams.size, 0);
  assert.match(errors.mock.calls[0].arguments[0], /ended early: 0 of 131072 bytes/);
});

test("the idle timeout refreshes on data and terminates stalled transfers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = t.mock.method(console, "error", () => {});
  const source = new PassThrough();
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.on("error", () => {});
  const closed = new Promise((resolve) => response.once("close", resolve));
  pipeTorrentStream(source, response, 11);
  source.write(Buffer.from("first"));
  await nextTick();
  t.mock.timers.tick(59000);
  assert.equal(response.destroyed, false);

  source.write(Buffer.from("second"));
  await nextTick();
  t.mock.timers.tick(59000);
  assert.equal(response.destroyed, false);
  t.mock.timers.tick(1000);
  await closed;
  await nextTick();
  assert.equal(source.destroyed, true);
  assert.match(errors.mock.calls[0].arguments[0], /stalled/);
});

test("data outside the requested byte range fails explicitly", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const source = new PassThrough();
  const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  response.on("error", () => {});
  const closed = new Promise((resolve) => response.once("close", resolve));
  pipeTorrentStream(source, response, 4);
  source.end(Buffer.from("too long"));
  await closed;
  await nextTick();
  assert.match(errors.mock.calls[0].arguments[0], /exceeded the requested 4 bytes/);
});
