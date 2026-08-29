import { App, ItemView, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  MDSSPluginSettings,
  buildSearchRequest,
  buildRelatedRequest,
  formatHitHeading,
  formatLinkTarget,
  formatScore,
  formatRelatedReason,
  formatRelatedScore,
  buildErrorMessage,
  buildServeCommand,
  splitMatches,
  testConnection,
  mergeSettings,
} from './helpers.mjs';

export {
  DEFAULT_SETTINGS,
  MDSSPluginSettings,
  mergeSettings,
  buildSearchRequest,
  buildRelatedRequest,
  formatHitHeading,
  formatLinkTarget,
  formatScore,
  formatRelatedReason,
  formatRelatedScore,
  buildErrorMessage,
  buildServeCommand,
  splitMatches,
  testConnection,
};

export const VIEW_TYPE_MDSS = 'mdss-search-view';
export const VIEW_TYPE_MDSS_RELATED = 'mdss-related-view';

export interface MDSSSearchResultHit {
  file: string;
  title: string;
  heading: string;
  cosine: number;
  score: number;
  matches: string[];
  snippet: string;
}

export interface MDSSRelatedHit {
  file: string;
  title?: string;
  score: number;
  reason: string;
}

function renderHighlightedText(container: HTMLElement, text: string, matches: string[]) {
  const segments = splitMatches(text, matches);
  for (const seg of segments) {
    if (seg.isMatch) {
      container.createEl('mark', { text: seg.text });
    } else {
      container.appendText(seg.text);
    }
  }
}

function getReasonClass(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (r.includes('bi-directional')) return 'mdss-reason-bidirectional';
  if (r.includes('backlink')) return 'mdss-reason-backlink';
  if (r.includes('outgoing')) return 'mdss-reason-outgoing';
  if (r.includes('2-hop')) return 'mdss-reason-2hop';
  return 'mdss-reason-semantic';
}

export class MDSSSearchView extends ItemView {
  plugin: MDSSPlugin;
  mode: 'search' | 'related' = 'search';
  searchTabBtn: HTMLButtonElement;
  relatedTabBtn: HTMLButtonElement;
  searchSectionEl: HTMLElement;
  relatedSectionEl: HTMLElement;
  resultsEl: HTMLElement;
  relatedResultsEl: HTMLElement;
  searchInput: HTMLInputElement;
  activeFileBadgeEl: HTMLElement;
  debounceTimer: number | null = null;
  relatedDebounceTimer: number | null = null;
  searchAbortController: AbortController | null = null;
  relatedAbortController: AbortController | null = null;
  searchSeq = 0;
  relatedSeq = 0;
  selectedIndex = -1;
  hits: MDSSSearchResultHit[] = [];
  relatedHits: MDSSRelatedHit[] = [];
  activeFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MDSSPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_MDSS;
  }

  getDisplayText() {
    return 'Semantic Search & Related';
  }

  getIcon() {
    return 'search';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('mdss-view-container');

    // 1. Mode Switcher Tabs
    const tabGroup = container.createEl('div', { cls: 'mdss-tab-container' });
    this.searchTabBtn = tabGroup.createEl('button', { text: 'Search', cls: 'mdss-tab-button is-active' });
    this.relatedTabBtn = tabGroup.createEl('button', { text: 'Related Notes', cls: 'mdss-tab-button' });

    this.searchTabBtn.addEventListener('click', () => this.setMode('search'));
    this.relatedTabBtn.addEventListener('click', () => this.setMode('related'));

    // 2. Search Section
    this.searchSectionEl = container.createEl('div', { cls: 'mdss-section-search' });
    const header = this.searchSectionEl.createEl('div', { cls: 'mdss-search-header' });
    this.searchInput = header.createEl('input', {
      type: 'text',
      placeholder: 'Search notes semantically...',
      cls: 'mdss-search-input',
    });

    this.searchInput.addEventListener('input', () => {
      if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => this.executeSearch(), 250);
    });

    this.searchInput.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowDown') {
        if (!this.hits.length) return;
        ev.preventDefault();
        this.setSelectedIndex(Math.min(this.hits.length - 1, this.selectedIndex + 1));
      } else if (ev.key === 'ArrowUp') {
        if (!this.hits.length) return;
        ev.preventDefault();
        this.setSelectedIndex(Math.max(0, this.selectedIndex - 1));
      } else if (ev.key === 'Enter') {
        if (this.hits.length > 0) {
          ev.preventDefault();
          const targetIdx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
          const hit = this.hits[targetIdx];
          if (hit) {
            this.openHit(hit);
          }
        }
      } else if (ev.key === 'Escape') {
        this.searchInput.blur();
      }
    });

    this.resultsEl = this.searchSectionEl.createEl('div', { cls: 'mdss-results-container' });

    // 3. Related Notes Section
    this.relatedSectionEl = container.createEl('div', { cls: 'mdss-section-related' });
    this.relatedSectionEl.style.display = 'none';

    this.activeFileBadgeEl = this.relatedSectionEl.createEl('div', { cls: 'mdss-active-file-badge' });
    this.activeFileBadgeEl.createEl('span', { text: 'Active:', cls: 'mdss-active-file-label' });
    const activeName = this.activeFileBadgeEl.createEl('span', { text: '(no active note)', cls: 'mdss-active-file-title' });

    this.relatedResultsEl = this.relatedSectionEl.createEl('div', { cls: 'mdss-results-container' });

    // 4. Register workspace active file listener
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        this.onActiveFileChange(file);
      })
    );

    const initialFile = this.app.workspace.getActiveFile();
    if (initialFile) {
      this.onActiveFileChange(initialFile);
    }
  }

  setMode(mode: 'search' | 'related') {
    this.mode = mode;
    if (mode === 'search') {
      this.searchTabBtn.addClass('is-active');
      this.relatedTabBtn.removeClass('is-active');
      this.searchSectionEl.style.display = '';
      this.relatedSectionEl.style.display = 'none';
      this.searchInput.focus();
    } else {
      this.searchTabBtn.removeClass('is-active');
      this.relatedTabBtn.addClass('is-active');
      this.searchSectionEl.style.display = 'none';
      this.relatedSectionEl.style.display = '';
      this.onActiveFileChange(this.app.workspace.getActiveFile());
    }
  }

  onActiveFileChange(file: TFile | null) {
    this.activeFile = file;
    const titleEl = this.activeFileBadgeEl?.querySelector('.mdss-active-file-title');
    if (titleEl) {
      titleEl.textContent = file ? file.path : '(no active note)';
    }

    if (this.mode !== 'related') return;

    if (this.relatedDebounceTimer !== null) window.clearTimeout(this.relatedDebounceTimer);
    this.relatedDebounceTimer = window.setTimeout(() => {
      this.executeRelated();
    }, 250);
  }

  setSelectedIndex(index: number) {
    const items = this.resultsEl.children;
    if (this.selectedIndex >= 0 && items[this.selectedIndex]) {
      items[this.selectedIndex].removeClass('is-selected');
    }
    this.selectedIndex = index;
    if (items[index]) {
      items[index].addClass('is-selected');
      (items[index] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }

  async openHit(hit: MDSSSearchResultHit | { file: string }) {
    const target = formatLinkTarget(hit);
    await this.app.workspace.openLinkText(target, '', false);
  }

  async executeSearch() {
    const query = this.searchInput.value.trim();
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }
    const currentSeq = ++this.searchSeq;
    this.resultsEl.empty();
    this.selectedIndex = -1;
    this.hits = [];
    if (!query) return;

    const loading = this.resultsEl.createEl('div', { text: 'Searching...', cls: 'mdss-loading' });
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.searchAbortController = abortController;

    try {
      const { url, headers, body } = buildSearchRequest(this.plugin.settings, query);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: abortController ? abortController.signal : undefined,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      if (currentSeq !== this.searchSeq) return;
      loading.remove();

      const hits: MDSSSearchResultHit[] = data.results || [];
      this.hits = hits;
      if (hits.length === 0) {
        const emptyEl = this.resultsEl.createEl('div', { cls: 'mdss-empty' });
        emptyEl.createEl('div', { text: 'No semantic matches found.' });
        emptyEl.createEl('small', {
          text: 'If this vault has not been indexed yet, run `mdss index` first.',
          cls: 'mdss-heading-name',
        });
        return;
      }

      for (const hit of hits) {
        const item = this.resultsEl.createEl('div', { cls: 'mdss-result-item' });
        const titleEl = item.createEl('div', { cls: 'mdss-result-title' });

        const fileSpan = titleEl.createEl('span', { cls: 'mdss-file-name' });
        renderHighlightedText(fileSpan, hit.file, hit.matches);

        if (hit.heading) {
          const headingSpan = titleEl.createEl('span', { cls: 'mdss-heading-name' });
          headingSpan.appendText(' › ');
          renderHighlightedText(headingSpan, hit.heading, hit.matches);
        }

        titleEl.createEl('span', {
          text: ` ${formatScore(hit)}`,
          cls: 'mdss-score',
        });

        const pct = Math.max(2, Math.min(100, Math.round((hit.cosine || 0) * 100)));
        const bar = item.createEl('div', { cls: 'mdss-bar' });
        const fill = bar.createEl('span', { cls: 'mdss-bar-fill' });
        fill.style.width = `${pct}%`;

        const snippetEl = item.createEl('div', { cls: 'mdss-snippet' });
        renderHighlightedText(snippetEl, hit.snippet, hit.matches);

        item.addEventListener('click', async () => {
          await this.openHit(hit);
        });
      }
    } catch (e: any) {
      if (currentSeq !== this.searchSeq) return;
      if (e && (e.name === 'AbortError' || e.message === 'The user aborted a request.' || e.code === 20)) return;
      loading.remove();
      const errCard = this.resultsEl.createEl('div', { cls: 'mdss-error' });
      errCard.createEl('div', { text: buildErrorMessage(e, this.plugin.settings) });

      const cmd = buildServeCommand(this.plugin.settings);
      const cmdBox = errCard.createEl('div', { cls: 'mdss-command-card' });
      cmdBox.createEl('code', { text: cmd, cls: 'mdss-command-code' });
      const copyBtn = cmdBox.createEl('button', { text: 'Copy', cls: 'mdss-copy-btn' });
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(cmd);
          copyBtn.setText('Copied!');
          setTimeout(() => copyBtn.setText('Copy'), 2000);
        } catch {
          copyBtn.setText('Failed');
        }
      });
    }
  }

  async executeRelated() {
    if (!this.activeFile) {
      this.relatedResultsEl.empty();
      const emptyEl = this.relatedResultsEl.createEl('div', { cls: 'mdss-empty' });
      emptyEl.createEl('div', { text: 'Open a Markdown note to discover related notes.' });
      return;
    }

    if (this.relatedAbortController) {
      this.relatedAbortController.abort();
      this.relatedAbortController = null;
    }
    const currentSeq = ++this.relatedSeq;
    this.relatedResultsEl.empty();
    this.relatedHits = [];

    const loading = this.relatedResultsEl.createEl('div', { text: 'Finding related notes...', cls: 'mdss-loading' });
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.relatedAbortController = abortController;

    try {
      const { url, headers, body } = buildRelatedRequest(this.plugin.settings, this.activeFile.path);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: abortController ? abortController.signal : undefined,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      if (currentSeq !== this.relatedSeq) return;
      loading.remove();

      const hits: MDSSRelatedHit[] = data.results || [];
      this.relatedHits = hits;
      if (hits.length === 0) {
        const emptyEl = this.relatedResultsEl.createEl('div', { cls: 'mdss-empty' });
        emptyEl.createEl('div', { text: `No related notes found for "${data.resolvedFile || this.activeFile.path}".` });
        emptyEl.createEl('small', {
          text: 'Notes are linked via backlinks, wikilinks, and dense semantic similarity.',
          cls: 'mdss-heading-name',
        });
        return;
      }

      for (const hit of hits) {
        const item = this.relatedResultsEl.createEl('div', { cls: 'mdss-result-item' });
        const titleEl = item.createEl('div', { cls: 'mdss-result-title' });

        titleEl.createEl('span', { text: hit.file, cls: 'mdss-file-name' });

        const reasonBadge = titleEl.createEl('span', {
          text: formatRelatedReason(hit.reason),
          cls: `mdss-reason-badge ${getReasonClass(hit.reason)}`,
        });

        titleEl.createEl('span', {
          text: ` ${formatRelatedScore(hit)}`,
          cls: 'mdss-score',
        });

        const pct = Math.max(2, Math.min(100, Math.round((hit.score || 0) * 100)));
        const bar = item.createEl('div', { cls: 'mdss-bar' });
        const fill = bar.createEl('span', { cls: 'mdss-bar-fill' });
        fill.style.width = `${pct}%`;

        if (hit.title && hit.title !== hit.file) {
          item.createEl('div', { text: `Title: ${hit.title}`, cls: 'mdss-snippet' });
        }

        item.addEventListener('click', async () => {
          await this.openHit({ file: hit.file });
        });
      }
    } catch (e: any) {
      if (currentSeq !== this.relatedSeq) return;
      if (e && (e.name === 'AbortError' || e.message === 'The user aborted a request.' || e.code === 20)) return;
      loading.remove();
      const errCard = this.relatedResultsEl.createEl('div', { cls: 'mdss-error' });
      errCard.createEl('div', { text: buildErrorMessage(e, this.plugin.settings) });

      const cmd = buildServeCommand(this.plugin.settings);
      const cmdBox = errCard.createEl('div', { cls: 'mdss-command-card' });
      cmdBox.createEl('code', { text: cmd, cls: 'mdss-command-code' });
      const copyBtn = cmdBox.createEl('button', { text: 'Copy', cls: 'mdss-copy-btn' });
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(cmd);
          copyBtn.setText('Copied!');
          setTimeout(() => copyBtn.setText('Copy'), 2000);
        } catch {
          copyBtn.setText('Failed');
        }
      });
    }
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (this.relatedDebounceTimer !== null) window.clearTimeout(this.relatedDebounceTimer);
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = null;
    }
    if (this.relatedAbortController) {
      this.relatedAbortController.abort();
      this.relatedAbortController = null;
    }
  }
}

export class MDSSSettingTab extends PluginSettingTab {
  plugin: MDSSPlugin;

  constructor(app: App, plugin: MDSSPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Markdown Semantic Search Settings' });

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Check if the mdss daemon is reachable and responding')
      .addButton((btn) => {
        btn.setButtonText('Test Connection').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Testing...');
          statusEl.setText('');
          statusEl.className = 'mdss-conn-status';
          try {
            const res = await testConnection(this.plugin.settings);
            if (res.ok) {
              statusEl.addClass('is-ok');
              statusEl.setText(`✓ ${res.message}`);
            } else {
              statusEl.addClass('is-error');
              statusEl.setText(`✗ ${res.message}`);
            }
          } catch (err: any) {
            statusEl.addClass('is-error');
            statusEl.setText(`✗ ${err.message}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Test Connection');
          }
        });
      });
    const statusEl = containerEl.createEl('div', { cls: 'mdss-conn-status' });

    new Setting(containerEl)
      .setName('Daemon Host')
      .setDesc('Host address of mdss serve')
      .addText((text) =>
        text
          .setPlaceholder('127.0.0.1')
          .setValue(this.plugin.settings.host)
          .onChange(async (value) => {
            this.plugin.settings.host = value.trim() || '127.0.0.1';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Daemon Port')
      .setDesc('Port number of mdss serve (default: 8747)')
      .addText((text) =>
        text
          .setPlaceholder('8747')
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = parseInt(value.trim(), 10);
            if (!isNaN(port) && port > 0) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Optional Bearer token if mdss serve requires authentication')
      .addText((text) =>
        text
          .setPlaceholder('API key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Results Count (k)')
      .setDesc('Number of top matches to retrieve')
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.k)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.k = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Semantic Only')
      .setDesc('Use pure dense vector similarity instead of hybrid BM25 + Vector ranking')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.semanticOnly).onChange(async (value) => {
          this.plugin.settings.semanticOnly = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Cross-Encoder Rerank')
      .setDesc('Re-score candidates with a cross-encoder model for highest precision')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.rerank).onChange(async (value) => {
          this.plugin.settings.rerank = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Approximate Nearest Neighbors (ANN)')
      .setDesc('Accelerate search on large vaults via IVF index clustering')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ann).onChange(async (value) => {
          this.plugin.settings.ann = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

export default class MDSSPlugin extends Plugin {
  settings: MDSSPluginSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_MDSS, (leaf) => new MDSSSearchView(leaf, this));

    this.addRibbonIcon('search', 'Semantic Search', () => {
      this.activateView('search');
    });

    this.addRibbonIcon('link', 'Related Notes', () => {
      this.activateView('related');
    });

    this.addCommand({
      id: 'open-semantic-search',
      name: 'Open semantic search panel',
      callback: () => {
        this.activateView('search');
      },
    });

    this.addCommand({
      id: 'open-related-notes',
      name: 'Open related notes panel',
      callback: () => {
        this.activateView('related');
      },
    });

    this.addSettingTab(new MDSSSettingTab(this.app, this));
  }

  async activateView(mode: 'search' | 'related' = 'search') {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_MDSS);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_MDSS, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof MDSSSearchView) {
        view.setMode(mode);
      }
    }
  }

  async loadSettings() {
    this.settings = mergeSettings(await this.loadData(), DEFAULT_SETTINGS);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

