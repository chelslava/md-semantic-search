import readline from 'node:readline';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadIndex, searchIndex, SearchResultHit } from './search.js';
import { ModelDescriptor } from './core.js';

export interface TuiOptions {
  indexDir: string;
  cacheDir: string;
  db?: string;
  query?: string;
  k?: number;
  semanticOnly?: boolean;
  offline?: boolean;
  path?: string | string[];
  rerank?: boolean;
  rerankPool?: number;
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
  let selectedIndex = 0;
  let results: SearchResultHit[] = [];
  let searching = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const performSearch = async () => {
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

  const render = () => {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    let buf = '';
    buf += '\x1b[?25l'; // hide cursor
    buf += '\x1b[H\x1b[J'; // clear screen from cursor down

    // Header
    const searchStatus = searching ? ' [searching...]' : '';
    const headerStr = ` mdss interactive search | Query: ${query}${searchStatus}`;
    buf += `\x1b[7m${headerStr.padEnd(cols).slice(0, cols)}\x1b[0m\n`;

    // Calculate layout heights
    const listHeight = Math.max(4, Math.floor((rows - 4) * 0.4));
    const previewHeight = Math.max(4, rows - 4 - listHeight);

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

    // Render Preview
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

    // Footer
    const footerStr = ' [Up/Down/j/k]: Navigate | [Enter]: Open in Editor | [Esc/q/Ctrl+C]: Quit';
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
      if (key.name === 'escape' || (key.name === 'q' && query === '')) {
        cleanupTui();
        process.removeListener('keypress', onKeypress);
        resolve(null);
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
        if (query.length > 0) {
          query = query.slice(0, -1);
          scheduleSearch();
          render();
        }
        return;
      }

      if (_str && _str.length === 1 && _str.charCodeAt(0) >= 32) {
        query += _str;
        scheduleSearch();
        render();
      }
    };

    process.stdin.on('keypress', onKeypress);

    // Initial search and render
    performSearch();
  });
}
