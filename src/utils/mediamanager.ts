import fs from "fs-extra";
import path from "path";
import { DOWNLOAD_DIR, SEED_DIR, TORRENT_FILE_DIR } from "../torrent/constats.js";
import { deleteActiveTorrent } from "../torrent/webtorrent.js";

export interface DiskStats {
  mountPoint: string;
  totalGB: number;
  usedGB: number;
  freeGB: number;
  usagePercent: number;
}

export function getDiskCapacity(mountPath: string = DOWNLOAD_DIR): DiskStats {
  try {
    const stats = fs.statfsSync(mountPath);

    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    const used = total - free;

    return {
      mountPoint: mountPath,
      totalGB: +(total / 1024 ** 3).toFixed(2),
      usedGB: +(used / 1024 ** 3).toFixed(2),
      freeGB: +(free / 1024 ** 3).toFixed(2),
      usagePercent: +((used / total) * 100).toFixed(2),
    };
  } catch (err: any) {
    throw new Error(`Failed to get disk capacity for ${mountPath}: ${err.message}`);
  }
}

export interface FolderInfo {
  name: string;
  sizeGB: number;
}

// Folders to exclude from listing/deletion
const EXCLUDE_FOLDERS = [TORRENT_FILE_DIR, SEED_DIR];

export function listFolders(rootPath: string = DOWNLOAD_DIR): FolderInfo[] {
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Root path not found: ${rootPath}`);
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const folders: FolderInfo[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const folderPath = path.join(rootPath, entry.name);

      // Skip if full path is in excluded list
      if (EXCLUDE_FOLDERS.includes(folderPath)) continue;

      const sizeBytes = getFolderSizeBytes(folderPath);

      folders.push({
        name: entry.name,
        sizeGB: +(sizeBytes / 1024 ** 3).toFixed(2),
      });
    }
  }

  return folders;
}

// Delete a folder by name and also remove corresponding .torrent file
export function deleteFolder(folderName: string, rootPath: string = DOWNLOAD_DIR): void {
  const folderPath = path.join(rootPath, folderName);
  deleteActiveTorrent(folderName);
  if (EXCLUDE_FOLDERS.includes(folderPath)) {
    throw new Error(`Cannot delete protected folder: ${folderName}`);
  }

  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder not found: ${folderName}`);
  }

  // Delete folder
  fs.removeSync(folderPath);

  // Also delete corresponding torrent file if exists
  const torrentFilePath = path.join(TORRENT_FILE_DIR, `${folderName}.torrent`);
  if (fs.existsSync(torrentFilePath)) {
    fs.removeSync(torrentFilePath);
  }

  // Also delete corresponding seed file if exists
  const seedTorrentFile = path.join(SEED_DIR, `${folderName}.torrent`);
  if (fs.existsSync(seedTorrentFile)) {
    fs.removeSync(seedTorrentFile);
  }
}

function getFolderSizeBytes(folderPath: string): number {
  let total = 0;

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const stats = fs.statSync(fullPath);

    if (entry.isDirectory()) {
      total += getFolderSizeBytes(fullPath); // recurse into subdir
    } else {
      total += stats.size; // file size in bytes
    }
  }

  return total;
}
