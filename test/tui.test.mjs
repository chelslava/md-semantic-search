import test from 'node:test';
import assert from 'node:assert/strict';
import { runTui } from '../dist/tui.js';
import { parseArgs } from '../bin/cli.mjs';

test('runTui throws if process.stdin or process.stdout is not a TTY', async () => {
  await assert.rejects(
    async () => {
      await runTui({
        indexDir: './.mdss',
        cacheDir: './.cache',
      });
    },
    /interactive TUI requires a TTY terminal/
  );
});

test('cli parseArgs accepts --interactive and -i flags', () => {
  const opts1 = parseArgs(['search', '--interactive', '--db', './notes']);
  assert.equal(opts1.interactive, true);

  const opts2 = parseArgs(['search', '-i', '--db', './notes']);
  assert.equal(opts2.interactive, true);
});
