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

// ---------------------------------------------------------------------------
// issue #272: the pack must be reachable FROM the npm package, not just the
// repo — the tarball ships it and `mdss skill` prints it verbatim so an agent
// can self-onboard with `npx md-semantic-search skill`.
// ---------------------------------------------------------------------------

test('agent-skill: npm tarball ships the pack and the integration guide', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(
    pkg.files.some((f) => f.replace(/\/$/, '') === 'integrations/agent-skill'),
    'package.json files must include integrations/agent-skill/ (issue #272)'
  );
  assert.ok(
    pkg.files.includes('docs/agent-integration.md'),
    'package.json files must include docs/agent-integration.md (issue #272)'
  );
});

test('agent-skill: `mdss skill` prints SKILL.md verbatim', async () => {
  const { execFileSync } = await import('node:child_process');
  const expected = read('integrations/agent-skill/SKILL.md');
  assert.ok(expected.endsWith('\n'), 'SKILL.md must end with a newline');
  const out = execFileSync(process.execPath, [path.join(root, 'bin', 'cli.mjs'), 'skill'], { encoding: 'utf8' });
  assert.equal(out.replace(/\r\n/g, '\n'), expected, 'mdss skill output must equal the shipped SKILL.md');
});

// ---------------------------------------------------------------------------
// issue #275: host-native packaging — the ZCode plugin bundles a drift-guarded
// skill copy and declares only resources that exist; OpenCode ships the mcp
// block + commands.
// ---------------------------------------------------------------------------

test('agent-skill: ZCode plugin bundles the skill copy and declares existing resources (issue #275)', () => {
  const canonical = read('integrations/agent-skill/SKILL.md');
  const bundled = read('integrations/zcode/mdss/skills/mdss-notes-search/SKILL.md');
  assert.equal(bundled, canonical, 'plugin skill copy must match the canonical SKILL.md byte-for-byte (CRLF-normalized)');

  const manifest = JSON.parse(read('integrations/zcode/mdss/.zcode-plugin/plugin.json'));
  assert.equal(manifest.name, 'mdss');
  assert.match(manifest.name, /^[a-z0-9-]+$/, 'plugin name is lower-case hyphenated');
  for (const p of [manifest.skills, manifest.commands, manifest.mcpServers]) {
    assert.ok(fs.existsSync(path.join(root, 'integrations', 'zcode', 'mdss', p)), `plugin resource exists: ${p}`);
  }

  const mcp = JSON.parse(read('integrations/zcode/mdss/.mcp.json'));
  const server = mcp.mcpServers?.mdss;
  assert.ok(server, '.mcp.json registers the mdss server');
  assert.ok(server.command === 'npx', 'server runs through npx');

  const market = JSON.parse(read('integrations/zcode/.claude-plugin/marketplace.json'));
  const entry = market.plugins.find((p) => p.name === 'mdss');
  assert.ok(entry, 'marketplace lists the mdss plugin');
  assert.equal(entry.version, manifest.version, 'marketplace version follows the manifest');
  assert.equal(entry.source, './mdss', 'marketplace source resolves inside the root');
});

test('agent-skill: OpenCode integration ships a valid mcp config and commands (issue #275)', () => {
  const cfg = JSON.parse(read('integrations/opencode/opencode.json'));
  const mdss = cfg.mcp?.mdss;
  assert.ok(mdss, 'opencode.json defines the mdss mcp block');
  assert.equal(mdss.type, 'local');
  assert.deepEqual(mdss.command.slice(0, 3), ['npx', '-y', 'md-semantic-search']);

  for (const cmd of ['integrations/opencode/command/mdss-search.md', 'integrations/opencode/command/mdss-index.md']) {
    const doc = read(cmd);
    assert.match(doc, /^---\ndescription: /, `${cmd} carries a description frontmatter`);
    assert.ok(doc.includes('$ARGUMENTS'), `${cmd} passes arguments through`);
  }
  // the AGENTS.md recipe must stay accurate: the skill ships in the npm tarball
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.files.includes('integrations/agent-skill/'), '`npx md-semantic-search skill` relies on the tarball-shipped skill');
});
