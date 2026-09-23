#!/usr/bin/env node
// OWNER: assets agent. Dev-time helper: download the free uploads of an itch.io asset page (CC0 packs such as
// Quaternius / Kenney) the same way the "No thanks, just take me to the downloads" button does.
// Usage: node src/assets/fetch/itch-download.mjs <itch-game-url> <outDir> [nameRegex]
import fs from 'node:fs';
import path from 'node:path';

const [game, outDir, filter] = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const jar = new Map();
async function req(url, opts = {}) {
  const headers = { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(opts.headers ?? {}) };
  const r = await fetch(url, { ...opts, headers, redirect: opts.redirect ?? 'follow' });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return r;
}
const csrf = (h) => h.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? h.match(/csrf_token" value="([^"]+)"/)?.[1];
const post = (url, token) => req(url, { method: 'POST', body: new URLSearchParams({ csrf_token: token }), headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' } });

const page = await (await req(game)).text();
const dl = await (await post(`${game}/download_url`, csrf(page))).json();
const dlPage = await (await req(dl.url)).text();
const key = decodeURIComponent(dl.url.split('/download/')[1]);
console.log('key', key);
const tok = csrf(dlPage);
const ups = [...dlPage.matchAll(/data-upload_id="(\d+)"[\s\S]*?<strong title="([^"]*)"/g)].map((m) => ({ id: m[1], name: m[2] }));
console.log('uploads:', ups.map((u) => u.name).join(' | '));
fs.mkdirSync(outDir, { recursive: true });
for (const u of ups) {
  if (filter && !new RegExp(filter, 'i').test(u.name)) continue;
  let j = {};
  for (const [qs, body] of [[`?source=game_download&key=${encodeURIComponent(key)}`, {}], ['', { key }], [`?key=${encodeURIComponent(key)}`, {}], [`?source=game_download&key=${key}`, { key }]]) {
    j = await (await req(`${game}/file/${u.id}${qs}`, { method: 'POST', body: new URLSearchParams({ csrf_token: tok, ...body }), headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Referer: dl.url } })).json();
    if (j.url) break; console.log('variant fail', qs, JSON.stringify(body), JSON.stringify(j));
  }
  if (!j.url) { console.warn('fail', u.name, JSON.stringify(j)); continue; }
  const r = await fetch(j.url, { headers: { 'User-Agent': UA } });
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(outDir, u.name), buf);
  console.log('got', u.name, (buf.length / 1e6).toFixed(1), 'MB');
}
