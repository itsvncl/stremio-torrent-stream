import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { default: WebConn } = await import(new URL("./lib/webconn.js", pathToFileURL(require.resolve("webtorrent"))));

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function connectionFor(t, url, files = [{ length: 1024 * 1024, offset: 0 }]) {
  const connection = new WebConn(url, { pieceLength: 65536, files });
  t.after(() => connection.destroy());
  return connection;
}

function read(connection, index = 0, length = 65536) {
  return new Promise((resolve, reject) => {
    connection.httpRequest(index, 0, length, (error, data) => error ? reject(error) : resolve(data));
  });
}

test("web seeds reject a whole-file response instead of allocating it for one piece", async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(200, { "Content-Length": 1024 * 1024 * 1024 });
    response.flushHeaders();
  });
  await assert.rejects(read(connectionFor(t, url)), /exceeds requested 65536 bytes/);
});

test("chunked oversized and short web seed bodies fail explicitly", async (t) => {
  const url = await serverFor(t, (request, response) => {
    response.writeHead(206);
    response.end(Buffer.alloc(request.url === "/large" ? 131072 : 1024, 7));
  });
  await assert.rejects(read(connectionFor(t, `${url}/large`)), /exceeds requested/);
  await assert.rejects(read(connectionFor(t, `${url}/short`)), /ended early/);
});

test("valid ranges work across three files, including a middle-file boundary", async (t) => {
  const files = ["abc", "def", "ghi"];
  const url = await serverFor(t, (request, response) => {
    assert.equal(request.headers.range, "bytes=0-2");
    const index = Number(request.url.slice(1));
    response.writeHead(206);
    response.end(files[index]);
  });
  const connection = connectionFor(t, url, files.map((data, index) => ({
    offset: index * 3, length: data.length, path: `${index}`,
  })));
  const data = await read(connection, 0, 9);
  assert.equal(Buffer.from(data).toString(), "abcdefghi");
});

test("destroying a web seed aborts active HTTP reads rather than retaining them until timeout", async (t) => {
  let headersSent;
  const headers = new Promise((resolve) => { headersSent = resolve; });
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(206);
    response.flushHeaders();
    headersSent();
  });
  const connection = connectionFor(t, url);
  const rejected = assert.rejects(read(connection), /abort/i);
  await headers;
  connection.destroy();
  await rejected;
  assert.equal(connection._httpRequests.size, 0);
});
