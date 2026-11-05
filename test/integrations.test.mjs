// Cross-integration contract tests (issue #230). Surface-specific tests live
// in their owner files: test/vscode.test.mjs, test/alfred.test.mjs,
// test/raycast.test.mjs; the shared daemon client is covered by
// test/integrations-client.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INTEGRATIONS = path.join(ROOT, 'integrations');

test('integrations: every integration ships a README (issue #230)', () => {
  const dirs = fs
    .readdirSync(INTEGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.deepEqual(
    dirs.slice().sort(),
    ['alfred', 'obsidian', 'raycast', 'shared', 'vscode', 'windows'],
    'the six known integrations exist',
  );
  for (const dir of dirs) {
    assert.ok(
      fs.existsSync(path.join(INTEGRATIONS, dir, 'README.md')),
      `integrations/${dir}/README.md exists`,
    );
  }
});

test('integrations: shared client is the canonical daemon contract (issue #112/#230)', () => {
  const clientPath = path.join(INTEGRATIONS, 'shared', 'search-client.mjs');
  const src = fs.readFileSync(clientPath, 'utf8');
  assert.ok(src.includes('export function createSearchClient'));
  assert.ok(src.includes('export function extractSseFrames'));

  // Launcher parity: each launcher consumes the shared config knobs.
  const alfred = fs.readFileSync(path.join(INTEGRATIONS, 'alfred', 'search.mjs'), 'utf8');
  assert.ok(alfred.includes('MDSS_API_KEY'), 'alfred: Bearer env supported');
  const raycast = fs.readFileSync(path.join(INTEGRATIONS, 'raycast', 'src', 'search-notes.tsx'), 'utf8');
  assert.ok(raycast.includes('apiKey'), 'raycast: apiKey preference supported');
  const vscode = fs.readFileSync(path.join(INTEGRATIONS, 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.ok(vscode.includes('resolveApiKey'), 'vscode: SecretStorage-first apiKey');
});

test('integrations: parent README documents every integration and its release flow', () => {
  const readme = fs.readFileSync(path.join(INTEGRATIONS, 'README.md'), 'utf8');
  for (const dir of ['vscode', 'obsidian', 'raycast', 'alfred', 'windows']) {
    assert.ok(readme.includes(`\`${dir}/\``), `parent README lists ${dir}`);
  }
});
