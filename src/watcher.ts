/**
 * OS-Native File Watcher with Zero-Polling Kernel Events (issue #100).
 *
 * Utilizes OS kernel events (ReadDirectoryChangesW on Windows, FSEvents on macOS, inotify on Linux)
 * via recursive `fs.watch`, with automatic debounce coalescing and graceful fallback to interval polling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './core.js';

export interface WatcherOptions {
  debounceMs?: number;
  ignore?: string[];
  log?: (msg: string) => void;
  fallbackIntervalMs?: number;
  /** issue #236 test hook: hands the raw native FSWatcher to the caller so tests can emit error/close. */
  _testHooks?: { onWatcher?: (watcher: fs.FSWatcher) => void };
}

export interface FileWatcher {
  close: () => void;
  isNative: boolean;
}

// ---------------------------------------------------------------------------
// FS error classification + bounded retry (issue #116): Windows AV / OneDrive
// / atomic-save editors produce EBUSY/EPERM bursts that previously became
// silent 'unreadable' fingerprints and missed updates.
// ---------------------------------------------------------------------------

const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);

export type FsErrorClass = 'transient' | 'vanished' | 'permanent';

/** Bucket a filesystem failure so callers can retry, skip, or warn. */
export function classifyFsError(err: unknown): FsErrorClass {
  const e = err as { code?: string; message?: string } | null | undefined;
  if (!e) return 'permanent';
  if (e.code === 'ENOENT') return 'vanished';
  if (e.code && TRANSIENT_CODES.has(e.code)) return 'transient';
  if (/temporarily unavailable|being written|locked by another process/i.test(String(e.message || ''))) {
    return 'transient';
  }
  return 'permanent';
}

/** Retry `fn` while its failures classify as transient; capped exponential backoff. */
export async function readWithRetry<T>(
  fn: () => T,
  opts: { attempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {}
): Promise<{ ok: true; value: T } | { ok: false; err: unknown; cls: FsErrorClass }> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      lastErr = err;
      const cls = classifyFsError(err);
      if (cls !== 'transient' || attempt === attempts) {
        return { ok: false, err, cls };
      }
      opts.onRetry?.(attempt, err);
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt)); // 200ms, 400ms — capped
    }
  }
  return { ok: false, err: lastErr, cls: classifyFsError(lastErr) };
}

export function createFileWatcher(
  dbPath: string,
  onChange: () => void | Promise<void>,
  options: WatcherOptions = {}
): FileWatcher {
  const {
    debounceMs = 250,
    ignore = [],
    log = () => {},
    // issue #195: 50 ms meant 20 full tree walks per second whenever native
    // events were unavailable — a full-directory stat storm on big vaults.
    // 1 s is still responsive (native events handle the snappy case) while
    // cutting the background budget by 20x.
    fallbackIntervalMs = 1000,
    _testHooks,
  } = options;

  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const ignoreRegexes = [
    /\.mdss($|[\\/])/,
    /\.git($|[\\/])/,
    /\.cache($|[\\/])/,
    ...ignore.map((g) => globToRegExp(g)),
  ];

  const shouldIgnore = (filename: string | null | undefined): boolean => {
    if (!filename) return false;
    const normalized = filename.split(path.sep).join('/');
    for (const re of ignoreRegexes) {
      if (re.test(normalized)) return true;
    }
    // Only care about markdown files or directory changes
    if (path.extname(filename) && !/\.(md|markdown)$/i.test(filename)) {
      return true;
    }
    return false;
  };

  const scheduleChange = () => {
    if (closed) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
      if (closed) return;
      try {
        await onChange();
      } catch (err: any) {
        log(`watcher onChange error: ${err.message}`);
      }
    }, debounceMs);
    debounceTimer.unref?.();
  };

  // Polling fallback (issue #100), shared by the no-native-setup path and the
  // issue #236 mid-run degradation path.
  // issue #195: iterative walk with an explicit stack — the recursive
  // version risked stack overflow on deep trees and re-walked everything
  // through the JS call frame per poll
  const getDirMtime = (root: string): number => {
    let max = 0;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '.mdss') continue;
        const full = path.join(dir, entry.name);
        if (shouldIgnore(entry.name)) continue;
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (/\.(md|markdown)$/i.test(entry.name)) {
          try {
            const fileStat = fs.statSync(full);
            if (fileStat.mtimeMs > max) max = fileStat.mtimeMs;
          } catch {}
        }
      }
    }
    return max;
  };

  let fsWatcher: fs.FSWatcher | null = null;
  let pollInterval: NodeJS.Timeout | null = null;
  let degraded = false;

  const startPolling = (why: string): void => {
    if (closed || pollInterval) return;
    log(why);
    let lastMtime = getDirMtime(dbPath);
    pollInterval = setInterval(() => {
      if (closed) return;
      const currentMtime = getDirMtime(dbPath);
      if (currentMtime > lastMtime) {
        lastMtime = currentMtime;
        scheduleChange();
      }
    }, fallbackIntervalMs);
    pollInterval.unref?.();
  };

  const stopNative = (): void => {
    if (fsWatcher) {
      const w = fsWatcher;
      fsWatcher = null;
      try {
        w.close();
      } catch {}
    }
  };

  // Attempt recursive native fs.watch first
  try {
    fsWatcher = fs.watch(
      dbPath,
      { recursive: true },
      (_eventType, filename) => {
        if (closed) return;
        if (filename && shouldIgnore(filename)) {
          return;
        }
        scheduleChange();
      }
    );

    // issue #236: a native watcher can die MID-RUN — inotify watch-limit
    // exhaustion (ENOSPC/EMFILE), revoked permissions (EPERM/EACCES), a
    // vanished root (ENOENT). The old handler only logged "continuing":
    // after that NO events were ever delivered again and no polling took
    // over, so `mdss serve --watch` silently stopped re-indexing while
    // looking healthy. Classify the error; anything non-transient (or an
    // unexpected 'close') degrades to interval polling with one loud line.
    fsWatcher.on('error', (err: NodeJS.ErrnoException) => {
      if (closed) return;
      // Watcher-death semantics differ from read-side classification: codes
      // like ENOSPC/EMFILE (inotify exhaustion) or EPERM/EACCES are bucketed
      // 'transient' for read bursts (issue #116) but are fatal to the event
      // stream. Only burst noise the handle typically survives keeps native.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!degraded && (code === 'EBUSY' || code === 'EAGAIN')) {
        log(`Native watcher transient error (${err.message}); keeping kernel events.`);
        return;
      }
      degraded = true;
      stopNative();
      startPolling(
        `Native watcher failed (${err.message}); switched to interval polling every ${fallbackIntervalMs} ms — changes are still detected.`,
      );
    });
    fsWatcher.on('close', () => {
      if (closed || degraded || pollInterval) return;
      fsWatcher = null; // the handle is gone — isNative must reflect that
      degraded = true;
      startPolling(
        `Native watcher closed unexpectedly; switched to interval polling every ${fallbackIntervalMs} ms — changes are still detected.`,
      );
    });

    // unref() lets the event loop exit even if the watcher is still active.
    // Without this, on Node 18/Linux the inotify handle keeps the process
    // alive indefinitely after all tests finish (or after close() is called
    // but the handle hasn't been fully released by the kernel yet).
    fsWatcher.unref?.();

    _testHooks?.onWatcher?.(fsWatcher);

    return {
      // Live mode: after a mid-run degradation the watcher polls, so the flag
      // must not keep claiming kernel events.
      get isNative() {
        return fsWatcher !== null;
      },
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        stopNative();
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      },
    };
  } catch (nativeErr: any) {
    startPolling(
      `Native recursive watch unavailable (${nativeErr.message}); falling back to interval polling every ${fallbackIntervalMs} ms.`,
    );
    return {
      isNative: false,
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      },
    };
  }
}
