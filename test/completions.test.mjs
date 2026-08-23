import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCompletion, FLAGS, COMMANDS, COMPLETION_SHELLS } from '../dist/completions.js';

const CLI_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs'),
  'utf8',
);

test('completions: all four shells generate non-empty scripts with key markers (issue #107)', () => {
  const markers = {
    bash: ['_mdss_completion()', 'complete -o default -F _mdss_completion mdss', 'compgen'],
    zsh: ['#compdef mdss', '_describe', 'compdef _mdss'],
    fish: ['complete -c mdss', '__fish_is_first_arg', '-l index-dir'],
    powershell: ['Register-ArgumentCompleter', 'CompletionResult', "'mdss'"],
  };
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletion(shell);
    assert.ok(script.length > 500, `${shell} script is substantial`);
    for (const m of markers[shell]) {
      assert.ok(script.includes(m), `${shell} script contains "${m}"`);
    }
    // every command appears in every script
    for (const c of COMMANDS) {
      assert.ok(script.includes(c), `${shell} covers command ${c}`);
    }
  }
});

test('completions: file/dir flags get special path completion (issue #107)', () => {
  const bash = generateCompletion('bash');
  const lines = bash.split('\n');
  const caseLineFor = (comp) => {
    const idx = lines.findIndex((l) => l.includes(comp));
    return lines[idx - 1].trim().replace(/\)$/, '');
  };
  const dirCase = caseLineFor('compgen -d').split('|');
  for (const f of ['--db', '--vault', '--index-dir', '--cache-dir']) {
    assert.ok(dirCase.includes(f), `dir flag ${f} in bash dir-case`);
  }
  const fileCase = caseLineFor('compgen -f').split('|');
  for (const f of ['--output', '-o', '--config', '--api-key-file']) {
    assert.ok(fileCase.includes(f), `file flag ${f} in bash file-case`);
  }

  const ps = generateCompletion('powershell');
  assert.ok(ps.includes("'--output'") && ps.includes("'-o'"), 'output + short alias in PowerShell arrays');
});

test('completions: unknown shell exits with usage (issue #107)', () => {
  for (const bad of ['', 'fishy', 'BASH', 'cmd']) {
    assert.throws(() => generateCompletion(bad), /unknown shell/i, `"${bad}" rejected`);
  }
});

test('completions: drift guard — FLAGS table matches bin/cli.mjs parseArgs exactly (issue #107)', () => {
  // Flags the parser actually understands: every literal compared in parseArgs.
  const parsed = new Set();
  for (const m of CLI_SOURCE.matchAll(/a === '(--[a-z][a-z0-9-]*)'/g)) {
    parsed.add(m[1]);
  }
  for (const m of CLI_SOURCE.matchAll(/a === '-([a-z])'/g)) {
    parsed.add(`-${m[1]}`);
  }
  // OR-combined aliases inside one branch: (--no-vectors' || a === '--no-vector')
  for (const m of CLI_SOURCE.matchAll(/a === '(--[a-z][a-z0-9-]*)'\s*\|\|\s*a === '(--[a-z][a-z0-9-]*)'/g)) {
    parsed.add(m[1]);
    parsed.add(m[2]);
  }

  const tabled = new Set(FLAGS.flatMap((f) => [f.name, ...(f.alias ? [f.alias] : [])]));

  const missingFromTable = [...parsed].filter((f) => !tabled.has(f)).sort();
  const staleInTable = [...tabled].filter((f) => !parsed.has(f)).sort();

  assert.deepEqual(
    missingFromTable, [],
    `flags parsed in cli.mjs but missing from completions FLAGS — add them: ${missingFromTable.join(', ')}`,
  );
  assert.deepEqual(
    staleInTable, [],
    `flags in completions FLAGS that parseArgs no longer accepts — remove them: ${staleInTable.join(', ')}`,
  );
});
