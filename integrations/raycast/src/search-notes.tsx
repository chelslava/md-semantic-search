/**
 * Raycast Search Notes Command (issue #99).
 */
import React, { useState, useEffect } from 'react';
import { List, ActionPanel, Action, getPreferenceValues, showToast, Toast } from '@raycast/api';

interface SearchHit {
  file: string;
  title: string;
  heading: string;
  cosine: number;
  score: number;
  snippet: string;
  vault?: string;
}

export default function Command() {
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const preferences = getPreferenceValues<{ daemonUrl?: string }>();
  const daemonUrl = preferences.daemonUrl || 'http://127.0.0.1:8747';

  useEffect(() => {
    if (!searchText.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const resp = await fetch(`${daemonUrl}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchText.trim(), k: 12 }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as SearchHit[];
        setResults(Array.isArray(data) ? data : []);
      } catch (err: any) {
        showToast({ style: Toast.Style.Failure, title: 'Search Failed', message: err.message });
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [searchText, daemonUrl]);

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Semantic search across local Markdown notes..."
      isShowingDetail
    >
      {results.map((item, index) => (
        <List.Item
          key={`${item.file}-${item.heading}-${index}`}
          title={item.title || item.file}
          subtitle={item.heading || item.file}
          accessories={[{ text: `cos: ${(item.cosine ?? item.score ?? 0).toFixed(3)}` }]}
          detail={
            <List.Item.Detail
              markdown={`# ${item.title}\n\n**File**: \`${item.file}\`${item.heading ? ` › **${item.heading}**` : ''}\n\n---\n\n${item.snippet}`}
            />
          }
          actions={
            <ActionPanel>
              <Action.Open title="Open Note" target={item.file} />
              <Action.CopyToClipboard title="Copy Snippet" content={item.snippet} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
