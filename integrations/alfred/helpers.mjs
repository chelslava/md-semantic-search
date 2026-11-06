/**
 * Pure helpers for the Alfred Script Filter (issue #230) — unit-tested in
 * test/alfred.test.mjs. The script itself (search.mjs) only wires these to
 * stdin/stdout and the shared daemon client.
 */

/** @typedef {{file:string, title?:string, heading?:string, snippet?:string, cosine?:number, score?:number}} SearchHit */

/** The idle / empty-query first item Alfred shows before any input. */
export function idleItem() {
  return {
    items: [
      {
        title: 'MDSS Semantic Search',
        subtitle: 'Type a concept or query to search Markdown notes...',
        valid: false,
      },
    ],
  };
}

/** The "no matches" response for a processed but empty result set. */
export function noMatchesItem(query) {
  return {
    items: [
      {
        title: 'No matches found',
        subtitle: `No semantic notes matching "${query}"`,
        valid: false,
      },
    ],
  };
}

/** The daemon-failure response — actionable, mentions the serve prerequisite. */
export function errorItem(message) {
  return {
    items: [
      {
        title: 'MDSS Search Error',
        subtitle: `Failed to query daemon: ${message}. Is \`mdss serve\` running?`,
        valid: false,
      },
    ],
  };
}

/** Alfred argv → query string (the Script Filter passes words as argv). */
export function queryFromArgv(argv) {
  return (argv || []).join(' ').trim();
}

/**
 * Search hits → Alfred Script Filter items (issue #99 contract): uid pins
 * file+heading for Alfred's result re-ranking, arg opens the file, quicklook
 * previews it, the score is shown with 3 decimals.
 */
export function toAlfredItems(results) {
  return (results || []).map((r) => ({
    uid: `${r.file}#${r.heading || ''}`,
    title: `${r.title} ${r.heading ? `› ${r.heading}` : ''}`,
    subtitle: `[cos: ${(r.cosine ?? r.score ?? 0).toFixed(3)}] ${(r.snippet || '').slice(0, 120)}…`,
    arg: r.file,
    type: 'file',
    text: {
      copy: r.snippet,
      largetype: `${r.title}\n\n${r.snippet}`,
    },
    quicklookurl: r.file,
  }));
}

/**
 * issue #250: launcher parity — keyword-modified filters. `mdss #tag:eng
 * #type:guide query` maps the leading `#key:value` tokens to /search body
 * fields (the same contract the web UI filter inputs use); everything after
 * them is the query. Unknown `#key:value` tokens stay in the query verbatim.
 */
export function parseFilterKeywords(query) {
  const body = {};
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  const rest = [];
  const KEYS = ['tag', 'type', 'status', 'project'];
  for (const word of words) {
    const m = /^#([a-zA-Z]+):(.+)$/.exec(word);
    if (m && KEYS.includes(m[1])) {
      body[m[1]] = m[2];
    } else {
      rest.push(word);
    }
  }
  return { body, query: rest.join(' ') };
}

/**
 * issue #250: streamed /ask output → Alfred items (an answer item with
 * large-type text plus one source item per citation). The ask script renders
 * whatever accumulated by stream end; no chat sessions from a launcher.
 */
export function toAlfredAskItems({ answer, citations, mode }) {
  const items = [];
  if (answer && answer.trim()) {
    items.push({
      title: `Answer${mode && mode !== 'extractive' ? ` (${mode})` : ''}`,
      subtitle: (answer || '').replace(/\s+/g, ' ').slice(0, 160),
      arg: '',
      text: { copy: answer, largetype: answer },
      valid: false,
    });
  } else if (mode === 'abstained') {
    items.push({
      title: 'No answer found in the notes',
      subtitle: 'The extractive answerer found nothing with enough query support (issue #238 abstention).',
      valid: false,
    });
  }
  for (const c of citations || []) {
    items.push({
      title: `${c.file}${c.heading ? ` › ${c.heading}` : ''}`,
      subtitle: `source [score ${(c.score ?? 0).toFixed(3)}]`,
      arg: c.file,
      type: 'file',
      valid: true,
    });
  }
  return { items };
}
