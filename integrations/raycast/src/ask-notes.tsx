/**
 * Raycast Ask Notes Command (issue #250) — launcher parity with the
 * Obsidian/VS Code clients: one-shot grounded QA over the daemon's streamed
 * POST /ask (SSE), rendered into a Detail view as tokens arrive. No chat
 * sessions from a launcher — one-shot asks keep the model simple.
 */
import React, { useState, useEffect, useRef } from 'react';
import { Detail, getPreferenceValues, showToast, Toast } from '@raycast/api';
import { buildAskRequest, renderAskDetail } from './helpers.mjs';

interface Preferences {
  daemonUrl?: string;
  apiKey?: string;
}

interface AskFrame {
  event: string;
  data: any;
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const daemonUrl = preferences.daemonUrl || 'http://127.0.0.1:8747';
  const apiKey = preferences.apiKey || undefined;
  const askQuery = decodeURIComponent(window.location.search.replace(/^\?q=/, '')) || 'What do my notes cover?';

  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<Array<{ file: string; heading?: string }>>([]);
  const [mode, setMode] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const bufferRef = useRef('');

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const resp = await fetch(`${daemonUrl.replace(/\/$/, '')}/ask`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(buildAskRequest(askQuery)),
        });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bufferRef.current += decoder.decode(value, { stream: true });
          // the same minimal frame split the shared client pins (issue #199)
          let idx: number;
          while ((idx = bufferRef.current.indexOf('\n\n')) !== -1) {
            const frame = bufferRef.current.slice(0, idx);
            bufferRef.current = bufferRef.current.slice(idx + 2);
            const lines = frame.split('\n');
            const eventName = (lines.find((l) => l.startsWith('event:')) || '').slice(7).trim();
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (!dataLine || !eventName) continue;
            let obj: any;
            try {
              obj = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (eventName === 'sources') {
              setSources(obj.citations || []);
            } else if (eventName === 'delta') {
              setAnswer((prev) => prev + (obj.text || ''));
            } else if (eventName === 'done') {
              setAnswer(obj.answer || '');
              setMode(obj.mode);
              setIsLoading(false);
            }
          }
        }
        setIsLoading(false);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setError(err.message);
          showToast({ style: Toast.Style.Failure, title: 'Ask Failed', message: err.message });
          setIsLoading(false);
        }
      }
    })();
    return () => controller.abort();
  }, [askQuery, daemonUrl, apiKey]);

  if (error) {
    return <Detail markdown={`**Ask failed**: ${error}\n\nIs \`mdss serve --db …\` running?`} />;
  }

  return (
    <Detail
      isLoading={isLoading}
      markdown={renderAskDetail({ answer, sources, mode })}
      navigationTitle={askQuery}
    />
  );
}
