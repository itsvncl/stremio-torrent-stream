import { TorrentInfo } from "../torrent/webtorrent.js";
import { createHash } from "crypto";
import { TORRENT_FILE_DIR, SEED_DIR, DOWNLOAD_DIR } from "../torrent/constats.js";
import fs, { pathExists } from "fs-extra";
import bencode from "bencode";
import path from "path";

export const getTorrentInfoFromTorrentFile = async (
  torrentBuffer: ArrayBuffer
): Promise<TorrentInfo | undefined> => {
  const metadata = bencode.decode(Buffer.from(torrentBuffer));
  const textDecoder = new TextDecoder("utf-8");

  let totalSize = 0;
  const files = metadata.info.files.map(
    (file: { path: Uint8Array[]; length: number }) => {
      totalSize += file.length;
      return {
        path: file.path.map((segment) => textDecoder.decode(segment)),
        length: file.length,
      };
    }
  );
  const torrentName = textDecoder.decode(metadata.info.name);
  const infoHash = createHash("sha1")
    .update(bencode.encode(metadata.info))
    .digest("hex");

  console.log(`Got info from torrent file: ${torrentName}`);
  return {
    name: torrentName,
    infoHash: infoHash,
    size: totalSize,
    files: files.map((file) => ({
      name: file.path.at(-1),
      path: path.join(torrentName, file.path.join(path.sep)),
      size: file.length,
    })),
  };
};

export const getTorrentHash = async (
  torrentBuffer: ArrayBufferLike
): Promise<string | undefined> => {
  const metadata = bencode.decode(torrentBuffer);
  const infoHash = createHash("sha1")
    .update(bencode.encode(metadata.info))
    .digest("hex");
  return infoHash;
};

export const torrentFileExists = (fileName: string): boolean => {
  const filePath = path.join(TORRENT_FILE_DIR, fileName + ".torrent");
  try {
    return fs.pathExistsSync(filePath);
  } catch (error) {
    console.error(`Error checking if file exists: ${error.message}`);
    return false;
  }
};

export const isTorrentStoredLocally = (filePath: string) => {
  const rootFolder = path.normalize(filePath).split(path.sep)[0];
  const torrentFilename = `${rootFolder}.torrent`;
  
  const seedPath = path.join(SEED_DIR, torrentFilename);
  const torrentPath = path.join(TORRENT_FILE_DIR, torrentFilename);

  return !fs.existsSync(seedPath) && fs.existsSync(torrentPath) && fs.existsSync(path.join(DOWNLOAD_DIR, filePath));
}
