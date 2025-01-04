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
import { isTorrentStoredLocally } from "./utils/torrent.js";
import { getStreamingMimeType } from "./utils/file.js";
import { DOWNLOAD_DIR, KEEP_DOWNLOADED_FILES, KEEP_TORRENT_FILES } from "./torrent/constats.js";
import fs from "fs-extra";
import path from "path";

export const router = Router();

router.get("/stats", (_, res) => {
  res.render("stats");
});

router.get("/data/stats", (_, res) => {
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

//Deprecated
router.get("/stream/:infoHash/:torrentUri/:filePath/", async (req, res) => {
  const { infoHash, torrentUri, filePath } = req.params;

  if(KEEP_DOWNLOADED_FILES && KEEP_TORRENT_FILES && isTorrentStoredLocally(filePath)) {
    console.log(`Torrent is stored locally, redirecting to file stream: ${filePath}`);
    res.redirect(301, `/file-stream/${encodeURIComponent(path.join(DOWNLOAD_DIR, filePath))}`);
    return;
  }

  console.log(`Torrent is not stored locally, redirecting to torrent stream: ${torrentUri}/${filePath}`);
  res.redirect(301, `/torrent-stream/${encodeURIComponent(infoHash)}/${encodeURIComponent(torrentUri)}/${encodeURIComponent(filePath)}`);
});

router.get("/torrent-stream/:infoHash/:torrentUri/:filePath", async (req, res) => {
  const { infoHash, torrentUri, filePath } = req.params;

  const uri = torrentUri.startsWith("magnet")
  ? torrentUri
  : await saveOrGetTorrentFile(torrentUri, filePath);

  const torrent = await getOrAddTorrent(uri, infoHash);
  if (!torrent) return res.status(500).send("Failed to add torrent");

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
    const noDataTimeout = setTimeout(() => {
      res.status(500).end();
    }, 10000);

    const noReadTimeout = setTimeout(() => {
      res.status(200).end();
    }, 60000);

    const videoStream = file.createReadStream({ start, end });

    videoStream.on("data", () => {
      clearTimeout(noDataTimeout);
    });

    videoStream.on("readable", () => {
      noReadTimeout.refresh();
    });

    videoStream.on("error", (error) => {});

    videoStream.pipe(res);

    streamOpened(torrent.infoHash, file.name);

    res.on("close", () => {
      streamClosed(torrent.infoHash, file.name);
    });
  } catch (error) {
    res.status(500).end();
  }
});

router.get("/file-stream/:filePath", async (req, res) => {
  const { filePath } = req.params;
  const fullPath = decodeURIComponent(filePath);
  
  console.log(`Streaming file: ${fullPath}`);

  if (!fs.existsSync(fullPath)) {
    console.log(`File not found: ${fullPath}`);
    return res.status(404).send("File not found");
  }

  const { range } = req.headers;
  const stats = fs.statSync(fullPath);
  const fileSize = stats.size;

  if (range) {
    const positions = range.replace(/bytes=/, "").split("-");
    const start = parseInt(positions[0], 10);
    const end = positions[1] ? parseInt(positions[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.writeHead(416, {
        "Content-Range": `bytes */${fileSize}`,
      });
      return res.end();
    }

    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(fullPath, { start, end });

    const headers = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": getStreamingMimeType(fullPath),
    };

    res.writeHead(206, headers);
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": getStreamingMimeType(fullPath),
    });
    fs.createReadStream(fullPath).pipe(res);
  }
});
