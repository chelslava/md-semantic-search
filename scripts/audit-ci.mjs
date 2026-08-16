// @ts-check
import { execSync } from 'node:child_process';

/**
 * Baseline of known, currently unfixable transitive production advisories (issue #17).
 * Each entry includes advisory ID, package, rationale, and review date.
 */
const BASELINE_ADVISORIES = new Set([
  'GHSA-xcpc-8h2w-3j85', // adm-zip <0.6.0 via onnxruntime-node (crafted ZIP allocation)
  'GHSA-f88m-g3jw-g9cj', // sharp <0.35.0 via @huggingface/transformers (libvips image vulns)
]);

try {
  const stdout = execSync('npm audit --omit=dev --json', { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  console.log('npm audit completed cleanly. No vulnerabilities found.');
  process.exit(0);
} catch (err) {
  const stdout = err.stdout?.toString();
  if (!stdout) {
    console.error('Failed to run npm audit:', err.message);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (e) {
    console.error('Failed to parse npm audit JSON output:', stdout);
    process.exit(1);
  }

  const vulnerabilities = report.vulnerabilities || {};
  let unexpectedCount = 0;

  for (const [name, vuln] of Object.entries(vulnerabilities)) {
    const severity = vuln.severity;
    if (severity === 'high' || severity === 'critical') {
      const via = vuln.via || [];
      for (const item of via) {
        if (typeof item === 'object' && item.url) {
          const url = item.url;
          const advisoryMatch = url.match(/GHSA-[a-z0-9-]+/i);
          const advisoryId = advisoryMatch ? advisoryMatch[0] : null;

          if (advisoryId && BASELINE_ADVISORIES.has(advisoryId)) {
            console.log(`[BASELINE] Skipping baseline advisory ${advisoryId} in ${name} (${item.title || item.name})`);
          } else {
            console.error(`[NEW VULNERABILITY] High/Critical advisory ${advisoryId || url} found in ${name}!`);
            unexpectedCount++;
          }
        }
      }
    }
  }

  if (unexpectedCount > 0) {
    console.error(`\nSecurity audit failed: ${unexpectedCount} new high/critical vulnerabilities found outside baseline.`);
    process.exit(1);
  }

  console.log('\nSecurity audit passed: all findings match known baseline advisories.');
  process.exit(0);
}
