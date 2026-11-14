import { Router } from "express";
import { searchTorrents } from "./torrent/search.js";
import {
  getFile,
  getOrAddTorrent,
  getStats,
  getTorrentInfoFromWebtorrent,
  streamClosed,
  streamOpened,
  saveOrGetTorrentFile,
} from "./torrent/webtorrent.js";
import { getStreamingMimeType } from "./utils/file.js";

export const router = Router();

router.get("/stats", (req, res) => {
  const stats = getStats();
  res.json(stats);
});

router.get("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const torrents = await searchTorrents(query);
  res.json(torrents);
});

router.post("/torrents/:query", async (req, res) => {
  const { query } = req.params;
  const options = req.body;
  const torrents = await searchTorrents(query, options);
  res.json(torrents);
});

router.get("/torrent/:torrentUri", async (req, res) => {
  const { torrentUri } = req.params;

  const torrent = await getTorrentInfoFromWebtorrent(torrentUri);
  if (!torrent) return res.status(500).send("Failed to get torrent");

  torrent.files.forEach((file) => {
    file.url = [
      `${req.protocol}://${req.get("host")}`,
      "stream",
      encodeURIComponent(torrentUri),
      encodeURIComponent(file.path),
    ].join("/");
  });

  res.json(torrent);
});

router.get("/stream/:torrentUri/:filePath", async (req, res) => {
  const { torrentUri, filePath } = req.params;

  const uri = torrentUri.startsWith("magnet")
    ? torrentUri
    : await saveOrGetTorrentFile(torrentUri, filePath);

  const torrent = await getOrAddTorrent(uri);
  if (!torrent) return res.status(500).send("Failed to add torrent");

  if (req.aborted || res.destroyed) return;

  const file = getFile(torrent, filePath);
  if (!file) return res.status(404).send("File not found");

  const { range } = req.headers;
  const positions = (range || "").replace(/bytes=/, "").split("-");
  const start = Number(positions[0]);
  const end = Number(positions[1]) || file.length - 1;

  if (start >= file.length || end >= file.length) {
    res.writeHead(416, {
      "Content-Range": `bytes */${file.length}`,
    });
    return res.end();
  }

  const headers = {
    "Content-Range": `bytes ${start}-${end}/${file.length}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": getStreamingMimeType(file.name),
  };

  res.writeHead(206, headers);

  try {
    file.select();
    const videoStream = file.createReadStream({ start, end });

    const noDataTimeout = setTimeout(() => {
      res.destroy();
    }, 10000);

    const noReadTimeout = setTimeout(() => {
      res.destroy();
    }, 60000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(noDataTimeout);
      clearTimeout(noReadTimeout);
      res.removeListener("close", cleanup);
      res.removeListener("finish", cleanup);
      videoStream.unpipe(res);
      videoStream.destroy();
      streamClosed(torrent.infoHash, file.name);
    };

    videoStream.on("data", () => {
      clearTimeout(noDataTimeout);
      noReadTimeout.refresh();
    });

    videoStream.once("error", () => {
      cleanup();
      res.destroy();
    });

    streamOpened(torrent.infoHash, file.name);
    res.once("close", cleanup);
    res.once("finish", cleanup);

    videoStream.pipe(res);
  } catch (error) {
    res.destroy();
  }
});
