import path from "path";
import os from "os";
import fs from "fs-extra";

// Directory to store downloaded files (default OS temp directory)
export const DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "torrent-stream-server");

// Directory to store torrent files (default DOWNLOAD_DIR/torrents)
export const TORRENT_FILE_DIR =
  process.env.TORRENT_FILE_DIR || path.join(DOWNLOAD_DIR, "torrents");

// Directory to store torrent files that didn't complete their seed period (default DOWNLOAD_DIR/seed)
export const SEED_DIR = process.env.SEED_DIR || path.join(DOWNLOAD_DIR, "seed");

// Enables automatic seeding of torrents that were left in the SEED_DIR (default false)
// A torrent file stay in the SEED_DIR if the SEED_TIME has not passed, I recommend keeping this enabled
export const AUTO_SEED = process.env.AUTO_SEED
  ? process.env.AUTO_SEED === "true"
  : false;

// Keep downloaded files after all streams are closed (default false)
export const KEEP_DOWNLOADED_FILES = process.env.KEEP_DOWNLOADED_FILES
  ? process.env.KEEP_DOWNLOADED_FILES === "true"
  : false;

// Keep torrent files (default false)
export const KEEP_TORRENT_FILES = process.env.KEEP_TORRENT_FILES
  ? process.env.KEEP_TORRENT_FILES === "true"
  : false;

if (!KEEP_DOWNLOADED_FILES) fs.emptyDirSync(DOWNLOAD_DIR);

// Maximum number of connections per torrent (default 50)
export const MAX_CONNS_PER_TORRENT =
  Number(process.env.MAX_CONNS_PER_TORRENT) || 50;

// Enable dht (default false)
export const ENABLE_DHT = process.env.ENABLE_DHT
  ? process.env.ENABLE_DHT === "true"
  : false;

// Enable uTP (default true)
export const ENABLE_UTP = process.env.ENABLE_UTP
  ? process.env.ENABLE_UTP === "true"
  : true;

// Enable NAT-PMP (default true)
export const ENABLE_NAT_PMP = process.env.ENABLE_NAT_PMP
  ? process.env.ENABLE_NAT_PMP === "true"
  : true;

// Enable NAT-UPnP (default true)
export const ENABLE_NAT_UPNP = process.env.ENABLE_NAT_UPNP
  ? process.env.ENABLE_NAT_UPNP === "true"
  : true;

// Info client port (default NULL)
export const INFO_CLIENT_PORT = process.env.INFO_CLIENT_PORT
  ? Number(process.env.INFO_CLIENT_PORT)
  : null;

// Stream client port (default NULL)
export const STREAM_CLIENT_PORT = process.env.STREAM_CLIENT_PORT
  ? Number(process.env.STREAM_CLIENT_PORT)
  : null;

// Max download speed (bytes/s) over all torrents (default 20MB/s)
export const DOWNLOAD_SPEED_LIMIT =
  Number(process.env.DOWNLOAD_SPEED_LIMIT) || 20 * 1024 * 1024;

// Max upload speed (bytes/s) over all torrents (default 1MB/s)
export const UPLOAD_SPEED_LIMIT =
  Number(process.env.UPLOAD_SPEED_LIMIT) || 1 * 1024 * 1024;

// Time (ms) to seed torrents after all streams are closed (default 1 minute)
export const SEED_TIME = Number(process.env.SEED_TIME) || 60 * 1000;

// Timeout (ms) when adding torrents if no metadata is received (default 5 seconds)
export const TORRENT_TIMEOUT = Number(process.env.TORRENT_TIMEOUT) || 5 * 1000;

export const MANAGE_PASSWORD = process.env.MANAGE_PASSWORD || "doit";
