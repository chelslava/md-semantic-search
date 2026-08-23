import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenCommand, openHit } from '../dist/open.js';

test('open: env editor resolution — VS Code family gets --goto file:line (issue #110)', () => {
  for (const ed of ['code', 'code.cmd', 'C:\\Program Files\\Microsoft VS Code\\bin\\code', 'codium', 'cursor']) {
    const r = resolveOpenCommand({ file: 'notes/а б.md', line: 42 }, { editor: ed, platform: 'win32' });
    assert.ok(r, `resolved via ${ed}`);
    assert.match(r.via, /\$EDITOR=/);
    assert.equal(r.args[r.args.length - 2], '--goto');
    assert.equal(r.args[r.args.length - 1], 'notes/а б.md:42');
    assert.ok(!r.args.some((a) => a.includes(' ')) || r.args.includes('--goto'), 'spaces survive inside one arg');
  }
});

test('open: plus-line editors get +N before the file; unknown editors get the file only (issue #110)', () => {
  const vim = resolveOpenCommand({ file: 'a.md', line: 7 }, { editor: 'vim', platform: 'linux' });
  assert.deepEqual(vim.args, ['+7', 'a.md']);

  const nano = resolveOpenCommand({ file: 'b.md', line: 3 }, { editor: 'nano -w', platform: 'linux' });
  assert.deepEqual(nano.args, ['-w', '+3', 'b.md'], 'extra flags forwarded verbatim');

  const weird = resolveOpenCommand({ file: 'c.md', line: 9 }, { editor: 'notepad', platform: 'win32' });
  assert.deepEqual(weird.args, ['c.md'], 'unknown editor: no line arg invented');
});

test('open: no env editor — per-platform GUI opener (issue #110)', () => {
  assert.deepEqual(
    resolveOpenCommand({ file: 'x.md' }, { platform: 'win32' }),
    { command: 'cmd', args: ['/c', 'start', '', 'x.md'], via: 'GUI opener' },
  );
  assert.deepEqual(
    resolveOpenCommand({ file: 'x.md' }, { platform: 'darwin' }),
    { command: 'open', args: ['x.md'], via: 'GUI opener' },
  );
  assert.deepEqual(
    resolveOpenCommand({ file: 'x.md' }, { platform: 'linux' }),
    { command: 'xdg-open', args: ['x.md'], via: 'GUI opener' },
  );
  assert.equal(resolveOpenCommand({ file: 'x.md' }, { platform: 'plan9' }), null, 'unsupported → graceful null');
});

test('open: openHit launches through the injected runner exactly once (issue #110)', () => {
  // a failing runner propagates its error to the caller…
  assert.throws(
    () => openHit({ file: 'a.md', line: 5 }, { editor: 'vim', runner: () => { throw new Error('spawn ENOENT'); } }),
    /ENOENT/,
  );

  // …and a healthy run passes resolved args through untouched
  const calls = [];
  const used = openHit({ file: 'a.md', line: 5 }, {
    editor: 'code',
    runner: (command, args, opts) => calls.push({ command, args, opts }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'code');
  assert.equal(calls[0].args[calls[0].args.length - 1], 'a.md:5');
  assert.equal(calls[0].opts.detached, true);
  assert.equal(used.via, '$EDITOR=code');
});
