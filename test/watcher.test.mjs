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

    // Wait for debounce settle
    await new Promise((resolve) => setTimeout(resolve, 150));

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
