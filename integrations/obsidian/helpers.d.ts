export interface MDSSPluginSettings {
  host: string;
  port: number;
  apiKey: string;
  k: number;
  semanticOnly: boolean;
  rerank: boolean;
  ann: boolean;
}

export declare const DEFAULT_SETTINGS: MDSSPluginSettings;

export declare function mergeSettings(
  stored: unknown,
  defaults?: MDSSPluginSettings
): MDSSPluginSettings;

export declare function buildSearchRequest(
  settings: Partial<MDSSPluginSettings> | undefined,
  query: string
): {
  url: string;
  headers: Record<string, string>;
  body: {
    query: string;
    k: number;
    semanticOnly: boolean;
    rerank: boolean;
    ann: boolean;
  };
};

export declare function buildRelatedRequest(
  settings: Partial<MDSSPluginSettings> | undefined,
  file: string,
  options?: {
    k?: number;
    direction?: 'both' | 'outgoing' | 'backlinks';
    semantic?: boolean;
  }
): {
  url: string;
  headers: Record<string, string>;
  body: {
    file: string;
    k: number;
    direction: string;
    semantic: boolean;
  };
};

export declare function formatRelatedReason(reason?: string): string;

export declare function formatRelatedScore(hit?: { score?: number }): string;

export declare function formatHitHeading(hit?: { file?: string; heading?: string }): string;

export declare function formatLinkTarget(hit?: { file?: string; heading?: string }): string;

export declare function formatScore(hit?: { cosine?: number; score?: number }): string;

export declare function buildErrorMessage(
  err: unknown,
  settings?: Partial<MDSSPluginSettings>
): string;

export declare function splitMatches(
  text: string,
  matches?: string[]
): Array<{ text: string; isMatch: boolean }>;

export declare function buildServeCommand(
  settings?: Partial<MDSSPluginSettings>,
  vaultPath?: string
): string;

export declare function testConnection(
  settings?: Partial<MDSSPluginSettings>,
  fetchImpl?: typeof globalThis.fetch
): Promise<{
  ok: boolean;
  status: number;
  message: string;
  data?: { chunks?: number; model?: string; [key: string]: unknown };
}>;

