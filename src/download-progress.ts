/**
 * Aggregated model-download progress (issue #108).
 *
 * transformers.js emits per-file events (`initiate`/`download`/`progress`/`done`)
 * while a model directory streams in. A model is many files, so a per-file bar
 * flickers uselessly — this aggregator folds them into ONE view: percent across
 * every tracked file, smoothed MB/s, and an ETA over the bytes still missing.
 *
 * The "sawPartial" gate implements the warm-cache acceptance criterion: cached
 * loads surface only instant complete-file events, so unless a real partial
 * transfer was observed the aggregator stays silent.
 */

export interface DownloadProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

export interface DownloadSnapshot {
  /** True once a partial transfer was observed — gates ALL output. */
  reportable: boolean;
  /** True when every file with a known total has fully arrived. */
  complete: boolean;
  doneFiles: number;
  activeFiles: number;
  loadedBytes: number;
  totalBytes: number;
  /** 0..100 across files with known totals; null while no total is known yet. */
  percent: number | null;
  mbps: number | null;
  etaSec: number | null;
  currentFile: string | null;
}

interface FileProgress {
  loaded: number;
  total: number; // 0 = unknown
}

const SPEED_SMOOTHING = 0.3; // EMA weight of the newest instantaneous sample

export class DownloadProgressAggregator {
  private files = new Map<string, FileProgress>();
  private sawPartial = false;
  private lastSampleAt = 0;
  private lastSampleBytes = 0;
  private mbpsEma: number | null = null;
  private lastRenderAt = 0;

  update(e: DownloadProgressEvent, nowMs: number = Date.now()): void {
    if (!e || typeof e.file !== 'string' || e.file.length === 0) return;
    let f = this.files.get(e.file);
    if (!f) {
      f = { loaded: 0, total: 0 };
      this.files.set(e.file, f);
    }
    if (typeof e.total === 'number' && Number.isFinite(e.total) && e.total > f.total) {
      f.total = e.total;
    }
    if (typeof e.loaded === 'number' && Number.isFinite(e.loaded) && e.loaded >= 0) {
      // clamp against the known total so a stray event can't overshoot to >100%
      f.loaded = f.total > 0 ? Math.min(e.loaded, f.total) : e.loaded;
    }

    const midTransfer =
      (e.status === 'download' || e.status === 'progress') && f.total > 0 && f.loaded < f.total;
    if (midTransfer) this.sawPartial = true;

    // speed sampling on cumulative byte growth
    const sum = this.sumLoaded();
    if (this.lastSampleAt === 0) {
      this.lastSampleAt = nowMs;
      this.lastSampleBytes = sum;
    } else if (sum > this.lastSampleBytes) {
      const dtSec = (nowMs - this.lastSampleAt) / 1000;
      if (dtSec > 0.05) {
        const inst = (sum - this.lastSampleBytes) / dtSec / (1024 * 1024);
        this.mbpsEma = this.mbpsEma === null ? inst : this.mbpsEma * (1 - SPEED_SMOOTHING) + inst * SPEED_SMOOTHING;
        this.lastSampleAt = nowMs;
        this.lastSampleBytes = sum;
      }
    }
  }

  private sumLoaded(): number {
    let sum = 0;
    for (const f of this.files.values()) sum += f.loaded;
    return sum;
  }

  snapshot(): DownloadSnapshot {
    let loadedBytes = 0;
    let totalBytes = 0;
    let doneFiles = 0;
    let activeFiles = 0;
    for (const f of this.files.values()) {
      loadedBytes += f.loaded;
      if (f.total > 0) {
        totalBytes += f.total;
        if (f.loaded >= f.total) doneFiles += 1;
        else activeFiles += 1;
      }
    }
    const percent = totalBytes > 0 ? Math.min(100, (loadedBytes / totalBytes) * 100) : null;
    const remaining = totalBytes - loadedBytes;
    const etaSec =
      this.mbpsEma !== null && this.mbpsEma > 0 && remaining > 0 ? remaining / (1024 * 1024) / this.mbpsEma : null;
    return {
      reportable: this.sawPartial,
      complete: totalBytes > 0 && activeFiles === 0,
      doneFiles,
      activeFiles,
      loadedBytes,
      totalBytes,
      percent,
      mbps: this.sawPartial ? this.mbpsEma : null,
      etaSec: this.sawPartial ? etaSec : null,
      currentFile: [...this.files.entries()].find(([, f]) => f.total === 0 || f.loaded < f.total)?.[0] ?? null,
    };
  }

  /**
   * Render throttle for live views: pass through at most one line per
   * interval, plus ALWAYS the transition into `complete`.
   */
  shouldRender(nowMs: number, minIntervalMs = 400): boolean {
    if (!this.sawPartial) return false;
    const justCompleted = this.snapshot().complete && !this.renderedComplete;
    if (justCompleted) {
      this.renderedComplete = true;
      this.lastRenderAt = nowMs;
      return true;
    }
    if (nowMs - this.lastRenderAt >= minIntervalMs) {
      this.lastRenderAt = nowMs;
      return true;
    }
    return false;
  }

  private renderedComplete = false;
}
