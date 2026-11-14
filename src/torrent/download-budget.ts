interface BudgetPiece {
  length: number;
  missing: number;
}

interface BudgetTorrent {
  destroyed: boolean;
  done: boolean;
  _update(): void;
  _hasPieceRequests(index: number): boolean;
  _isPieceSelected(index: number): boolean;
  _discardPartial(index: number, piece: BudgetPiece): void;
}

type Phase = "partial" | "hashing" | "writing";
interface Entry {
  torrent: BudgetTorrent;
  index: number;
  piece: BudgetPiece;
  cost: number;
  phase: Phase;
  updatedAt: number;
}

export class DownloadBudget {
  attachedClients = 0;
  private entries = new Map<BudgetPiece, Entry>();
  private waiters = new Set<BudgetTorrent>();
  private reservedBytes = 0;
  private discardedPartialPieces = 0;
  private wakeScheduled = false;
  private timer?: NodeJS.Timeout;

  constructor(readonly limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error("Download buffer limit must be a positive safe integer");
    }
  }

  attach() {
    this.attachedClients++;
  }

  reserve(torrent: BudgetTorrent, index: number, piece: BudgetPiece): boolean {
    const existing = this.entries.get(piece);
    if (existing) return existing.phase === "partial";
    // Block assembly and hashing can briefly hold both blocks and a full-piece copy.
    const cost = 2 * piece.length;
    if (this.reservedBytes + cost > this.limitBytes) this.reclaim();
    if (this.entries.size && this.reservedBytes + cost > this.limitBytes) {
      this.waiters.add(torrent);
      this.armTimer();
      return false;
    }
    this.entries.set(piece, { torrent, index, piece, cost, phase: "partial", updatedAt: Date.now() });
    this.reservedBytes += cost;
    this.waiters.delete(torrent);
    return true;
  }

  progress(piece: BudgetPiece) {
    const entry = this.entries.get(piece);
    if (entry) entry.updatedAt = Date.now();
  }

  setPhase(piece: BudgetPiece, phase: Phase) {
    const entry = this.entries.get(piece);
    if (entry) {
      entry.phase = phase;
      entry.updatedAt = Date.now();
    }
  }

  release(piece: BudgetPiece) {
    const entry = this.entries.get(piece);
    if (!entry) return;
    this.entries.delete(piece);
    this.reservedBytes -= entry.cost;
    this.scheduleWake();
  }

  cancelTorrent(torrent: BudgetTorrent) {
    this.waiters.delete(torrent);
    for (const entry of this.entries.values()) {
      if (entry.torrent !== torrent || entry.phase !== "partial") continue;
      torrent._discardPartial(entry.index, entry.piece);
      this.release(entry.piece);
    }
    // Hashes and disk writes still own their buffers until their callbacks finish.
  }

  partialIndexes(torrent: BudgetTorrent): number[] {
    return [...this.entries.values()]
      .filter((entry) => entry.torrent === torrent && entry.phase === "partial")
      .map((entry) => entry.index);
  }

  getStats() {
    let partialBytes = 0;
    let hashingBytes = 0;
    let pendingWriteBytes = 0;
    let oldestPendingWriteMs = 0;
    let effectiveLimitBytes = this.limitBytes;
    for (const entry of this.entries.values()) {
      effectiveLimitBytes = Math.max(effectiveLimitBytes, entry.cost);
      if (entry.phase === "partial") partialBytes += entry.piece.length - entry.piece.missing;
      if (entry.phase === "hashing") hashingBytes += entry.piece.length;
      if (entry.phase === "writing") {
        pendingWriteBytes += entry.piece.length;
        oldestPendingWriteMs = Math.max(oldestPendingWriteMs, Date.now() - entry.updatedAt);
      }
    }
    return {
      limitBytes: this.limitBytes,
      effectiveLimitBytes,
      reservedBytes: this.reservedBytes,
      partialBytes,
      hashingBytes,
      pendingWriteBytes,
      oldestPendingWriteMs,
      activePieces: this.entries.size,
      waitingTorrents: [...this.waiters].filter((torrent) => !torrent.destroyed && !torrent.done).length,
      discardedPartialPieces: this.discardedPartialPieces,
    };
  }

  private reclaim() {
    for (const entry of this.entries.values()) {
      if (entry.phase !== "partial" || entry.torrent._hasPieceRequests(entry.index)) continue;
      if (entry.torrent._isPieceSelected(entry.index) && Date.now() - entry.updatedAt < 30000) continue;
      entry.torrent._discardPartial(entry.index, entry.piece);
      this.discardedPartialPieces++;
      this.release(entry.piece);
    }
  }

  private scheduleWake() {
    if (this.wakeScheduled) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      for (const torrent of [...this.waiters]) {
        if (torrent.destroyed || torrent.done) this.waiters.delete(torrent);
        else torrent._update();
      }
      if (!this.waiters.size && this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    });
  }

  private armTimer() {
    if (this.timer || ![...this.entries.values()].some((entry) => entry.phase === "partial")) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reclaim();
      this.scheduleWake();
      if (this.waiters.size) this.armTimer();
    }, 30000);
    this.timer.unref();
  }
}
