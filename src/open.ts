/**
 * Editor jump for search hits (issue #110): open a hit's file at its exact
 * `startLine` in $MDSS_EDITOR / $VISUAL / $EDITOR, with smart argument styles
 * for known editor families and a platform GUI opener as the last resort.
 *
 * Resolution is PURE (unit-testable); launching goes through an injected
 * runner so tests never spawn real processes.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface OpenTarget {
  file: string;
  line?: number;
}

export interface OpenCommand {
  command: string;
  args: string[];
  /** Human-readable source of the decision, e.g. "$EDITOR=vim" or "GUI opener". */
  via: string;
}

export interface ResolveOptions {
  /** $MDSS_EDITOR / $VISUAL / $EDITOR value, if any. */
  editor?: string | null;
  platform?: NodeJS.Platform;
}

export interface RunOptions extends ResolveOptions {
  runner?: OpenRunner;
}

export type OpenRunner = (
  command: string,
  args: string[],
  opts: { detached: boolean; stdio: 'ignore' }
) => unknown;

const VSCODE_FAMILY = /^(code|code-insiders|codium|cursor|windsurf)$/i;
/** Terminal editors taking a "+<line>" positional before the file. */
const PLUS_LINE_EDITORS = /^(vim|vi|nvim|nano|ne|emacs|emacsclient|micro|hx)$/i;

function baseName(cmd: string): string {
  // handle BOTH separators so a Windows full path resolves its family even
  // when mdss runs on POSIX CI (issue #110)
  const last = cmd.split(/[\\/]/).pop() ?? cmd;
  return last.replace(/\.(exe|cmd|bat)$/i, '');
}

function splitEditorCommand(editor: string): string[] {
  // A value containing a path separator is ONE binary path (Windows installs
  // live under "C:\Program Files\..."); only bare names may carry extra flags.
  if (/[/\\]/.test(editor)) return [editor];
  return editor.trim().split(/\s+/);
}

/**
 * Decide HOW to open `target`.
 * - editor given: first token is the binary, remaining tokens are forwarded
 *   verbatim. VS Code family gets `--goto file:line`, plus-line editors get
 *   `+<line> file`, anything else just gets the file.
 * - No editor configured → platform GUI opener (win32 `cmd /c start ""`,
 *   darwin `open`, else `xdg-open`); a line cannot be passed there.
 * Returns null only on an unsupported platform without an editor.
 */
export function resolveOpenCommand(target: OpenTarget, opts: ResolveOptions = {}): OpenCommand | null {
  const { editor, platform = process.platform } = opts;
  const line = Number.isInteger(target.line) && (target.line as number) > 0 ? target.line : undefined;

  if (editor && editor.trim()) {
    const parts = splitEditorCommand(editor.trim());
    const command = parts[0];
    const extra = parts.slice(1);
    const name = baseName(command);
    if (VSCODE_FAMILY.test(name)) {
      return {
        command,
        args: [...extra, '--goto', `${target.file}${line ? `:${line}` : ''}`],
        via: `$EDITOR=${editor}`,
      };
    }
    if (PLUS_LINE_EDITORS.test(name)) {
      return { command, args: [...extra, ...(line ? [`+${line}`] : []), target.file], via: `$EDITOR=${editor}` };
    }
    return { command, args: [...extra, target.file], via: `$EDITOR=${editor}` };
  }

  if (platform === 'win32') {
    // empty title arg prevents `start` from mangling quoted paths
    return { command: 'cmd', args: ['/c', 'start', '', target.file], via: 'GUI opener' };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [target.file], via: 'GUI opener' };
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return { command: 'xdg-open', args: [target.file], via: 'GUI opener' };
  }
  return null;
}

/** Launch via the default detached spawn; inject a fake in tests. */
export function defaultOpenRunner(command: string, args: string[], opts: { detached: boolean; stdio: 'ignore' }): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Resolve + run. Returns the OpenCommand used (or null when nothing could be
 * resolved). Throws when the runner reports a launch failure — callers turn
 * that into a friendly die().
 */
export function openHit(target: OpenTarget, opts: RunOptions = {}): OpenCommand | null {
  const { runner = defaultOpenRunner, ...resolveOpts } = opts;
  const resolved = resolveOpenCommand(target, resolveOpts);
  if (!resolved) return null;
  runner(resolved.command, resolved.args, { detached: true, stdio: 'ignore' });
  return resolved;
}
