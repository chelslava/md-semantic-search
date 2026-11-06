#!/usr/bin/env node
/**
 * Alfred Ask Notes (issue #250) — one-shot grounded QA over the daemon's
 * streamed POST /ask, printed as Alfred Script-Filter JSON: the answer item
 * (large-type) plus one source item per citation. No chat sessions from a
 * launcher. The client-side SSE accumulation mirrors the shared client's
 * pinned frame split (issue #199).
 */
import { createSearchClient, extractSseFrames } from '../shared/search-client.mjs';
import { parseFilterKeywords, toAlfredAskItems, errorItem } from './helpers.mjs';

const query = process.argv.slice(2).join(' ').trim();
const daemonUrl = process.env.MDSS_DAEMON_URL || 'http://127.0.0.1:8747';
const apiKey = process.env.MDSS_API_KEY || undefined;

if (!query) {
  process.stdout.write(JSON.stringify({
    items: [{ title: 'MDSS Ask Notes', subtitle: 'Type a question — the answer comes from your notes with citations.', valid: false }],
  }));
  process.exit(0);
}

try {
  const { body, query: cleanQuery } = parseFilterKeywords(query);
  const filters = { ...body };
  delete filters.query;
  const client = createSearchClient({ baseUrl: daemonUrl, apiKey });
  let answer = '';
  let citations = [];
  let mode;
  await client.ask(cleanQuery || query, {
    k: 6,
    ...filters,
    onFrame: (event, obj) => {
      if (event === 'sources') citations = obj.citations || [];
      else if (event === 'delta') answer += obj.text || '';
      else if (event === 'done') {
        answer = obj.answer || answer;
        citations = obj.citations || citations;
        mode = obj.mode;
      }
    },
  });
  process.stdout.write(JSON.stringify(toAlfredAskItems({ answer, citations, mode })));
} catch (err) {
  process.stdout.write(JSON.stringify(errorItem(err.message)));
}
