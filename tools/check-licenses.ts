// Verifies every file under public/assets is covered by an entry in public/assets/LICENSES.json
// and that every entry is CC0 / public domain. Exit code 1 on any gap.
// Usage: node --experimental-strip-types tools/check-licenses.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public', 'assets');
const OPEN = /^(CC0|CC0-1\.0|public[- ]domain|PD)$/i;

interface Entry { path: string; id?: string; license?: string; source?: string }
const manifest = JSON.parse(readFileSync(join(ROOT, 'LICENSES.json'), 'utf8')) as { assets: Entry[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(relative(ROOT, p).split('\\').join('/'));
  }
  return out;
}

const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');

/** Expand an entry's `path` field into matchers. Supports "dir/", exact files, globs, comma lists where
 *  later items inherit the first item's directory, and "name.ext1/.ext2" extension shorthands. */
function matchers(e: Entry): ((f: string) => boolean)[] {
  const parts = e.path.split(',').map((s) => s.trim()).filter(Boolean);
  const baseDir = parts[0].includes('/') && !parts[0].endsWith('/') ? dirname(parts[0]) + '/' : '';
  const out: ((f: string) => boolean)[] = [];
  for (let raw of parts) {
    if (!raw.includes('/') || /^[^/]+\.[a-z0-9]+\/\./i.test(raw)) raw = baseDir + raw;
    // audio/ style shared-folder entries: match by sound stem against the id list
    if (raw === 'audio/' && e.id) {
      const stems = new Set(e.id.split(',').map((s) => s.trim()));
      out.push((f) => f.startsWith('audio/') && stems.has(basename(f).replace(/_\d+\.(ogg|mp3|wav)$/i, '')));
      continue;
    }
    if (raw.endsWith('/')) { out.push((f) => f.startsWith(raw)); continue; }
    const ext = raw.match(/^(.*?)(\.[a-z0-9]+)((?:\/\.[a-z0-9]+)+)$/i);
    const pats = ext ? [ext[1] + ext[2], ...ext[3].split('/').filter(Boolean).map((x) => ext[1] + x)] : [raw];
    for (const p of pats) { const re = globRe(p); out.push((f) => re.test(f)); }
  }
  return out;
}

const files = walk(ROOT).filter((f) => f !== 'LICENSES.json');
const all = manifest.assets.map((e) => ({ e, m: matchers(e) }));
const uncovered = files.filter((f) => !all.some(({ m }) => m.some((fn) => fn(f))));
const unused = all.filter(({ m }) => !files.some((f) => m.some((fn) => fn(f)))).map(({ e }) => e.path);
const notOpen = manifest.assets.filter((e) => !OPEN.test(String(e.license ?? '').trim()));

console.log(`${files.length} asset files, ${manifest.assets.length} manifest entries`);
if (uncovered.length) console.log(`\nUNCOVERED (${uncovered.length}):\n  ` + uncovered.join('\n  '));
if (unused.length) console.log(`\nENTRIES MATCHING NO FILE (${unused.length}):\n  ` + unused.join('\n  '));
if (notOpen.length) console.log(`\nNOT CC0/PD (${notOpen.length}):\n  ` + notOpen.map((e) => `${e.path}: ${e.license}`).join('\n  '));
if (uncovered.length || notOpen.length) process.exit(1);
console.log('OK: every asset is covered by a CC0 / public-domain entry.');
