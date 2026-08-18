#!/usr/bin/env node
/**
 * Alfred Script Filter for MDSS Semantic Search (issue #99).
 * Outputs JSON format consumed by Alfred 5 / Alfred 4 Workflow Script Filter.
 */
const query = process.argv.slice(2).join(' ').trim();
const daemonUrl = process.env.MDSS_DAEMON_URL || 'http://127.0.0.1:8747';

if (!query) {
  process.stdout.write(JSON.stringify({
    items: [{
      title: 'MDSS Semantic Search',
      subtitle: 'Type a concept or query to search Markdown notes...',
      valid: false,
    }],
  }));
  process.exit(0);
}

try {
  const resp = await fetch(`${daemonUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, k: 9 }),
  });

  if (!resp.ok) {
    throw new Error(`Daemon returned HTTP ${resp.status}`);
  }

  const results = await resp.json();
  if (!Array.isArray(results) || results.length === 0) {
    process.stdout.write(JSON.stringify({
      items: [{
        title: 'No matches found',
        subtitle: `No semantic notes matching "${query}"`,
        valid: false,
      }],
    }));
    process.exit(0);
  }

  const items = results.map((r) => ({
    uid: `${r.file}#${r.heading || ''}`,
    title: `${r.title} ${r.heading ? `› ${r.heading}` : ''}`,
    subtitle: `[cos: ${(r.cosine ?? r.score ?? 0).toFixed(3)}] ${r.snippet.slice(0, 120)}…`,
    arg: r.file,
    type: 'file',
    text: {
      copy: r.snippet,
      largetype: `${r.title}\n\n${r.snippet}`,
    },
    quicklookurl: r.file,
  }));

  process.stdout.write(JSON.stringify({ items }));
} catch (err) {
  process.stdout.write(JSON.stringify({
    items: [{
      title: 'MDSS Search Error',
      subtitle: `Failed to query daemon: ${err.message}. Is \`mdss serve\` running?`,
      valid: false,
    }],
  }));
}
