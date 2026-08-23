/**
 * Built-in web UI assets for `mdss serve` (issue #111).
 *
 * Zero dependencies, zero build step: plain HTML + CSS + JS shipped as
 * compiled-in strings (`files` already includes src/ -> dist/). Split into
 * THREE assets so the CSP can stay strict (no inline script/style):
 *   GET /      -> WEBUI_HTML  (shell, references ./ui.js + ./ui.css)
 *   GET /ui.js -> WEBUI_JS    (all behaviour; addEventListener only, no eval)
 *   GET /ui.css-> WEBUI_CSS    (dark/light via prefers-color-scheme + override)
 */

export const WEBUI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mdss — semantic search</title>
<link rel="stylesheet" href="./ui.css">
<script src="./ui.js" defer></script>
</head>
<body>
<header>
  <div class="brand">mdss<span id="health" title="loading…"></span></div>
  <button id="theme" type="button" aria-label="toggle theme">◐</button>
</header>
<main>
  <div id="authbar" hidden>
    <input id="key" type="password" autocomplete="off" placeholder="API key (Bearer)">
    <button id="keysafe" type="button">Save</button>
    <span id="authmsg"></span>
  </div>
  <searchbox>
    <input id="q" type="search" autofocus
      placeholder='Search by meaning — press "/" to focus' autocomplete="off">
  </searchbox>
  <filters>
    <input id="f-tag"   placeholder="tag">
    <input id="f-type"   placeholder="type">
    <input id="f-status" placeholder="status">
    <input id="f-limit"  type="number" min="1" max="50" placeholder="max/file">
  </filters>
  <div id="meta"></div>
  <ol id="results"></ol>
</main>
<footer><code>POST /search</code> · <a href="/help">api</a> · mdss web ui</footer>
</body>
</html>`;

export const WEBUI_CSS = `/* mdss web ui (issue #111) — dark/light via prefers-color-scheme */
:root { color-scheme: light dark;
  --bg:#fbfbfd; --fg:#1c1e21; --mut:#6b7280; --acc:#2563eb; --line:#e5e7eb;
  --card:#ffffff; --mark:#fef08a; --bar:#dbeafe;
}
@media (prefers-color-scheme: dark) { :root {
  --bg:#0f1115; --fg:#e6e6e6; --mut:#9aa0aa; --acc:#60a5fa; --line:#262b33;
  --card:#161a21; --mark:#854d0e; --bar:#1e3a8a;
}}
:root[data-theme="dark"] { --bg:#0f1115; --fg:#e6e6e6; --mut:#9aa0aa; --acc:#60a5fa; --line:#262b33; --card:#161a21; --mark:#854d0e; --bar:#1e3a8a }
:root[data-theme="light"] { --bg:#fbfbfd; --fg:#1c1e21; --mut:#6b7280; --acc:#2563eb; --line:#e5e7eb; --card:#fff; --mark:#fef08a; --bar:#dbeafe }

* { box-sizing:border-box }
body { margin:0 auto; max-width:56rem; padding:0 1rem 3rem; background:var(--bg); color:var(--fg);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif }
header { display:flex; justify-content:space-between; align-items:center; padding:.9rem 0 }
.brand { font-weight:700; letter-spacing:.02em }
.brand span { margin-left:.6rem; font-weight:400; font-size:.8rem; color:var(--mut) }
#theme { background:none; border:1px solid var(--line); border-radius:.5rem; color:var(--fg);
  cursor:pointer; font-size:1rem; line-height:1; padding:.35rem .6rem }
#q { width:100%; font-size:1.05rem; padding:.75rem 1rem; border:1px solid var(--line);
  border-radius:.7rem; background:var(--card); color:var(--fg) }
#q:focus { outline:2px solid var(--acc); outline-offset:1px }
filters { display:flex; gap:.5rem; margin-top:.6rem; flex-wrap:wrap }
filters input { flex:1 1 7rem; min-width:0; padding:.4rem .6rem; border:1px solid var(--line);
  border-radius:.5rem; background:var(--card); color:var(--fg); font-size:.85rem }
#meta { color:var(--mut); font-size:.85rem; margin:.7rem 0 .2rem }
#results { list-style:none; margin:0; padding:0 }
#results li { border:1px solid var(--line); background:var(--card); border-radius:.7rem;
  padding:.7rem .9rem; margin-top:.6rem; cursor:pointer }
#results li.active { outline:2px solid var(--acc) }
.hit-head { display:flex; gap:.6rem; align-items:baseline }
.hit-title { font-weight:600 }
.hit-file { color:var(--acc); font-size:.82rem; white-space:nowrap }
.hit-path { color:var(--mut); font-size:.82rem }
mark { background:var(--mark); color:inherit; border-radius:.2rem; padding:0 .1em }
.bar { height:4px; background:var(--bar); border-radius:2px; margin:.45rem 0 .2rem; overflow:hidden }
.bar i { display:block; height:100%; background:var(--acc) }
.snippet { overflow:hidden; max-height:3.2em; transition:max-height .15s ease }
li.open .snippet { max-height:none }
.score { margin-left:auto; color:var(--mut); font-size:.78rem }
#authbar { display:flex; gap:.5rem; align-items:center; margin-bottom:.6rem;
  padding:.5rem .7rem; border:1px dashed var(--line); border-radius:.6rem }
#authbar[hidden] { display:none }
footer { margin-top:2rem; color:var(--mut); font-size:.8rem }
`;

export const WEBUI_JS = `/* mdss web ui behaviour (issue #111) — no frameworks, no eval */
(function () {
  'use strict';
  var q = document.getElementById('q');
  var resultsEl = document.getElementById('results');
  var meta = document.getElementById('meta');
  var healthEl = document.getElementById('health');
  var authbar = document.getElementById('authbar');
  var keyInput = document.getElementById('key');

  var KEY_STORE = 'mdss_key';
  var key = sessionStorage.getItem(KEY_STORE) || '';
  var activeIdx = -1;

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (key) h['Authorization'] = 'Bearer ' + key;
    return h;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function highlight(text, terms) {
    var safe = esc(text == null ? '' : text);
    if (!terms || !terms.length) return safe;
    var re = new RegExp('(' + terms.map(esc).join('|') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }
  function askKey(msg) {
    authbar.hidden = false;
    document.getElementById('authmsg').textContent = msg || '';
    keyInput.focus();
  }
  document.getElementById('keysafe').addEventListener('click', function () {
    key = keyInput.value.trim();
    sessionStorage.setItem(KEY_STORE, key);
    authbar.hidden = true;
    run();
  });

  function api(path, opts) {
    opts = opts || {};
    opts.headers = headers();
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { askKey('401 — this daemon requires an API key'); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function render(data, terms) {
    var rs = data.results || [];
    meta.textContent = rs.length ? (data.count + ' hit(s) for “' + data.query + '”') : 'No matches.';
    activeIdx = -1;
    resultsEl.innerHTML = '';
    rs.forEach(function (r, i) {
      var li = document.createElement('li');
      var pct = Math.max(2, Math.min(100, Math.round((r.cosine || 0) * 100)));
      var headPath = (r.headingPath || []).slice(0, -1).join(' › ');
      li.innerHTML =
        '<div class="hit-head"><span class="hit-title">' + highlight(r.title, terms) + '</span>' +
        '<span class="score">' + Number(r.cosine || 0).toFixed(3) + '</span></div>' +
        ((r.heading && r.heading !== r.title) ? '<div class="hit-path">' + highlight(headPath || r.heading, terms) + '</div>' : '') +
        '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="snippet">' + highlight(r.snippet, terms) + '</div>' +
        '<div class="hit-file">' + esc(r.file) + (r.startLine != null ? ':' + r.startLine : '') + '</div>';
      li.addEventListener('click', function () { li.classList.toggle('open'); });
      resultsEl.appendChild(li);
    });
  }

  var timer = null;
  function run() {
    var query = q.value.trim();
    if (!query) { resultsEl.innerHTML = ''; meta.textContent = ''; return; }
    var filters = {};
    ['f-tag', 'f-type', 'f-status'].forEach(function (id) {
      var v = document.getElementById(id).value.trim();
      if (v) filters[id.slice(2)] = v;           // f-tag -> tag …
    });
    var lim = parseInt(document.getElementById('f-limit').value, 10);
    if (lim > 0) filters.maxPerFile = lim;

    api('/search', { method: 'POST', body: JSON.stringify(Object.assign({ query: query, k: 20 }, filters)) })
      .then(function (data) {
        var lastTerms = (data.results || []).length
          ? (data.results[0].matches || []) : [];
        render(data, lastTerms);
      })
      .catch(function (e) { if (String(e.message) !== 'HTTP 401') meta.textContent = 'error: ' + e.message; });
  }
  q.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  document.querySelectorAll('filters input').forEach(function (el) {
    el.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 350); });
  });

  // keyboard-first: "/" focuses, arrows navigate, Enter toggles
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== q) { ev.preventDefault(); q.focus(); q.select(); return; }
    if (ev.key === 'Escape') { q.blur(); return; }
    var items = resultsEl.children;
    if (!items.length) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(Math.min(items.length - 1, activeIdx + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(Math.max(0, activeIdx - 1)); }
    else if (ev.key === 'Enter' && activeIdx >= 0) { items[activeIdx].classList.toggle('open'); }
  });
  function setActive(i) {
    var items = resultsEl.children;
    if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].classList.remove('active');
    activeIdx = i;
    if (items[i]) {
      items[i].classList.add('active');
      items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  // theme: follow system until user overrides (persisted)
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('mdss_theme'); } catch (e) {}
  if (saved) root.dataset.theme = saved;
  document.getElementById('theme').addEventListener('click', function () {
    var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var cur = root.dataset.theme || (sysDark ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('mdss_theme', next); } catch (e) {}
  });

  api('/health').then(function (h) {
    healthEl.textContent = h.chunks + ' chunks · ' + h.model;
  }).catch(function () { healthEl.textContent = ''; });
})();
`;
