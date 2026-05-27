import fs from "fs-extra";
import MemoryStore from "memory-chunk-store";
import path from "path";
import WebTorrent, { Torrent } from "webtorrent";
import { getReadableDuration } from "../utils/file.js";
import { getTorrentHash } from "../utils/torrent.js";
import {
  DOWNLOAD_DIR,
  TORRENT_FILE_DIR,
  SEED_DIR,
  AUTO_SEED,
  KEEP_DOWNLOADED_FILES,
  KEEP_TORRENT_FILES,
  MAX_CONNS_PER_TORRENT,
  DOWNLOAD_SPEED_LIMIT,
  UPLOAD_SPEED_LIMIT,
  SEED_TIME,
  TORRENT_TIMEOUT,
  ENABLE_DHT,
  ENABLE_UTP,
  ENABLE_NAT_PMP,
  ENABLE_NAT_UPNP,
  INFO_CLIENT_PORT,
  STREAM_CLIENT_PORT
} from "./constats.js";

interface FileInfo {
  name: string;
  path: string;
  size: number;
  url?: string;
}

interface ActiveFileInfo extends FileInfo {
  progress: number;
  downloaded: number;
}

export interface TorrentInfo {
  name: string;
  infoHash: string;
  size: number;
  files: FileInfo[];
}

interface ActiveTorrentInfo extends TorrentInfo {
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  openStreams: number;
  files: ActiveFileInfo[];
}

const infoClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
  dht: ENABLE_DHT,
  utp: ENABLE_UTP,
  natUpnp: ENABLE_NAT_UPNP,
  natPmp: ENABLE_NAT_PMP,
  // @ts-ignore
  torrentPort: INFO_CLIENT_PORT
});
const streamClient = new WebTorrent({
  // @ts-ignore
  downloadLimit: DOWNLOAD_SPEED_LIMIT,
  uploadLimit: UPLOAD_SPEED_LIMIT,
  maxConns: MAX_CONNS_PER_TORRENT,
  dht: ENABLE_DHT,
  utp: ENABLE_UTP,
  natUpnp: ENABLE_NAT_UPNP,
  natPmp: ENABLE_NAT_PMP,
  // @ts-ignore
  torrentPort: STREAM_CLIENT_PORT
});

streamClient.on("torrent", (torrent) => {
  console.log(`Added torrent: ${torrent.name}`);
});

streamClient.on("error", (error) => {
  if (typeof error === "string") {
    console.error(`Error: ${error}`);
  } else {
    if (error.message.startsWith("Cannot add duplicate torrent")) return;
    console.error(`Error: ${error.message}`);
  }
});

infoClient.on("error", () => {});

const launchTime = Date.now();

export const getStats = () => ({
  uptime: getReadableDuration(Date.now() - launchTime),
  openStreams: [...openStreams.values()].reduce((a, b) => a + b, 0),
  downloadSpeed: streamClient.downloadSpeed,
  uploadSpeed: streamClient.uploadSpeed,
  activeTorrents: streamClient.torrents.map<ActiveTorrentInfo>((torrent) => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    peers: torrent.numPeers,
    openStreams: openStreams.get(torrent.infoHash) || 0,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
      progress: file.progress,
      downloaded: file.downloaded,
    })),
  })),
});

export const getOrAddTorrent = (uri: string, infoHash: string = "") =>
  new Promise<Torrent | undefined>(async (resolve) => {
    const existingTorrent = await streamClient.get(infoHash);
    if (existingTorrent) {
      console.log(`Torrent already exists: ${infoHash}, using it for stream.`);
      resolve(existingTorrent);
      return;
    }

    const options = {
      path: DOWNLOAD_DIR,
      destroyStoreOnDestroy: !KEEP_DOWNLOADED_FILES,
    };

    if (!KEEP_DOWNLOADED_FILES) {
      options["deselect"] = true;
    }

    console.log(`Torrent doesn't exists: ${infoHash}, adding ${uri}`);
    const torrent = streamClient.add(uri, options, (torrent) => {
      clearTimeout(timeout);
      resolve(torrent);
    });

    const timeout = setTimeout(() => {
      console.log(`Failed to add torrent: ${uri}`);
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });

export const getFile = (torrent: Torrent, path: string) =>
  torrent.files.find((file) => file.path === path);

export const getTorrentInfoFromWebtorrent = async (uri: string) => {
  const getInfo = (torrent: Torrent): TorrentInfo => ({
    name: torrent.name,
    infoHash: torrent.infoHash,
    size: torrent.length,
    files: torrent.files.map((file) => ({
      name: file.name,
      path: file.path,
      size: file.length,
    })),
  });

  return await new Promise<TorrentInfo | undefined>((resolve) => {
    const torrent = infoClient.add(
      uri,
      { store: MemoryStore, destroyStoreOnDestroy: true },
      (torrent) => {
        clearTimeout(timeout);
        const info = getInfo(torrent);
        console.log(`Fetched info: ${info.name}`);
        torrent.destroy();
        resolve(info);
      }
    );

    const timeout = setTimeout(() => {
      torrent.destroy();
      resolve(undefined);
    }, TORRENT_TIMEOUT);
  });
};

const timeouts = new Map<string, NodeJS.Timeout>();
const openStreams = new Map<string, number>();

export const streamOpened = (hash: string, fileName: string) => {
  console.log(`Stream opened: ${fileName}`);

  const count = openStreams.get(hash) || 0;
  openStreams.set(hash, count + 1);

  const timeout = timeouts.get(hash);

  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }
};

export const streamClosed = (hash: string, fileName: string) => {
  console.log(`Stream closed: ${fileName}`);

  const count = openStreams.get(hash) || 1;
  openStreams.set(hash, count - 1);

  if (count > 1) return;

  openStreams.delete(hash);

  let timeout = timeouts.get(hash);
  if (timeout) return;

  timeout = setTimeout(() => handleTorrentTimeout(hash), SEED_TIME);

  timeouts.set(hash, timeout);
};

const handleTorrentTimeout = async (hash: string) => {
  const torrent = await streamClient.get(hash);

  // @ts-ignore
  torrent?.destroy(undefined, async () => {
    console.log(`Removed torrent: ${torrent.name}`);

    timeouts.delete(torrent.infoHash);
    const seedPath = path.join(SEED_DIR, `${torrent.name}.torrent`);

    try {
      await fs.remove(seedPath);
      console.log(`Deleted seed file: ${torrent.name}.torrent`);
    } catch (error) {
      console.error(
        `Failed to delete seed file: ${torrent.name}, error: ${error.message}`
      );
    }
  });
};

export const saveOrGetTorrentFile = async (uri: string, filePath: string) => {
  const rootFolder = path.normalize(filePath).split(path.sep)[0];
  const torrentFilename = `${rootFolder}.torrent`;
  const seedPath = path.join(SEED_DIR, torrentFilename);

  if (fs.existsSync(seedPath)) {
    return seedPath;
  }

  const torrentBuffer = await fetch(uri).then((res) => res.arrayBuffer());

  if (!fs.existsSync(seedPath)) {
    await fs.outputFile(seedPath, Buffer.from(torrentBuffer));
  }

  if (KEEP_TORRENT_FILES) {
    const torrentPath = path.join(TORRENT_FILE_DIR, torrentFilename);
    if (!fs.existsSync(torrentPath)) await fs.copy(seedPath, torrentPath);
  }

  return seedPath;
};

export const seedDirectory = async () => {
  if (!fs.existsSync(SEED_DIR)) {
    console.log(
      "No files too auto seed, or seed directory does not exist at path:",
      SEED_DIR
    );
    return;
  }

  const files = await fs.readdir(SEED_DIR);

  for (const file of files) {
    const filePath = path.join(SEED_DIR, file);
    const fileBuffer = await fs.readFile(filePath);
    const hash = await getTorrentHash(fileBuffer.buffer);

    let timeout = timeouts.get(hash);
    if (timeout) return;

    if (path.extname(filePath) === ".torrent") {
      console.log(`Initializing torrent for seeding: ${file}`)
      streamClient.add(filePath, { path: DOWNLOAD_DIR }, (_) => {
        console.log(`Seeding torrent: ${file}`);
        timeout = setTimeout(() => handleTorrentTimeout(hash), SEED_TIME);
      });
    }

    timeouts.set(hash, timeout);
  }
};

export async function deleteActiveTorrent(folderName: string, retries = 10): Promise<void> {
  console.log(`Trying to manually delete: ${folderName}.torrent`);
  const torrent = streamClient.torrents.find(t => t.name === folderName);
  if (!torrent) return;

  const hash = torrent.infoHash;

  const count = openStreams.get(hash) || 1;
  openStreams.set(hash, count - 1);

  if (count > 1) {
    if (retries > 0) {
      console.log(`Streams still open for ${folderName}, retrying deletion in 5s... (${retries} retries left)`);
      setTimeout(() => deleteActiveTorrent(folderName, retries - 1), 5000);
    } else {
      console.log(`Max retries reached, skipping deletion for ${folderName}`);
    }
    return;
  }

  openStreams.delete(hash);

  let timeout = timeouts.get(hash);
  if (timeout) {
    clearTimeout(timeout);
    timeouts.delete(hash);
  }

  timeout = setTimeout(async () => {
    await handleTorrentTimeout(hash);

    const torrentFilePath = path.join(TORRENT_FILE_DIR, `${folderName}.torrent`);
    if (fs.existsSync(torrentFilePath)) {
      try {
        await fs.remove(torrentFilePath);
        console.log(`Deleted torrent file: ${folderName}.torrent`);
      } catch (error: any) {
        console.error(`Failed to delete torrent file: ${folderName}, error: ${error.message}`);
      }
    }

    timeouts.delete(hash);
  }, 1000);

  timeouts.set(hash, timeout);
}

//Starts the seeding process if AUTO_SEED is true
if (AUTO_SEED) {
  seedDirectory().catch((error) => {
    console.error(`Failed to auto seed torrents: ${error.message}`);
  });
}