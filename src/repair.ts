/**
 * Safe auto-repairs for `mdss check --fix` (issue #117).
 *
 * Plan/apply split: planRepairs() probes the index directory WITHOUT mutating
 * anything (so --dry-run can print the exact plan), applyRepairs() executes
 * actions in order and reports per-action outcomes. Source Markdown is NEVER
 * touched; the only reads from --db are for recomputing `.hashes.json` or a
 * full index rebuild.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_FILENAME, pidAlive, walkMarkdown } from './core.js';
import { DEFAULT_MODEL } from './models.js';

const LOCK_STALE_MS = 10 * 60 * 1000;

export interface RepairAction {
  action:
    | 'remove-stale-lock'
    | 'remove-broken-vectors-bin'
    | 'remove-corrupt-ivf'
    | 'rebuild-index'
    | 'rewrite-hashes';
  detail: string;
}

export interface RepairPlan {
  actions: RepairAction[];
  skipped: RepairAction[];
}

export interface ApplyResult {
  performed: RepairAction[];
  failed: Array<RepairAction & { error: string }>;
}

interface ProbeOptions {
  db?: string | null;
  log?: (msg: string) => void;
}

function readJsonIfParsable(filePath: string): { ok: true; value: any } | { ok: false } | { ok: 'missing' } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: 'missing' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** Recompute the {relativePath: md5} map exactly as the indexer stores it. */
export function recomputeHashes(db: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const f of walkMarkdown(db)) {
    const rel = path.relative(db, f).split(path.sep).join('/');
    const md5 = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
    hashes[rel] = md5;
  }
  return hashes;
}

/**
 * Probe the index directory and decide what CAN be safely repaired.
 * Never mutates anything — safe to call for --dry-run.
 */
export function planRepairs(indexDir: string, opts: ProbeOptions = {}): RepairPlan {
  const plan: RepairPlan = { actions: [], skipped: [] };
  const db = opts.db ?? null;

  // --- 1. stale / abandoned lock ---
  const lockPath = path.join(indexDir, LOCK_FILENAME);
  if (fs.existsSync(lockPath)) {
    let info: { pid?: unknown; since?: unknown } | null = null;
    try {
      info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      info = null;
    }
    const pid = Number.isInteger(info?.pid) ? (info!.pid as number) : null;
    let statAgeMs = Infinity;
    try {
      statAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      /* vanished between exists and stat */
    }
    if (!info) {
      plan.actions.push({ action: 'remove-stale-lock', detail: `${LOCK_FILENAME} is unreadable/abandoned` });
    } else if (pid !== null && !pidAlive(pid)) {
      plan.actions.push({ action: 'remove-stale-lock', detail: `${LOCK_FILENAME} held by dead pid ${pid}` });
    } else if (statAgeMs > LOCK_STALE_MS) {
      plan.actions.push({
        action: 'remove-stale-lock',
        detail: `${LOCK_FILENAME} is older than ${Math.round(LOCK_STALE_MS / 60000)} min`,
      });
    } else {
      plan.skipped.push({
        action: 'remove-stale-lock',
        detail: `live writer holds the lock${pid ? ` (pid ${pid})` : ''}`,
      });
    }
  }

  // --- 2. vectors.bin integrity (SHA-256 sidecar) ---
  const binPath = path.join(indexDir, 'vectors.bin');
  const shaPath = `${binPath}.sha256`;
  if (fs.existsSync(binPath)) {
    let broken: string | null = null;
    try {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(binPath)).digest('hex');
      if (!fs.existsSync(shaPath)) {
        broken = 'missing vectors.bin.sha256 sidecar';
      } else {
        const expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
        if (!expected || expected !== actual) broken = 'SHA-256 mismatch';
      }
    } catch (e: any) {
      broken = e.message;
    }
    if (broken) {
      plan.actions.push({
        action: 'remove-broken-vectors-bin',
        detail: `vectors.bin ignored (${broken}) — search falls back to vectors.json`,
      });
    }
  }

  // --- 3. corrupt ivf.json (optional ANN sidecar; loader silently ignores it) ---
  const ivfPath = path.join(indexDir, 'ivf.json');
  const ivfRaw = readJsonIfParsable(ivfPath);
  if (ivfRaw.ok === false) {
    plan.actions.push({
      action: 'remove-corrupt-ivf',
      detail: 'ivf.json is not valid JSON — removing it re-enables brute-force ANN fallback',
    });
  }

  // --- 4. corrupt vectors.json ---
  const liveWriter = plan.skipped.some(
    (s) => s.action === 'remove-stale-lock' && /live writer/.test(s.detail),
  );
  const vectorsRaw = readJsonIfParsable(path.join(indexDir, 'vectors.json'));
  if (vectorsRaw.ok === false) {
    if (db && !liveWriter) {
      plan.actions.push({ action: 'rebuild-index', detail: `vectors.json is not valid JSON — rebuild from ${db}` });
    } else if (liveWriter) {
      plan.skipped.push({
        action: 'rebuild-index',
        detail: 'vectors.json is not valid JSON, but a live writer holds the lock — retry after it finishes',
      });
    } else {
      plan.skipped.push({
        action: 'rebuild-index',
        detail: 'vectors.json is not valid JSON — pass --db so --fix can rebuild it',
      });
    }
  }

  // --- 5. damaged .hashes.json ---
  const hashesRaw = readJsonIfParsable(path.join(indexDir, '.hashes.json'));
  if (hashesRaw.ok === false) {
    if (db) {
      plan.actions.push({ action: 'rewrite-hashes', detail: '.hashes.json is not valid JSON — recompute from source md5' });
    } else {
      plan.skipped.push({
        action: 'rewrite-hashes',
        detail: '.hashes.json is not valid JSON — pass --db so --fix can recompute it',
      });
    }
  }

  return plan;
}

/** Execute planned actions in order. dryRun=true performs nothing. */
export function applyRepairs(
  indexDir: string,
  plan: RepairPlan,
  opts: {
    dryRun?: boolean;
    db?: string | null;
    cacheDir?: string;
    modelName?: string;
    embedFn?: any;
    offline?: boolean;
    log?: (msg: string) => void;
  } = {}
): Promise<ApplyResult> {
  const performed: RepairAction[] = [];
  const failed: Array<RepairAction & { error: string }> = [];
  const log = opts.log ?? (() => {});

  const run = async (): Promise<ApplyResult> => {
    for (const action of plan.actions) {
      if (opts.dryRun) {
        performed.push(action);
        continue;
      }
      try {
        switch (action.action) {
          case 'remove-stale-lock':
            fs.unlinkSync(path.join(indexDir, LOCK_FILENAME));
            break;
          case 'remove-broken-vectors-bin':
            fs.rmSync(path.join(indexDir, 'vectors.bin'), { force: true });
            fs.rmSync(`${path.join(indexDir, 'vectors.bin')}.sha256`, { force: true });
            break;
          case 'remove-corrupt-ivf':
            fs.rmSync(path.join(indexDir, 'ivf.json'), { force: true });
            break;
          case 'rewrite-hashes': {
            const hashes = recomputeHashes(opts.db!);
            fs.writeFileSync(path.join(indexDir, '.hashes.json'), JSON.stringify(hashes, null, 2));
            break;
          }
          case 'rebuild-index': {
            const { buildIndex } = await import('./indexer.js');
            const rebuildOpts: Parameters<typeof buildIndex>[0] = {
              db: opts.db!,
              indexDir,
              cacheDir: opts.cacheDir!,
              modelName: opts.modelName || DEFAULT_MODEL,
              log,
              _lockHeld: true, // we may have JUST removed a stale lock; never double-lock inside fix
            };
            if (opts.embedFn) rebuildOpts.embedFn = opts.embedFn; // test DI — keeps repairs model-free
            await buildIndex(rebuildOpts);
            break;
          }
        }
        performed.push(action);
      } catch (e: any) {
        failed.push({ ...action, error: e.message });
      }
    }
    return { performed, failed };
  };

  return run();
}
