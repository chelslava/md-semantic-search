import readline from 'node:readline';
import path from 'node:path';
import { loadIndex, searchIndex, SearchResultHit } from './search.js';
import { extractAnswerFallback, synthesizeAnswer } from './rag.js';
import { parseFilter, FilterNode } from './filter.js';
import { tokenize } from './lexical.js';
import { openHit } from './open.js';
import { ChatProviderId } from './providers.js';

// issue #249: display-width helpers — surrogate pairs (CJK, emoji) occupy
// two terminal cells, so char-count clipping miscalculates line lengths.
function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    w += cp > 0xffff ? 2 : 1;
  }
  return w;
}

function clipByWidth(str: string, width: number): string {
  let w = 0;
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    const cw = cp > 0xffff ? 2 : 1;
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

// issue #249: SGR term highlighting for the preview pane — the same terms the
// results list matches, wrapped in reverse video (the preview is plain text,
// so the spans stand out without nesting SGR state).
const SGR_REVERSE = '\x1b[7m';
const SGR_NORMAL = '\x1b[27m';

function highlightTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.replace(re, `${SGR_REVERSE}$1${SGR_NORMAL}`);
}

export interface TuiOptions {
  indexDir: string;
  cacheDir: string;
  db?: string;
  /** issue #249 test seam: the editor-launch runner (defaults to openHit's detached spawn). */
  openRunner?: (command: string, args: string[], opts: { detached: boolean; stdio: 'ignore' }) => void;
  query?: string;
  k?: number;
  semanticOnly?: boolean;
  offline?: boolean;
  path?: string | string[];
  since?: string | Date;
  filter?: string | FilterNode;
  tag?: string | string[];
  project?: string;
  type?: string;
  status?: string;
  graphBoost?: number;
  rerank?: boolean;
  rerankPool?: number;
  rag?: boolean;
  /** issue #199: stream a real LLM answer in the RAG panel when configured. */
  llmEndpoint?: string;
  llmModel?: string;
  llmProvider?: ChatProviderId;
  systemPrompt?: string;
  embedFn?: any;
  rerankFn?: any;
  debounceMs?: number;
}

export async function runTui(opts: TuiOptions): Promise<SearchResultHit | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('interactive TUI requires a TTY terminal stdin and stdout');
  }

  const loaded = loadIndex(opts.indexDir);
  const db = opts.db || loaded.index.db || process.cwd();
  let query = opts.query || '';
  let activeFilter = typeof opts.filter === 'string' ? opts.filter : '';
  let editingField: 'query' | 'filter' = 'query';
  let filterError: string | null = null;
  let selectedIndex = 0;
  let results: SearchResultHit[] = [];
  let searching = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  // issue #249: preview term highlighting + the `?`/F1 help overlay
  let previewTerms: string[] = [];
  let showHelp = false;

  const performSearch = async () => {
    if (activeFilter.trim()) {
      try {
        parseFilter(activeFilter.trim());
        filterError = null;
      } catch (err: any) {
        filterError = err?.message || 'invalid filter expression';
        results = [];
        selectedIndex = 0;
        render();
        return;
      }
    } else {
      filterError = null;
    }

    if (!query.trim()) {
      results = [];
      selectedIndex = 0;
      render();
      return;
    }
    searching = true;
    render();
    try {
      results = await searchIndex({
        loaded,
        cacheDir: opts.cacheDir,
        query: query.trim(),
        k: opts.k || 20,
        semanticOnly: opts.semanticOnly,
        offline: opts.offline,
        path: opts.path,
        since: opts.since,
        filter: activeFilter.trim() || opts.filter || undefined,
        tag: opts.tag,
        project: opts.project,
        type: opts.type,
        status: opts.status,
        graphBoost: opts.graphBoost,
        rerank: opts.rerank,
        rerankPool: opts.rerankPool,
        embedFn: opts.embedFn,
        rerankFn: opts.rerankFn,
      });
      if (selectedIndex >= results.length) {
        selectedIndex = Math.max(0, results.length - 1);
      }
    } catch {
      results = [];
    } finally {
      searching = false;
      render();
    }
  };

  const scheduleSearch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch();
    }, opts.debounceMs ?? 300);
  };

  let showRag = Boolean(opts.rag);

  // issue #199: streaming RAG synthesis state. One run per query — deltas
  // patch `ragText` and a throttled render repaints the panel mid-stream.
  let ragText: string | null = null;
  let ragKey = '';
  let ragBusy = false;
  let ragRenderTimer: NodeJS.Timeout | null = null;
  const scheduleRagRender = () => {
    if (ragRenderTimer) return;
    ragRenderTimer = setTimeout(() => {
      ragRenderTimer = null;
      render();
    }, 50);
    ragRenderTimer.unref?.();
  };
  const maybeStartRag = () => {
    if (!showRag || !opts.llmEndpoint || ragBusy) return;
    const q = query.trim();
    if (!q || q === ragKey) return;
    ragKey = q;
    ragBusy = true;
    ragText = null;
    synthesizeAnswer(q, results, {
      llmEndpoint: opts.llmEndpoint,
      llmModel: opts.llmModel,
      llmProvider: opts.llmProvider,
      systemPrompt: opts.systemPrompt,
      onDelta: (d) => {
        ragText = (ragText ?? '') + d;
        scheduleRagRender();
      },
    })
      .then((synth) => {
        ragText = synth.answer;
      })
      .catch(() => {
        ragText = extractAnswerFallback(q, results);
      })
      .finally(() => {
        ragBusy = false;
        scheduleRagRender();
      });
  };

  const render = () => {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    let buf = '';
    buf += '\x1b[?25l'; // hide cursor
    buf += '\x1b[H\x1b[J'; // clear screen from cursor down

    // issue #249: the `?`/F1 help overlay replaces the whole screen
    if (showHelp) {
      const bindings: Array<[string, string]> = [
        ['type', 'search-as-you-type (debounced live results)'],
        ['Ctrl+F', 'edit the filter expression (tag:eng AND status != archived)'],
        ['Up / Down', 'move the selection (Ctrl+J / Ctrl+K also work)'],
        ['Enter', 'open the selected hit in your editor (MDSS_EDITOR/VISUAL/$EDITOR, VS Code --goto, GUI opener)'],
        ['Tab', 'toggle the RAG QA panel (needs --rag; streams with --llm-endpoint)'],
        ['?', 'toggle this help (only while the query line is empty)'],
        ['Esc', 'quit'],
      ];
      buf += `\x1b[1m mdss TUI — key bindings\x1b[0m\n\n`;
      for (const [k, v] of bindings) {
        buf += `  \x1b[7m${k.padEnd(12)}\x1b[0m ${v}\n`;
      }
      buf += `\n\n\x1b[2m press ? or F1 again to return\x1b[0m`;
      process.stdout.write(buf);
      return;
    }

    // Header Line 1: Mode & Query
    const searchStatus = searching ? ' [searching...]' : '';
    const modeLabel = showRag ? 'RAG QA & Synthesis' : 'search';
    const queryCursor = editingField === 'query' ? ' ▍' : '';
    const headerStr = ` mdss interactive ${modeLabel} | [Q]uery: ${query}${queryCursor}${searchStatus}`;
    buf += `\x1b[7m${headerStr.padEnd(cols).slice(0, cols)}\x1b[0m\n`;

    // Header Line 2: Filter & Narrowing Status
    const filterCursor = editingField === 'filter' ? ' ▍' : '';
    const filterDisplay = activeFilter || '(none)';
    const tagDisplay = opts.tag ? ` | tag: ${Array.isArray(opts.tag) ? opts.tag.join(',') : opts.tag}` : '';
    const sinceDisplay = opts.since ? ` | since: ${opts.since}` : '';
    const errDisplay = filterError ? ` [Err: ${filterError}]` : '';
    const filterLineStr = ` [F]ilter (Ctrl+F): ${filterDisplay}${filterCursor}${errDisplay}${tagDisplay}${sinceDisplay}`;
    if (filterError) {
      buf += `\x1b[31;7m${filterLineStr.padEnd(cols).slice(0, cols)}\x1b[0m\n`;
    } else {
      buf += `\x1b[2;7m${filterLineStr.padEnd(cols).slice(0, cols)}\x1b[0m\n`;
    }

    // Calculate layout heights
    const listHeight = Math.max(3, Math.floor((rows - 5) * 0.35));
    const previewHeight = Math.max(4, rows - 5 - listHeight);

    // Render list
    buf += `\x1b[1m--- Results (${results.length}) ---\x1b[0m\n`;
    const listSlice = results.slice(0, listHeight);
    for (let i = 0; i < listHeight; i++) {
      if (i < listSlice.length) {
        const item = listSlice[i];
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? '> ' : '  ';
        const line = `${prefix}${i + 1}. [${item.score.toFixed(3)}] ${item.file} › ${item.heading || item.title}`;
        const clippedLine = line.slice(0, cols);
        if (isSelected) {
          buf += `\x1b[7m${clippedLine.padEnd(cols)}\x1b[0m\n`;
        } else {
          buf += `${clippedLine}\n`;
        }
      } else {
        buf += '~ \n';
      }
    }

    // Render Preview or RAG synthesis
    if (showRag) {
      maybeStartRag();
      buf += `\x1b[1m--- Grounded Answer Synthesis & Citations ---\x1b[0m\n`;
      const answer = ragText ?? extractAnswerFallback(query, results);
      const answerLines = answer.split('\n').map((l) => highlightTerms(l, previewTerms));
      for (let i = 0; i < previewHeight; i++) {
        if (i < answerLines.length) {
          buf += `  ${clipByWidth(answerLines[i], cols - 3)}\n`;
        } else {
          buf += '\n';
        }
      }
    } else {
      buf += `\x1b[1m--- Passage Preview ---\x1b[0m\n`;
      const selectedHit = results[selectedIndex];
      if (selectedHit) {
        const textLines = selectedHit.snippet.split('\n').map((l) => highlightTerms(l, previewTerms));
        for (let i = 0; i < previewHeight; i++) {
          if (i < textLines.length) {
            buf += `  ${clipByWidth(textLines[i], cols - 3)}\n`;
          } else {
            buf += '\n';
          }
        }
      } else {
        buf += '  (no passage selected)\n';
        for (let i = 1; i < previewHeight; i++) buf += '\n';
      }
    }

    // Footer
    const footerStr = ' [Tab]: Toggle QA | [Ctrl+F]: Filter | [Up/Down]: Select | [Enter]: Open | [Esc]: Quit';
    buf += `\x1b[7m${footerStr.padEnd(cols).slice(0, cols)}\x1b[0m`;

    process.stdout.write(buf);
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onResize = () => {
      render();
    };

    process.stdout.on('resize', onResize);

    const cleanupTui = () => {
      process.stdout.removeListener('resize', onResize);
      if (ragRenderTimer) {
        clearTimeout(ragRenderTimer);
        ragRenderTimer = null;
      }
      if (process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); // show cursor and clear
    };

    const onKeypress = (_str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanupTui();
        process.removeListener('keypress', onKeypress);
        resolve(null);
        return;
      }
      if (key.name === 'escape' || (key.name === 'q' && query === '' && !activeFilter)) {
        cleanupTui();
        process.removeListener('keypress', onKeypress);
        resolve(null);
        return;
      }

      if (key.ctrl && key.name === 'f') {
        editingField = editingField === 'query' ? 'filter' : 'query';
        render();
        return;
      }

      if (key.name === 'tab') {
        showRag = !showRag;
        render();
        return;
      }

      if (key.name === 'up' || (key.name === 'k' && key.ctrl)) {
        if (selectedIndex > 0) {
          selectedIndex--;
          render();
        }
        return;
      }
      if (key.name === 'down' || (key.name === 'j' && key.ctrl)) {
        if (selectedIndex < results.length - 1) {
          selectedIndex++;
          render();
        }
        return;
      }

      if (key.name === 'return') {
        if (editingField === 'filter') {
          editingField = 'query';
          performSearch();
          return;
        }
        const hit = results[selectedIndex];
        cleanupTui();
        process.removeListener('keypress', onKeypress);
        if (hit) {
          // issue #249: route through the shared opener — MDSS_EDITOR/VISUAL/
          // $EDITOR precedence, VS Code --goto, +line editors, and the GUI
          // opener fallback (identical to `search --open`)
          try {
            openHit(
              { file: path.resolve(db, hit.file), line: (hit as SearchResultHit & { startLine?: number }).startLine },
              {
                editor: process.env.MDSS_EDITOR || process.env.VISUAL || process.env.EDITOR,
                ...(opts.openRunner ? { runner: opts.openRunner } : {}),
              },
            );
          } catch {
            /* editor launch failed */
          }
        }
        resolve(hit || null);
        return;
      }

      if (key.name === 'backspace') {
        if (editingField === 'query') {
          if (query.length > 0) {
            query = query.slice(0, -1);
            scheduleSearch();
            render();
          }
        } else if (editingField === 'filter') {
          if (activeFilter.length > 0) {
            activeFilter = activeFilter.slice(0, -1);
            scheduleSearch();
            render();
          }
        }
        return;
      }

      // issue #249: the ?/F1 help overlay. '?' only toggles while the query
      // line is empty — mid-typing it stays a typeable character.
      if (key.name === 'f1' || (_str === '?' && query.length === 0 && editingField === 'query' && activeFilter.length === 0)) {
        showHelp = !showHelp;
        render();
        return;
      }
      if (showHelp) return; // any other key while the overlay is up does nothing

      // issue #249: accept whole graphemes — surrogate pairs (CJK, emoji) and
      // multi-unit keypress input were dropped by the old single-char guard.
      // Named keys (key.name set) stay exclusive to the handlers above.
      if (_str && !key.name && [..._str].every((ch) => ch.codePointAt(0)! >= 32)) {
        if (editingField === 'query') {
          query += _str;
          scheduleSearch();
          render();
        } else if (editingField === 'filter') {
          activeFilter += _str;
          scheduleSearch();
          render();
        }
      }
    };

    process.stdin.on('keypress', onKeypress);

    // Initial search and render
    performSearch();
  });
}

