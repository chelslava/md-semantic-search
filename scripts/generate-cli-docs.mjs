#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const cliPath = path.join(root, 'bin', 'cli.mjs');

const res = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error('Failed to run mdss --help:', res.stderr);
  process.exit(1);
}

const helpText = res.stdout;
const outDoc = `# CLI Reference

This document is automatically generated from \`mdss --help\`.

\`\`\`text
${helpText.trim()}
\`\`\`
`;

const docsDir = path.join(root, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'cli-reference.md'), outDoc, 'utf8');
console.log('Successfully generated docs/cli-reference.md');
