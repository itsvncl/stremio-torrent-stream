import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, mock, test } from "node:test";
import bencode from "bencode";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "torrent-lifecycle-test-"));
process.env.DOWNLOAD_DIR = directory;
process.env.KEEP_DOWNLOADED_FILES = "true";
process.env.AUTO_SEED = "false";
process.env.SEED_TIME = "1000";
process.env.STORE_CACHE_SLOTS = "3";
const clients = [];

class Client extends EventEmitter {
  torrents = [];
  additions = [];

  constructor(options) {
    super();
    options.pieceBudget?.attach();
    clients.push(this);
  }

  async get(hash) {
    return this.torrents.find((torrent) => torrent.infoHash === hash);
  }

  add(uri, options, callback) {
    const torrent = {
      name: path.basename(uri),
      infoHash: uri,
      files: [],
      destroy: (_options, done) => {
        this.torrents = this.torrents.filter((entry) => entry !== torrent);
        done?.();
      },
    };
    this.additions.push({ options, torrent });
    this.torrents.push(torrent);
    queueMicrotask(() => callback(torrent));
    return torrent;
  }
}

mock.module("webtorrent", { defaultExport: Client });
const {
  getOrAddTorrent, getTorrentInfoFromWebtorrent, seedDirectory,
  streamOpened, streamClosed, getStats,
  saveOrGetTorrentFile, deleteActiveTorrent,
} = await import("../dist/torrent/webtorrent.js");
const streamClient = clients[1];

after(async () => {
  mock.restoreAll();
  await fs.rm(directory, { recursive: true, force: true });
});

test("unclaimed torrents expire but keep their downloaded files", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const torrent = await getOrAddTorrent("unclaimed");
  assert.equal(streamClient.additions.at(-1).options.destroyStoreOnDestroy, false);
  assert.equal(streamClient.additions.at(-1).options.storeCacheSlots, 3);
  assert.ok(await streamClient.get(torrent.infoHash));

  t.mock.timers.tick(1000);
  await nextTick();
  assert.equal(await streamClient.get(torrent.infoHash), undefined);
});

test("background torrents survive stream closure until the seed period expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const torrent = await getOrAddTorrent("background");
  streamOpened(torrent.infoHash, "video");
  streamOpened(torrent.infoHash, "video");
  streamClosed(torrent.infoHash, "video");
  t.mock.timers.tick(2000);
  await nextTick();
  assert.ok(await streamClient.get(torrent.infoHash));
  assert.equal(getStats().openStreams, 1);

  streamClosed(torrent.infoHash, "video");
  t.mock.timers.tick(999);
  await nextTick();
  assert.ok(await streamClient.get(torrent.infoHash));
  t.mock.timers.tick(1);
  await nextTick();
  assert.equal(await streamClient.get(torrent.infoHash), undefined);
  assert.equal(getStats().openStreams, 0);
});

test("reopening a torrent cancels its pending removal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const torrent = await getOrAddTorrent("reopened");
  streamOpened(torrent.infoHash, "video");
  streamClosed(torrent.infoHash, "video");
  t.mock.timers.tick(500);
  streamOpened(torrent.infoHash, "video");
  t.mock.timers.tick(1000);
  await nextTick();
  assert.ok(await streamClient.get(torrent.infoHash));
  streamClosed(torrent.infoHash, "video");
  t.mock.timers.tick(1000);
  await nextTick();
  assert.equal(await streamClient.get(torrent.infoHash), undefined);
});

test("metadata lookup never selects payload downloads into the memory store", async () => {
  await getTorrentInfoFromWebtorrent("metadata");
  assert.equal(clients[0].additions.at(-1).options.deselect, true);
  assert.equal(clients[0].additions.at(-1).options.storeCacheSlots, 0);
  assert.equal(clients[0].torrents.length, 0);
});

test("auto-seeded torrents use the same cache policy and cancelable lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const info = { name: Buffer.from("seeded"), length: 1, "piece length": 16384, pieces: Buffer.alloc(20) };
  const buffer = Buffer.from(bencode.encode({ info }));
  const hash = createHash("sha1").update(bencode.encode(info)).digest("hex");
  const seedPath = path.join(directory, "seed", "seeded.torrent");
  await fs.mkdir(path.dirname(seedPath), { recursive: true });
  await fs.writeFile(seedPath, buffer);
  const originalAdd = streamClient.add;
  streamClient.add = function (uri, options, callback) {
    const torrent = originalAdd.call(this, uri, options, callback);
    torrent.infoHash = hash;
    return torrent;
  };
  t.after(() => { streamClient.add = originalAdd; });

  await seedDirectory();
  await nextTick();
  assert.equal(streamClient.additions.at(-1).options.storeCacheSlots, 3);
  streamOpened(hash, "seeded");
  t.mock.timers.tick(2000);
  await nextTick();
  assert.ok(await streamClient.get(hash));
  streamClosed(hash, "seeded");
  t.mock.timers.tick(1000);
  await nextTick();
  assert.equal(await streamClient.get(hash), undefined);
});

const configScript = `
  import { STORE_CACHE_SLOTS } from ${JSON.stringify(new URL("../dist/torrent/constats.js", import.meta.url).href)};
  console.log(STORE_CACHE_SLOTS);
`;

test("piece-cache configuration supports the default, overrides, and disabling", () => {
  for (const [value, expected] of [[undefined, 5], ["3", 3], ["0", 0]]) {
    const env = { ...process.env };
    if (value === undefined) delete env.STORE_CACHE_SLOTS;
    else env.STORE_CACHE_SLOTS = value;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", configScript], {
      env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), expected);
  }
});

test("invalid piece-cache configuration fails explicitly at startup", () => {
  for (const value of ["-1", "1.5", "invalid", "", "Infinity", "9007199254740992"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", configScript], {
      env: { ...process.env, STORE_CACHE_SLOTS: value }, encoding: "utf8",
    });

    assert.notEqual(result.status, 0, `Accepted invalid STORE_CACHE_SLOTS=${JSON.stringify(value)}`);
    assert.match(result.stderr, /STORE_CACHE_SLOTS must be a non-negative safe integer/);
  }
});

test("download buffer configuration rejects unsafe or disabling values before startup", () => {
  for (const value of ["-1", "0", "1.5", "invalid", "", "Infinity", "9007199254740992"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", configScript], {
      env: { ...process.env, DOWNLOAD_BUFFER_LIMIT: value }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DOWNLOAD_BUFFER_LIMIT must be a positive safe integer/);
  }
});

test("missing engine patch fails at startup rather than silently leaving downloads unbounded", () => {
  const script = `
    import { mock } from "node:test";
    mock.module("webtorrent", { defaultExport: class {} });
    await import(${JSON.stringify(new URL("../dist/torrent/webtorrent.js", import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], {
    env: { ...process.env }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WebTorrent download-memory patch is missing/);
});

test("kept metadata resumes expired seed entries without fetching the original URL", async (t) => {
  const metadata = Buffer.from("kept-metadata");
  const cached = path.join(directory, "torrents", "cached.torrent");
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, metadata);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Should not refetch"); });
  const seed = await saveOrGetTorrentFile("https://example.invalid/expired", path.join("cached", "movie.mkv"));
  assert.deepEqual(await fs.readFile(seed), metadata);
});

test("incomplete sidecars prevent redirecting to partially materialized files", async () => {
  const { isTorrentStoredLocally } = await import("../dist/utils/torrent.js");
  const movie = path.join("partial-local", "movie.mkv");
  const output = path.join(directory, movie);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, "prefix");
  await fs.writeFile(path.join(directory, "torrents", "partial-local.torrent"), "metadata");
  assert.equal(isTorrentStoredLocally(movie), true);
  await fs.writeFile(`${output}.stremio-incomplete`, "incomplete");
  assert.equal(isTorrentStoredLocally(movie), false);
});

test("manual deletion waits for torrent teardown instead of scheduling it after data removal", async () => {
  const torrent = await getOrAddTorrent("manual-delete");
  const destroy = torrent.destroy;
  let release;
  torrent.destroy = (options, callback) => { release = () => destroy(options, callback); };
  let finished = false;
  const deleting = deleteActiveTorrent("manual-delete").then(() => { finished = true; });
  await nextTick();
  assert.equal(finished, false);
  release();
  await deleting;
  assert.equal(await streamClient.get(torrent.infoHash), undefined);
});

test("storage selection supports forced modes and detects kernel exFAT", () => {
  const moduleURL = JSON.stringify(new URL("../dist/torrent/constats.js", import.meta.url).href);
  for (const [mode, expected] of [["direct", "direct"], ["piece-files", "piece-files"], ["auto", "piece-files"]]) {
    const script = `import fs from "fs-extra";
      Object.defineProperty(process, "platform", { value: "linux" });
      fs.statfsSync = () => ({ type: 0x2011bab0 });
      console.log((await import(${moduleURL})).DISK_STORE_MODE);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, DISK_STORE_MODE: mode }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

test("invalid storage mode fails before startup cleanup touches retained data", async () => {
  const sentinel = path.join(directory, "invalid-mode-sentinel");
  await fs.writeFile(sentinel, "preserve");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", configScript], {
    env: { ...process.env, DISK_STORE_MODE: "invalid", KEEP_DOWNLOADED_FILES: "false" }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DISK_STORE_MODE/);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
});

test("live stats render storage progress, stalled-write warnings and missing-backend diagnostics", async () => {
  const template = await fs.readFile(new URL("../views/stats.ejs", import.meta.url), "utf8");
  const script = [...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((source) => source.includes("function updateStats"));
  assert.ok(script);
  const element = () => ({ children: [], classList: { add() {} }, appendChild(child) { this.children.push(child); } });
  const nodes = new Map();
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    addEventListener() {},
  };
  const context = vm.createContext({ document, console, fetch: () => new Promise(() => {}), setInterval() {} });
  vm.runInContext(script, context);
  const stats = { ...getStats(), diskStoreMode: "piece-files",
    downloadBudget: { ...getStats().downloadBudget, oldestPendingWriteMs: 60000, waitingTorrents: 1 },
    activeTorrents: [{ name: "test", infoHash: "test", files: [], size: 4, pieceLength: 4,
      progress: 1, downloaded: 4, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, peers: 0, openStreams: 0,
      storage: { mode: "piece-files", status: "error", assembledPieces: 1, totalPieces: 2, error: "<broken>" } }],
  };
  context.updateStats(stats);
  assert.equal(nodes.get("diskStoreMode").innerText, "piece-files");
  assert.equal(nodes.get("budget-oldestPendingWrite").innerText, "60 s");
  assert.match(nodes.get("budgetStatus").innerText, /not a file lock/);
  const torrent = nodes.get("torrentsContainer").children[0];
  assert.ok(torrent.children.some((child) => child.textContent?.includes("materialized 1/2 pieces; ERROR: <broken>")));
  assert.ok(!torrent.innerHTML.includes("<broken>"));
  context.updateStats({ ...stats, diskStoreMode: undefined, downloadBudget: undefined, activeTorrents: [] });
  assert.equal(nodes.get("diskStoreMode").innerText, "Backend update required");
  assert.match(nodes.get("budgetStatus").innerText, /deploy the updated backend/);
});

