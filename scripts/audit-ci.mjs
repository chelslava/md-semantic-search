// @ts-check
import { execSync } from 'node:child_process';

/**
 * Supply-chain audit gate (issues #17 and #122).
 *
 * Runs `npm audit --omit=dev --json` and fails on any high/critical finding
 * EXCEPT the explicitly waived ones below. This runs as a HARD gate in CI
 * (including a weekly scheduled run) and before every `npm publish`.
 *
 * The baseline is currently clean: `@huggingface/transformers` 4.3.x resolves
 * the former adm-zip (via onnxruntime-node 1.30.x) and sharp 0.35.x advisories,
 * so the waiver list below is empty. Keep the mechanism ready — see SECURITY.md
 * (Supply-Chain section) for the triage protocol.
 *
 * Waiver rules (issue #122):
 *  - every waiver MUST carry `reason` and `expires: 'YYYY-MM-DD'`;
 *  - an EXPIRED waiver fails loudly instead of silently suppressing, forcing
 *    a conscious re-triage;
 *  - re-review dates are tracked in SECURITY.md (Supply-Chain section).
 */
const WAIVED_ADVISORIES = [];

function expired(w) {
  return Date.parse(w.expires) < Date.now();
}

try {
  const stdout = execSync('npm audit --omit=dev --json', { encoding: 'utf8' });
  JSON.parse(stdout);
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
  } catch {
    console.error('Failed to parse npm audit JSON output:', stdout);
    process.exit(1);
  }

  const vulnerabilities = report.vulnerabilities || {};
  let unexpectedCount = 0;
  let waivedCount = 0;

  for (const [name, vuln] of Object.entries(vulnerabilities)) {
    if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
    for (const item of vuln.via || []) {
      if (typeof item !== 'object' || !item.url) continue;
      const advisoryId = item.url.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? null;
      const waiver = advisoryId ? WAIVED_ADVISORIES.find((w) => w.id === advisoryId) : null;

      if (waiver && !expired(waiver)) {
        waivedCount += 1;
        console.log(`[WAIVED] ${advisoryId} in ${name} — ${waiver.reason} (expires ${waiver.expires})`);
      } else if (waiver && expired(waiver)) {
        console.error(`[EXPIRED WAIVER] ${advisoryId} in ${name}: waiver expired ${waiver.expires} — re-triage required`);
        unexpectedCount++;
      } else {
        console.error(`[NEW VULNERABILITY] High/Critical advisory ${advisoryId || item.url} found in ${name}!`);
        unexpectedCount++;
      }
    }
  }

  if (unexpectedCount > 0) {
    console.error(`\nSecurity audit FAILED: ${unexpectedCount} unwaived/expired high+critical finding(s).`);
    process.exit(1);
  }

  console.log(`\nSecurity audit passed: ${waivedCount} finding(s) covered by active waivers.`);
  process.exit(0);
}
