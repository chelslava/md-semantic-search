import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('integrations: VS Code extension manifest is valid and specifies contributions', () => {
  const pkgPath = path.join(ROOT, 'integrations', 'vscode', 'package.json');
  assert.ok(fs.existsSync(pkgPath));

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'md-semantic-search-vscode');
  assert.ok(Array.isArray(pkg.contributes?.commands));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'mdss.search'));
  assert.ok(pkg.contributes.viewsContainers?.activitybar?.length > 0);
  assert.ok(pkg.contributes.views?.['mdss-sidebar']?.length > 0);
});

test('integrations: Raycast extension manifest is valid and specifies command view', () => {
  const pkgPath = path.join(ROOT, 'integrations', 'raycast', 'package.json');
  assert.ok(fs.existsSync(pkgPath));

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.name, 'md-semantic-search');
  assert.ok(Array.isArray(pkg.commands));
  assert.equal(pkg.commands[0].name, 'search-notes');
  assert.equal(pkg.commands[0].mode, 'view');
});

test('integrations: Alfred script filter outputs valid Alfred JSON schema on empty and error queries', () => {
  const scriptPath = path.join(ROOT, 'integrations', 'alfred', 'search.mjs');
  assert.ok(fs.existsSync(scriptPath));

  // Run with no args -> prompt
  const procEmpty = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(procEmpty.status, 0);
  const outEmpty = JSON.parse(procEmpty.stdout);
  assert.ok(Array.isArray(outEmpty.items));
  assert.equal(outEmpty.items[0].valid, false);

  // Run with non-running daemon -> clean error item
  const procQuery = spawnSync(process.execPath, [scriptPath, 'test query'], {
    encoding: 'utf8',
    env: { ...process.env, MDSS_DAEMON_URL: 'http://127.0.0.1:59999' },
  });
  assert.equal(procQuery.status, 0);
  const outQuery = JSON.parse(procQuery.stdout);
  assert.ok(Array.isArray(outQuery.items));
  assert.ok(outQuery.items[0].title.includes('Error'));
});
