import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadIndex, searchIndex, SearchResultHit } from './search.js';
import { extractAnswerFallback } from './rag.js';
import { parseFilter, FilterNode } from './filter.js';

export interface TuiOptions {
  indexDir: string;
  cacheDir: string;
  db?: string;
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

  const render = () => {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    let buf = '';
    buf += '\x1b[?25l'; // hide cursor
    buf += '\x1b[H\x1b[J'; // clear screen from cursor down

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
      buf += `\x1b[1m--- Grounded Answer Synthesis & Citations ---\x1b[0m\n`;
      const answer = extractAnswerFallback(query, results);
      const answerLines = answer.split('\n');
      for (let i = 0; i < previewHeight; i++) {
        if (i < answerLines.length) {
          buf += `  ${answerLines[i].slice(0, cols - 3)}\n`;
        } else {
          buf += '\n';
        }
      }
    } else {
      buf += `\x1b[1m--- Passage Preview ---\x1b[0m\n`;
      const selectedHit = results[selectedIndex];
      if (selectedHit) {
        const textLines = selectedHit.snippet.split('\n');
        for (let i = 0; i < previewHeight; i++) {
          if (i < textLines.length) {
            buf += `  ${textLines[i].slice(0, cols - 3)}\n`;
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
          const editor = process.env.EDITOR || process.env.VISUAL || 'code';
          const filePath = path.resolve(db, hit.file);
          try {
            spawn(editor, [filePath], { stdio: 'inherit', detached: true });
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

      if (_str && _str.length === 1 && _str.charCodeAt(0) >= 32) {
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

