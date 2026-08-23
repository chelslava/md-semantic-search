/** Stage-split measurement for #113: parse vs embed vs lexical/write shares. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from '../bench/fixture.mjs';
import { walkMarkdown } from '../dist/core.js';
import { parseFile } from '../dist/core.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = loadFixture(JSON.parse(fs.readFileSync(path.join(REPO, 'bench/fixtures/dev-golden.json'), 'utf8')));
const db = path.resolve(REPO, fixture.corpusPath);

// amplify: repeat the corpus N times into a temp tree so stage costs are readable
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-stagesplit-'));
const N = 30;
for (let i = 0; i < N; i++) {
  const dst = path.join(tmp, `copy${i}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of walkMarkdown(db)) {
    const rel = path.relative(db, f);
    const target = path.join(dst, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target);
  }
}

const files = walkMarkdown(tmp);
console.log(`files: ${files.length}`);

const t0 = process.hrtime.bigint();
let chunks = 0;
for (const f of files) {
  const parsed = parseFile(f, tmp);
  chunks += parsed.length;
}
const t1 = process.hrtime.bigint();
const parseMs = Number(t1 - t0) / 1e6;
console.log(`parse+chunk: ${parseMs.toFixed(0)} ms (${chunks} chunks, ${(chunks / (parseMs / 1000)).toFixed(0)} chunks/s serial)`);

fs.rmSync(tmp, { recursive: true, force: true });
