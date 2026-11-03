#!/usr/bin/env node
/**
 * Real chat-backend smoke (issue #199 follow-up): probes an actual
 * llama.cpp / LM Studio / vLLM / Ollama endpoint with the production
 * streaming parser from dist/providers.js — the unit tests run against
 * fake SSE servers, this one exercises real HTTP chunking and framing.
 *
 * Usage:
 *   node scripts/smoke-chat-backend.mjs --endpoint http://127.0.0.1:8080/v1
 *   node scripts/smoke-chat-backend.mjs --endpoint http://127.0.0.1:11434 \
 *        --provider ollama --model llama3
 *
 * Prints time-to-first-token and total, exits 0 when at least one delta
 * arrived and the assembled text is non-empty; 1 otherwise (also on HTTP
 * errors or a whole-probe timeout — a hung backend must fail the smoke,
 * not hang it).
 *
 * CI: runs in the nightly workflow only when the repository variable
 * MDSS_SMOKE_ENDPOINT is set (a backend reachable from the runner).
 */
import { resolveChatProvider } from '../dist/providers.js';

function argValue(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const endpoint = argValue('--endpoint', process.argv) || process.env.MDSS_SMOKE_ENDPOINT;
const provider = argValue('--provider', process.argv) || 'openai';
const model = argValue('--model', process.argv);
const timeoutMs = Number(argValue('--timeout-ms', process.argv)) || 30_000;

if (!endpoint) {
  process.stderr.write('usage: node scripts/smoke-chat-backend.mjs --endpoint <url> [--provider openai|ollama] [--model <name>] [--timeout-ms <ms>]\n');
  process.exit(2);
}
if (!['openai', 'ollama'].includes(provider)) {
  process.stderr.write(`unknown --provider "${provider}" - use openai|ollama\n`);
  process.exit(2);
}

const controller = new AbortController();
const kill = setTimeout(() => controller.abort(new Error(`smoke timed out after ${timeoutMs}ms`)), timeoutMs);

const chat = resolveChatProvider({
  provider,
  ...(model ? { model } : {}),
  baseUrl: endpoint,
});

let firstDeltaAt = null;
let deltaCount = 0;
const t0 = Date.now();
try {
  const full = await chat.complete({
    system: 'You are a smoke test. Answer with one short sentence.',
    user: 'Say "smoke ok" and nothing else.',
    signal: controller.signal,
    onDelta: () => {
      deltaCount++;
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
    },
  });

  const ttft = firstDeltaAt !== null ? firstDeltaAt - t0 : null;
  const total = Date.now() - t0;
  const ok = deltaCount > 0 && typeof full === 'string' && full.trim().length > 0;

  process.stdout.write(`endpoint : ${endpoint} (${provider}${model ? `, model ${model}` : ''})\n`);
  process.stdout.write(`deltas   : ${deltaCount}\n`);
  process.stdout.write(`TTFT     : ${ttft !== null ? `${ttft} ms` : 'n/a (no deltas)'}\n`);
  process.stdout.write(`total    : ${total} ms\n`);
  process.stdout.write(`answer   : ${JSON.stringify(String(full).slice(0, 200))}\n`);
  process.stdout.write(ok ? 'SMOKE OK\n' : 'SMOKE FAIL: no usable deltas or empty answer\n');
  process.exit(ok ? 0 : 1);
} catch (e) {
  kill.clearTimeout?.();
  process.stderr.write(`SMOKE FAIL: ${e?.message || e}\n`);
  process.exit(1);
} finally {
  clearTimeout(kill);
}
