import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileWatcher } from '../dist/watcher.js';

function safeRm(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

test('watcher: createFileWatcher detects markdown changes and triggers debounced callback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-watcher-'));
  let changeCount = 0;

  try {
    fs.writeFileSync(path.join(dir, 'doc1.md'), '# Initial Document\n');

    const watcher = createFileWatcher(
      dir,
      () => {
        changeCount++;
      },
      { debounceMs: 50 }
    );

    assert.equal(typeof watcher.close, 'function');

    // Create a new markdown file
    fs.writeFileSync(path.join(dir, 'doc2.md'), '# Second Document\n');

    // Wait for debounce / polling settle
    const deadline = Date.now() + 1000;
    while (changeCount < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    assert.ok(changeCount >= 1, `Expected changeCount >= 1, got ${changeCount}`);

    watcher.close();
  } finally {
    safeRm(dir);
  }
});

test('watcher: createFileWatcher ignores non-markdown files and ignored patterns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-watcher-ignore-'));
  let changeCount = 0;

  try {
    const watcher = createFileWatcher(
      dir,
      () => {
        changeCount++;
      },
      { debounceMs: 50, ignore: ['ignore-me/**'] }
    );

    // Modify a non-markdown file
    fs.writeFileSync(path.join(dir, 'test.tmp'), 'temporary data');

    // Wait for debounce settle
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(changeCount, 0, 'Non-markdown files should not trigger change');

    watcher.close();
  } finally {
    safeRm(dir);
  }
});

// ---------------------------------------------------------------------------
// issue #236: a native watcher can die MID-RUN (inotify watch-limit exhaustion
// ENOSPC/EMFILE, revoked permissions, unexpected handle close). The old error
// handler only logged "continuing" — no events were ever delivered again and
// no polling took over, so serve --watch silently stopped re-indexing.
// ---------------------------------------------------------------------------

function waitForChange(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (!check() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    return check();
  })();
}

test('watcher: a fatal native error degrades to polling and changes are still detected (issue #236)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-watcher-236-'));
  let nativeHandle = null;
  let changeCount = 0;
  const logs = [];
  try {
    fs.writeFileSync(path.join(dir, 'doc1.md'), '# Initial Document\n');

    const watcher = createFileWatcher(
      dir,
      () => { changeCount++; },
      {
        debounceMs: 30,
        fallbackIntervalMs: 50,
        log: (m) => logs.push(m),
        _testHooks: { onWatcher: (w) => { nativeHandle = w; } },
      },
    );

    assert.equal(watcher.isNative, true, 'starts on kernel events');
    assert.ok(nativeHandle, 'test hook handed us the raw watcher');

    // kill the event stream the way inotify exhaustion does
    nativeHandle.emit('error', Object.assign(new Error('watch limit reached'), { code: 'ENOSPC' }));

    assert.equal(watcher.isNative, false, 'degraded to polling after a fatal error');
    assert.ok(logs.some((m) => /switched to interval polling/i.test(m)), 'one loud degradation line');
    assert.ok(logs.some((m) => /changes are still detected/i.test(m)));

    // polling must now carry the changes the dead native stream cannot
    fs.writeFileSync(path.join(dir, 'doc2.md'), '# Second Document\n');
    assert.equal(await waitForChange(() => changeCount >= 1), true, 'polling detected the change');

    watcher.close();
  } finally {
    safeRm(dir);
  }
});

test('watcher: burst-noise codes (EBUSY/EAGAIN) keep the native handle (issue #236)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-watcher-236b-'));
  let nativeHandle = null;
  try {
    const watcher = createFileWatcher(dir, () => {}, {
      _testHooks: { onWatcher: (w) => { nativeHandle = w; } },
    });
    assert.equal(watcher.isNative, true);
    nativeHandle.emit('error', Object.assign(new Error('resource busy'), { code: 'EBUSY' }));
    assert.equal(watcher.isNative, true, 'EBUSY does not degrade — the handle typically survives it');
    watcher.close();
  } finally {
    safeRm(dir);
  }
});

test('watcher: an unexpected close without an error also switches to polling (issue #236)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-watcher-236c-'));
  let nativeHandle = null;
  let changeCount = 0;
  try {
    fs.writeFileSync(path.join(dir, 'doc1.md'), '# Initial Document\n');
    const watcher = createFileWatcher(
      dir,
      () => { changeCount++; },
      {
        debounceMs: 30,
        fallbackIntervalMs: 50,
        _testHooks: { onWatcher: (w) => { nativeHandle = w; } },
      },
    );
    assert.equal(watcher.isNative, true);

    nativeHandle.emit('close');
    assert.equal(watcher.isNative, false, 'closed handle → polling');

    fs.writeFileSync(path.join(dir, 'doc2.md'), '# Second Document\n');
    assert.equal(await waitForChange(() => changeCount >= 1), true, 'polling detected the change');

    watcher.close();
  } finally {
    safeRm(dir);
  }
});
