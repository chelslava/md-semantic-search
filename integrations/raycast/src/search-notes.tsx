/**
 * Raycast Search Notes Command (issue #99).
 *
 * Issue #230 parity: daemon configuration matches the other launchers —
 * `daemonUrl` preference plus an optional `apiKey` preference (Bearer auth
 * for `mdss serve --api-key`), and the response parsing / list-item shaping
 * goes through the pure helpers in src/helpers.mjs (unit-tested in
 * test/raycast.test.mjs).
 */
import React, { useState, useEffect } from 'react';
import { List, ActionPanel, Action, getPreferenceValues, showToast, Toast } from '@raycast/api';
import { buildSearchRequestWithFilters, parseSearchResponse, toListItem, SEARCH_DEBOUNCE_MS } from './helpers.mjs';

interface SearchHit {
  file: string;
  title: string;
  heading: string;
  cosine: number;
  score: number;
  snippet: string;
  vault?: string;
}

interface Preferences {
  daemonUrl?: string;
  apiKey?: string;
  /** issue #250: filter preferences — empty values are omitted from the body */
  tagFilter?: string;
  typeFilter?: string;
  statusFilter?: string;
}

export default function Command() {
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const preferences = getPreferenceValues<Preferences>();
  const daemonUrl = preferences.daemonUrl || 'http://127.0.0.1:8747';
  const apiKey = preferences.apiKey || undefined;

  useEffect(() => {
    if (!searchText.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const resp = await fetch(`${daemonUrl.replace(/\/$/, '')}/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify(
          buildSearchRequestWithFilters(searchText, {
            tag: preferences.tagFilter,
            type: preferences.typeFilter,
            status: preferences.statusFilter,
          }),
        ),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setResults(parseSearchResponse(await resp.json()) as SearchHit[]);
      } catch (err: any) {
        showToast({ style: Toast.Style.Failure, title: 'Search Failed', message: err.message });
      } finally {
        setIsLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchText, daemonUrl, apiKey, preferences.tagFilter, preferences.typeFilter, preferences.statusFilter]);

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Semantic search across local Markdown notes..."
      isShowingDetail
    >
      {results.map((item) => {
        const vm = toListItem(item);
        return (
          <List.Item
            key={vm.key}
            title={vm.title}
            subtitle={vm.subtitle}
            accessories={[{ text: vm.accessory }]}
            detail={<List.Item.Detail markdown={vm.markdown} />}
            actions={
              <ActionPanel>
                <Action.Open title="Open Note" target={vm.openTarget} />
                <Action.CopyToClipboard title="Copy Snippet" content={vm.snippet} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
