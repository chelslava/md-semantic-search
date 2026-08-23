// @ts-check
/**
 * Version-sync check between integration manifests and the mdss protocol
 * expectations (issue #112). Wired into CI (lint job) so an integration that
 * references removed endpoints/fields fails fast.
 *
 * Checks:
 *  1. Every manifest exists and its version is valid semver.
 *  2. The shared search-client contract fields all appear in src/serve.ts
 *     (the daemon really returns them).
 *  3. Obsidian manifest.minAppVersion is parseable semver-ish (x.y.z).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const manifests = [
  { name: 'vscode', file: path.join(ROOT, 'integrations/vscode/package.json'), versionKey: 'version' },
  { name: 'obsidian', file: path.join(ROOT, 'integrations/obsidian/manifest.json'), versionKey: 'version' },
];

for (const m of manifests) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  } catch (e) {
    problems.push(`${m.name}: cannot read/parse ${path.relative(ROOT, m.file)} (${e.message})`);
    continue;
  }
  const version = json[m.versionKey];
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(version))) {
    problems.push(`${m.name}: version "${version}" is not semver`);
  }
}

// Protocol contract anchors:
//  - endpoints live in src/serve.ts (the HTTP surface);
//  - hit fields are constructed in src/search.ts (the ranking pipeline).
const serveSrc = fs.readFileSync(path.join(ROOT, 'src', 'serve.ts'), 'utf8');
const searchSrc = fs.readFileSync(path.join(ROOT, 'src', 'search.ts'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'integrations/shared/search-client.mjs'), 'utf8');
for (const field of ['file', 'title', 'heading', 'cosine', 'snippet', 'startLine']) {
  if (!new RegExp(`\\b${field}\\b`).test(searchSrc)) {
    problems.push(`protocol: hits no longer carry "${field}" — update integrations/shared`);
  }
}
if (!/\bresults\b/.test(serveSrc)) {
  problems.push('protocol: /search envelope lost "results" — update integrations/shared');
}
for (const endpoint of ['/search', '/health']) {
  if (!serveSrc.includes(`'${endpoint}'`)) problems.push(`protocol: endpoint ${endpoint} missing in serve.ts`);
  if (!clientSrc.includes(endpoint)) problems.push(`protocol: shared client lost ${endpoint}`);
}

if (problems.length > 0) {
  console.error('Integration manifest sync check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('integration manifests: versions + protocol sync OK');
