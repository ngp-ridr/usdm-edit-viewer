/* ============================================================================
   tools/csp-hash.mjs
   Recompute the CSP hashes for EVERY inline script in index.html and rewrite
   the `script-src` list with them.

     node tools/csp-hash.mjs          # check; non-zero exit if stale
     node tools/csp-hash.mjs --write  # fix it in place

   ── Why this exists ────────────────────────────────────────────────────────
   Under a strict `script-src`, every inline script needs its own `'sha256-…'`.
   Change one byte of one of them — an editor re-indent is enough — and the
   browser blocks that script. Nothing throws.

   There are TWO inline scripts on this page, and the second one is easy to
   forget:

     1. the anti-flash theme boot — blocked means the theme flash comes back,
        and the page otherwise works perfectly, which is the quietest possible
        failure;

     2. the IMPORT MAP. `script-src` governs import maps too, and this page
        cannot work without one: `terra-draw-maplibre-gl-adapter` imports the
        bare specifier `"terra-draw"`, and with no bundler the import map is the
        only thing that resolves it. Blocked, and the editor never loads. This
        was found the first time the app booted, not by reading a spec.

   The kit's own single-hash recipe assumes the anti-flash block is the last
   `<script>` pair in the file, which is false here. This walks all of them.
   ========================================================================== */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const write = process.argv.includes('--write');
const html = readFileSync(PAGE, 'utf8');

/* Blank comments (preserving offsets) so the CSP block's own prose — which
   mentions <script> — is not mistaken for markup. */
const stripped = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

const inline = [];
for (const m of stripped.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/\bsrc\s*=/.test(m[1])) continue;                 // external: no hash needed
  const bodyStart = m.index + m[0].indexOf('>') + 1;
  const bodyEnd = m.index + m[0].length - '</script>'.length;
  const body = html.slice(bodyStart, bodyEnd);          // ORIGINAL bytes
  inline.push({
    what: /type\s*=\s*["']importmap["']/.test(m[1]) ? 'import map' : 'anti-flash boot',
    hash: 'sha256-' + createHash('sha256').update(body, 'utf8').digest('base64'),
  });
}

if (!inline.length) {
  console.error('[csp-hash] no inline <script> found — has index.html changed shape?');
  process.exit(2);
}

/* Operate ONLY inside the CSP meta tag's content attribute. The explanatory
   comment above it says the words "script-src" too, and an earlier version of
   this tool cheerfully rewrote that prose instead of the directive. */
const metaMatch = /<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)">/.exec(html);
if (!metaMatch) {
  console.error('[csp-hash] no Content-Security-Policy <meta> found');
  process.exit(2);
}
const cspMatch = /script-src ([^;]*);/.exec(metaMatch[1]);
if (!cspMatch) {
  console.error('[csp-hash] no script-src directive inside the CSP meta tag');
  process.exit(2);
}
const present = [...cspMatch[1].matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
const want = inline.map((i) => i.hash);

const same = present.length === want.length && present.every((h, i) => h === want[i]);
if (same) {
  console.log('[csp-hash] ok');
  for (const i of inline) console.log(`  ${i.what.padEnd(16)} ${i.hash}`);
  process.exit(0);
}

if (!write) {
  console.error('[csp-hash] STALE');
  for (const i of inline) console.error(`  need  ${i.what.padEnd(16)} ${i.hash}`);
  for (const h of present) if (!want.includes(h)) console.error(`  stale                  ${h}`);
  for (const h of want) if (!present.includes(h)) console.error(`  missing                ${h}`);
  console.error('  fix:  node tools/csp-hash.mjs --write');
  process.exit(1);
}

const rebuilt = `script-src 'self' ${want.map((h) => `'${h}'`).join(' ')};`;
const newMeta = metaMatch[0].replace(/script-src [^;]*;/, rebuilt);
writeFileSync(PAGE, html.replace(metaMatch[0], newMeta));
console.log('[csp-hash] updated script-src:');
for (const i of inline) console.log(`  ${i.what.padEnd(16)} ${i.hash}`);
