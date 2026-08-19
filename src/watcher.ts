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
}

export interface FileWatcher {
  close: () => void;
  isNative: boolean;
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
    fallbackIntervalMs = 1000,
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
  };

  // Attempt recursive native fs.watch first
  try {
    const fsWatcher = fs.watch(
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

    fsWatcher.on('error', (err) => {
      log(`Native watcher error (${err.message}), continuing.`);
    });

    // unref() lets the event loop exit even if the watcher is still active.
    // Without this, on Node 18/Linux the inotify handle keeps the process
    // alive indefinitely after all tests finish (or after close() is called
    // but the handle hasn't been fully released by the kernel yet).
    fsWatcher.unref();

    return {
      isNative: true,
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        try {
          fsWatcher.close();
        } catch {}
      },
    };
  } catch (nativeErr: any) {
    log(`Native recursive watch unavailable (${nativeErr.message}); falling back to interval polling.`);

    // Polling fallback
    let lastMtime = 0;
    const getDirMtime = (dir: string): number => {
      try {
        const stat = fs.statSync(dir);
        let max = stat.mtimeMs;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === '.mdss') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const sub = getDirMtime(full);
            if (sub > max) max = sub;
          } else if (/\.(md|markdown)$/i.test(entry.name)) {
            try {
              const fileStat = fs.statSync(full);
              if (fileStat.mtimeMs > max) max = fileStat.mtimeMs;
            } catch {}
          }
        }
        return max;
      } catch {
        return 0;
      }
    };

    lastMtime = getDirMtime(dbPath);
    const pollInterval = setInterval(() => {
      if (closed) return;
      const currentMtime = getDirMtime(dbPath);
      if (currentMtime > lastMtime) {
        lastMtime = currentMtime;
        scheduleChange();
      }
    }, fallbackIntervalMs);

    return {
      isNative: false,
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        clearInterval(pollInterval);
      },
    };
  }
}
