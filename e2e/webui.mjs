/**
 * Playwright smoke for the built-in web UI (issue #111).
 *
 * Runs ONLY when the `playwright` package is installed locally
 * (`npm i -D playwright && npx playwright install chromium`) — the repo itself
 * stays dependency-free, and CI runs this via the opt-in `ui-smoke` workflow.
 *
 *   node e2e/webui.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    console.log('playwright not installed — skipping web UI smoke (npm i -D playwright to enable)');
    return 0;
  }

  const { buildIndex } = await import('../dist/indexer.js');
  const { createServe } = await import('../dist/serve.js');

  const fakeEmbed = (texts) => texts.map((t) => {
    const dim = 8;
    const v = new Array(dim).fill(0);
    const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) {
      let h = 7;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % dim] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdss-e2e-'));
  const idx = path.join(dir, '.mdss');
  fs.writeFileSync(path.join(dir, 'a.md'), '# Coffee\n\ncoffee beans roasted ground notes here\n');
  await buildIndex({ db: dir, indexDir: idx, cacheDir: path.join(dir, '.c'), modelName: 'e5-base', embedFn: fakeEmbed });
  const svc = await createServe({ indexDir: idx, cacheDir: path.join(dir, '.c'), embedFn: fakeEmbed });
  await new Promise((r) => svc.server.listen(0, r));
  const url = `http://127.0.0.1:${svc.server.address().port}`;

  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.fill('#q', 'coffee');
    await page.waitForSelector('#results li', { timeout: 10000 });
    const marks = await page.locator('#results mark').count();
    console.log(`webui smoke OK: results rendered (${marks} highlighted terms)`);
    return 0;
  } finally {
    await browser.close();
    await svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); },
);
