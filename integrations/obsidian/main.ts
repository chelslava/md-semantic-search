import { App, ItemView, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from 'obsidian';

export interface MDSSPluginSettings {
  host: string;
  port: number;
  apiKey: string;
  k: number;
  semanticOnly: boolean;
  rerank: boolean;
  ann: boolean;
}

export const DEFAULT_SETTINGS: MDSSPluginSettings = {
  host: '127.0.0.1',
  port: 8747,
  apiKey: '',
  k: 6,
  semanticOnly: false,
  rerank: false,
  ann: false,
};

export const VIEW_TYPE_MDSS = 'mdss-search-view';

export interface MDSSSearchResultHit {
  file: string;
  title: string;
  heading: string;
  cosine: number;
  score: number;
  matches: string[];
  snippet: string;
}

export class MDSSSearchView extends ItemView {
  plugin: MDSSPlugin;
  resultsEl: HTMLElement;
  searchInput: HTMLInputElement;
  debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MDSSPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_MDSS;
  }

  getDisplayText() {
    return 'Semantic Search';
  }

  getIcon() {
    return 'search';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('mdss-view-container');

    const header = container.createEl('div', { cls: 'mdss-search-header' });
    this.searchInput = header.createEl('input', {
      type: 'text',
      placeholder: 'Search notes semantically...',
      cls: 'mdss-search-input',
    });

    this.searchInput.addEventListener('input', () => {
      if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => this.executeSearch(), 250);
    });

    this.resultsEl = container.createEl('div', { cls: 'mdss-results-container' });
  }

  async executeSearch() {
    const query = this.searchInput.value.trim();
    this.resultsEl.empty();
    if (!query) return;

    const loading = this.resultsEl.createEl('div', { text: 'Searching...', cls: 'mdss-loading' });

    try {
      const { host, port, apiKey, k, semanticOnly, rerank, ann } = this.plugin.settings;
      const url = `http://${host}:${port}/search`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, k, semanticOnly, rerank, ann }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      loading.remove();

      const hits: MDSSSearchResultHit[] = data.results || [];
      if (hits.length === 0) {
        this.resultsEl.createEl('div', { text: 'No semantic matches found.', cls: 'mdss-empty' });
        return;
      }

      for (const hit of hits) {
        const item = this.resultsEl.createEl('div', { cls: 'mdss-result-item' });
        const titleEl = item.createEl('div', { cls: 'mdss-result-title' });
        titleEl.createEl('span', { text: hit.file, cls: 'mdss-file-name' });
        if (hit.heading) {
          titleEl.createEl('span', { text: ` › ${hit.heading}`, cls: 'mdss-heading-name' });
        }
        titleEl.createEl('span', {
          text: ` (cos: ${hit.cosine.toFixed(2)})`,
          cls: 'mdss-score',
        });

        item.createEl('div', { text: hit.snippet, cls: 'mdss-snippet' });

        item.addEventListener('click', async () => {
          const target = hit.heading ? `${hit.file}#${hit.heading}` : hit.file;
          await this.app.workspace.openLinkText(target, '', false);
        });
      }
    } catch (e: any) {
      loading.remove();
      this.resultsEl.createEl('div', {
        text: `Error connecting to mdss daemon: ${e.message}. Is \`mdss serve\` running?`,
        cls: 'mdss-error',
      });
    }
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
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
      this.activateView();
    });

    this.addCommand({
      id: 'open-semantic-search',
      name: 'Open semantic search panel',
      callback: () => {
        this.activateView();
      },
    });

    this.addSettingTab(new MDSSSettingTab(this.app, this));
  }

  async activateView() {
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
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
