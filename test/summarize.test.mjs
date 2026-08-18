import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeyphraseTags, summarizePassage, analyzeNote } from '../dist/summarize.js';

test('summarize: extractKeyphraseTags extracts frequent and heading-salient keywords', () => {
  const markdown = `# Architecture Overview\n\nMicroservices communicate via Kafka event streams. Kafka events provide high-throughput messaging.\n`;
  const tags = extractKeyphraseTags(markdown, 4);

  assert.ok(tags.length > 0);
  assert.ok(tags.includes('kafka') || tags.includes('architecture') || tags.includes('microservices'));
});

test('summarize: summarizePassage produces concise representative sentences', () => {
  const markdown = `
# Distributed Storage Architecture

The distributed storage engine stores data across three replica nodes with Raft consensus.
Whenever a write request arrives, the leader replicates the log entry to followers.
This design guarantees strong consistency and partition tolerance.
`;

  const summary = summarizePassage(markdown, 2);
  assert.ok(summary.length > 0);
  assert.ok(summary.includes('distributed storage') || summary.includes('Raft consensus') || summary.includes('replica'));
});

test('summarize: analyzeNote returns combined tags and summary', () => {
  const note = `# Incident Response Playbook\n\nWhen a high severity alert triggers, notify the on-call engineer immediately. Follow the escalation matrix.\n`;
  const analysis = analyzeNote(note);

  assert.ok(Array.isArray(analysis.tags));
  assert.ok(analysis.tags.length > 0);
  assert.ok(typeof analysis.summary === 'string');
});
