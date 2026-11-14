import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOLS, MCP_RESOURCE_TEMPLATES, MCP_PROMPTS } from '../dist/mcp.js';

// ---------------------------------------------------------------------------
// issue #262: the agent-skill pack is an interface — if the docs drift from
// the real tool/URI/command surface, agents follow broken recipes. Pin every
// name the docs mention to the actual MCP registry of the server, and pin the
// CLI commands to --help output.
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// normalize CRLF — windows checkouts materialize LF-committed docs with \r\n,
// and the frontmatter/recipe regexes below match on \n
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

test('agent-skill: SKILL.md has valid frontmatter with name and description', () => {
  const skill = read('integrations/agent-skill/SKILL.md');
  assert.match(skill, /^---\nname: mdss-notes-search\ndescription: /, 'skill frontmatter must carry name + description');
  assert.ok(skill.includes('\n---\n'), 'frontmatter must be closed');
  assert.ok(skill.length > 2000, 'the skill body is the actual recipe — not a stub');
});

test('agent-skill: every MCP tool name appears in SKILL.md and the integration guide', () => {
  const skill = read('integrations/agent-skill/SKILL.md');
  const guide = read('docs/agent-integration.md');
  for (const tool of MCP_TOOLS) {
    assert.ok(skill.includes(tool.name), `SKILL.md must mention tool ${tool.name}`);
    assert.ok(guide.includes(tool.name), `docs/agent-integration.md must mention tool ${tool.name}`);
  }
});

test('agent-skill: every resource template and prompt name appears in the integration guide', () => {
  const guide = read('docs/agent-integration.md');
  const uris = (MCP_RESOURCE_TEMPLATES || []).map((t) => t.uriTemplate || t.uri_template || t.uri || '').filter(Boolean);
  assert.ok(uris.length >= 3, 'resource templates are exposed by the server');
  for (const uri of uris) {
    const scheme = uri.split('?')[0].replace(/\{[^}]*\}/g, '{…}');
    assert.ok(guide.includes(scheme.split('{')[0]), `guide must mention resource scheme ${scheme}`);
  }
  for (const p of MCP_PROMPTS || []) {
    assert.ok(guide.includes(p.name), `guide must mention prompt ${p.name}`);
  }
});

test('agent-skill: CLI recipes reference real commands (pinned to --help)', async () => {
  const { execFileSync } = await import('node:child_process');
  const help = execFileSync(process.execPath, [path.join(root, 'bin', 'cli.mjs'), '--help'], { encoding: 'utf8' });
  const skill = read('integrations/agent-skill/SKILL.md');
  // every `mdss <cmd>` recipe line in the skill must be a real command
  const commands = [...skill.matchAll(/^mdss ([a-z]+)/gm)].map((m) => m[1]);
  assert.ok(commands.length >= 4, 'the skill teaches several CLI commands');
  for (const cmd of commands) {
    assert.match(help, new RegExp(`mdss ${cmd}\\b`), `SKILL.md command "mdss ${cmd}" must exist in --help`);
  }
  // the historical trap: the command is `mdss related`, not "related-notes"
  assert.ok(!skill.includes('mdss related-notes'), 'use the real command name mdss related');
});

test('agent-skill: discoverability — README/integrations links and npm keywords', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('integrations/agent-skill/SKILL.md'), 'README must link the skill pack');
  assert.ok(readme.includes('docs/agent-integration.md'), 'README must link the agent guide');
  const integReadme = read('integrations/README.md');
  assert.ok(integReadme.includes('`agent-skill/`'), 'capability matrix must list the skill pack');
  const pkg = JSON.parse(read('package.json'));
  for (const kw of ['mcp', 'mcp-server', 'model-context-protocol', 'ai-agents']) {
    assert.ok(pkg.keywords.includes(kw), `npm keywords must include "${kw}" for agent-client discoverability`);
  }
});

test('agent-skill: guide documents abstention and honest-limitations behavior', () => {
  const guide = read('docs/agent-integration.md');
  assert.match(guide, /answerMode/, 'guide must explain answerMode semantics');
  assert.match(guide, /abstained/i, 'guide must teach the abstention contract');
  const skill = read('integrations/agent-skill/SKILL.md');
  assert.match(skill, /abstained/i, 'skill must teach "refuse, do not fabricate"');
  assert.match(skill, /Citation discipline/i, 'skill must pin citation rules');
});
