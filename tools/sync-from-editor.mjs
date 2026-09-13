/* ============================================================================
   USDM Edit Viewer · tools/sync-from-editor.mjs
   The ONE way bytes get from the USDM Editor into this repo, and the gate that
   proves they are still the same bytes.

     node tools/sync-from-editor.mjs --write [--source=../usdm-editor]
     node tools/sync-from-editor.mjs --check          # CI; exit 1 on any drift

   ── Why a vendored COPY and not an import ──────────────────────────────────
   The viewer reads the editor's DOM-free engine (topology, changeset, changes,
   delta, submit.verifyPackage), its colour and unit vocabularies, its boundary
   data and its style kit. None of that may be fetched from the editor's origin
   at runtime: this app runs under `default-src 'none'` with `script-src 'self'`
   and a `connect-src` of four named hosts, and adding a fifth to pull code
   would give up the one property the whole fleet is built on — no remote code.

   ── Why the copy sits under ONE prefix that MIRRORS the editor root ─────────
   Editor modules import their own vendored libraries by RELATIVE path:

     js/archive.js  →  '../vendor/hyparquet-1.28.2/hyparquet.esm.js'
     js/mdtext.js   →  '../vendor/style/vendor-esm/marked-18.0.10/marked.esm.js'
                       and a guarded import('../vendor/squire-rte-2.4.8/squire.mjs')
     js/layers.js   →  a lazy import('../vendor/pmtiles-4.5.0/pmtiles.esm.js')

   Copy `js/` somewhere without copying `vendor/` one level up from it and every
   one of those resolves to nothing. So the copy reproduces the editor's ROOT
   SHAPE under `vendor/usdm-editor/`:

     vendor/usdm-editor/js/      ← the 19 modules
     vendor/usdm-editor/vendor/  ← the libraries they reach for with '../vendor/'

   and every relative import inside the copy resolves unchanged. The style kit
   therefore lives at `vendor/usdm-editor/vendor/style/`, which is what this
   app's own `js/*` import the drawer, card, help and core modules from.

   ── The one exception: vendor/aoi/ is at the PAGE ROOT ─────────────────────
   `js/aois.js` names its TopoJSON files as PAGE-RELATIVE urls
   ('vendor/aoi/states.json') and `js/aoi.js` `fetch()`es them. Those resolve
   against the document, not the module, so they must sit at `vendor/aoi/`
   beside index.html — not under the mirror. That is why `vendor/aoi` appears
   twice in the layout and only once here (we copy it to the page root alone;
   nothing under `vendor/usdm-editor/` ever reads it).

   `climdiv.json` is deliberately NOT copied: the viewer resolves no climate
   division — proposals name states and tribal areas — and it is 392 KB. The
   `--check` import/data closure therefore treats it as allowed-absent.

   ── The rule ───────────────────────────────────────────────────────────────
   THE COPY IS NEVER EDITED. Not a comment, not a whitespace fix. Behaviour the
   viewer needs differently gets a small wrapper in `js/` that calls into the
   copy (`js/bands.js`'s punch, `js/recheck.js`'s grading, `js/map.js`'s
   composition of `createLayerStack`). A drifted copy is a copy nobody can
   re-sync, and re-syncing is how the viewer inherits an editor fix.

   `--check` is what makes that rule enforceable rather than aspirational:

     1. every listed file is present and its sha256 matches MANIFEST.json;
     2. nothing UNLISTED lives under vendor/usdm-editor/ (a hand-added file is
        drift the sha256 pass cannot see);
     3. IMPORT CLOSURE — every relative `import`/`import()` specifier in
        vendor/usdm-editor/js/*.js AND in js/*.js resolves to a file that
        exists. This is the check that catches "we vendored the modules but not
        the library one of them lazily imports", whose failure mode in the
        browser is a silent `.catch(() => null)`;
     4. the PAGE-RELATIVE data files named in js/aois.js exist at the page root.

   Exit codes: 0 ok · 1 drift (a real failure) · 2 usage/environment.
   ========================================================================== */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ══ THE MANIFEST ═══════════════════════════════════════════════════════════
   What is copied, and where it lands. `from` is relative to the editor repo
   root; `to` is relative to THIS repo root. A `dir` entry copies a whole
   directory tree, minus `skip`.

   Adding a module here means adding whatever it imports too — `--check`'s
   import closure will say so, by name, the moment you forget.
   ═══════════════════════════════════════════════════════════════════════════ */

/** The 19 editor modules the viewer reads. Order is documentation, not load. */
const EDITOR_MODULES = [
  /* the DOM-free engine */
  'topology.js', 'changeset.js', 'changes.js', 'delta.js', 'geojson.js', 'heuristic.js',
  /* vocabularies and leaves */
  'color.js', 'units.js', 'gzip.js', 'dom.js', 'image.js',
  /* data + packaging */
  'archive.js', 'submit.js', 'justify.js', 'mdtext.js',
  /* areas and the map */
  'aoi.js', 'aois.js', 'basemap.js', 'layers.js',
];

/** Vendored libraries the copy's relative imports reach for. */
const EDITOR_LIBS = [
  'maplibre-gl-5.18.0',
  'turf-7.4.0',
  'topojson-client-3.1.0',
  'hyparquet-1.28.2',
  'fzstd-0.1.1',
  'pmtiles-4.5.0',
  /* mdtext.js's guarded `import()` must not 404: a vendor 404 there degrades a
     field to its Source textarea, which is a bug the viewer would never see
     coming because it renders markdown read-only. */
  'squire-rte-2.4.8',
];

const MANIFEST = [
  ...EDITOR_MODULES.map((n) => ({
    from: `js/${n}`, to: `vendor/usdm-editor/js/${n}`,
  })),

  /* The style kit — a FORK of sustainable-fsa/style v0.2.0, re-tokenized for
     NGP RIDR. Copied whole so PROVENANCE.md and LICENSE travel with it.

     `tokens/tokens.json` is skipped: it is still the un-forked Sustainable FSA
     palette, nothing reads it, and shipping it here would assert a palette this
     app does not use. `.DS_Store` is skipped because macOS put it there. */
  {
    dir: 'vendor/style', to: 'vendor/usdm-editor/vendor/style',
    skip: ['tokens/tokens.json', '.DS_Store'],
  },

  ...EDITOR_LIBS.map((d) => ({
    dir: `vendor/${d}`, to: `vendor/usdm-editor/vendor/${d}`,
  })),

  { from: 'vendor/VENDORED.md', to: 'vendor/usdm-editor/vendor/VENDORED.md' },

  /* ── PAGE ROOT, not the mirror. See the header. ─────────────────────────── */
  { from: 'vendor/aoi/states.json', to: 'vendor/aoi/states.json' },
  { from: 'vendor/aoi/aiannh.json', to: 'vendor/aoi/aiannh.json' },
  { from: 'vendor/aoi/neighbors.json', to: 'vendor/aoi/neighbors.json' },
  { from: 'vendor/aoi/PROVENANCE.md', to: 'vendor/aoi/PROVENANCE.md' },
];

/** Page-relative data files that may legitimately be absent. */
const OPTIONAL_DATA = new Set(['vendor/aoi/climdiv.json']);

/* ══ plumbing ═══════════════════════════════════════════════════════════════ */

const MANIFEST_PATH = join(ROOT, 'vendor/usdm-editor/MANIFEST.json');
const PROVENANCE_PATH = join(ROOT, 'vendor/usdm-editor/PROVENANCE.md');
const MIRROR = join(ROOT, 'vendor/usdm-editor');

const argv = process.argv.slice(2);
const wantWrite = argv.includes('--write');
const wantCheck = argv.includes('--check');
const allowDirty = argv.includes('--allow-dirty');
const sourceArg = argv.find((a) => a.startsWith('--source='));
const SOURCE = resolve(ROOT, sourceArg ? sourceArg.slice('--source='.length) : '../usdm-editor');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(sep).join(posix.sep);

/** Every file under `dir` (relative to `base`), sorted, minus the skip list. */
function walk(base, dir, skip = []) {
  const out = [];
  const skipSet = new Set(skip);
  (function rec(rel) {
    const abs = join(base, rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = toPosix(join(rel, name));
      if (skipSet.has(name)) continue;
      if (statSync(join(base, childRel)).isDirectory()) { rec(childRel); continue; }
      out.push(childRel);
    }
  })(dir);
  /* The skip list may name a path relative to the DIRECTORY as well as a bare
     basename, which is how `tokens/tokens.json` is spelled in the manifest. */
  const dirPrefix = `${toPosix(dir)}/`;
  return out.filter((p) => !skipSet.has(p.slice(dirPrefix.length)));
}

/** Expand the manifest into flat {from, to} pairs against a given source root. */
function expand(sourceRoot) {
  const pairs = [];
  for (const entry of MANIFEST) {
    if (entry.from) { pairs.push({ from: entry.from, to: entry.to }); continue; }
    for (const rel of walk(sourceRoot, entry.dir, entry.skip)) {
      pairs.push({ from: rel, to: `${entry.to}/${rel.slice(entry.dir.length + 1)}` });
    }
  }
  return pairs.sort((a, b) => (a.to < b.to ? -1 : 1));
}

/** Every file under vendor/usdm-editor/, relative to this repo root. */
function mirrorFiles() {
  if (!existsSync(MIRROR)) return [];
  return walk(ROOT, 'vendor/usdm-editor');
}

/* ══ --write ════════════════════════════════════════════════════════════════ */

function doWrite() {
  console.log(`── syncing from ${SOURCE} ─────────────────────────────────────`);

  if (!existsSync(join(SOURCE, 'index.html')) || !existsSync(join(SOURCE, 'js/topology.js'))) {
    console.error(`[sync] ${SOURCE} does not look like the USDM Editor repo.`);
    console.error('       Pass --source=<path> if it lives somewhere else.');
    process.exit(2);
  }

  /* A DIRTY SOURCE IS REFUSED, because the commit recorded in MANIFEST.json is
     the whole provenance claim: sync from a working tree with uncommitted edits
     and the file says "these are commit abc123's bytes" when they are not, and
     nobody can ever reproduce the copy. Wait for the commit; `--allow-dirty` is
     for a local experiment and stamps the manifest so it cannot be mistaken for
     a real sync. */
  const paths = [...new Set(MANIFEST.map((e) => e.from ?? e.dir))];
  let dirty = '';
  try {
    dirty = execFileSync('git', ['-C', SOURCE, 'status', '--porcelain', '--', ...paths],
      { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error(`[sync] could not read git status in ${SOURCE}: ${err.message}`);
    process.exit(2);
  }
  if (dirty && !allowDirty) {
    console.error('[sync] the source tree has uncommitted changes under the synced paths:');
    for (const line of dirty.split('\n')) console.error(`       ${line}`);
    console.error('       Commit them first — the recorded commit is the provenance claim.');
    console.error('       (--allow-dirty stamps the manifest as unreproducible; do not use it for a real sync.)');
    process.exit(2);
  }

  const commit = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const described = (() => {
    try {
      return execFileSync('git', ['-C', SOURCE, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    } catch { return ''; }
  })();

  const pairs = expand(SOURCE);
  const files = {};
  let copied = 0;
  for (const { from, to } of pairs) {
    const src = join(SOURCE, from);
    if (!existsSync(src)) {
      console.error(`[sync] listed file is missing from the source: ${from}`);
      process.exit(2);
    }
    const dst = join(ROOT, to);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);                       // BYTES, verbatim. No rewriting.
    files[to] = { from, sha256: sha256(readFileSync(src)) };
    copied++;
  }

  /* Anything left under the mirror that the manifest does not name is drift by
     definition — usually a file the editor deleted. Say so; do not delete
     silently, because a surprise deletion in a vendored tree is worse than a
     loud one. */
  const listed = new Set(Object.keys(files));
  const strays = mirrorFiles().filter((p) => !listed.has(p)
    && p !== 'vendor/usdm-editor/MANIFEST.json' && p !== 'vendor/usdm-editor/PROVENANCE.md');
  for (const s of strays) console.warn(`[sync] NOT IN THE MANIFEST, left in place: ${s}`);

  const manifest = {
    source: 'https://github.com/ngp-ridr/usdm-editor',
    sourcePath: toPosix(relative(ROOT, SOURCE)),
    commit,
    commitSubject: described,
    dirty: Boolean(dirty),
    syncedAt: new Date().toISOString(),
    count: copied,
    files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]])),
  };
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(PROVENANCE_PATH, provenanceMarkdown(manifest));

  console.log(`  ${copied} file(s) copied from ${commit.slice(0, 12)}`);
  console.log(`  wrote vendor/usdm-editor/MANIFEST.json and PROVENANCE.md`);
  if (dirty) console.log('  ⚠ the source was DIRTY — this copy is not reproducible.');
  console.log('\n✓ synced');
}

function provenanceMarkdown(m) {
  const byPrefix = new Map();
  for (const to of Object.keys(m.files)) {
    const key = to.startsWith('vendor/usdm-editor/js/') ? 'vendor/usdm-editor/js/'
      : to.startsWith('vendor/aoi/') ? 'vendor/aoi/'
        : `${to.split('/').slice(0, 4).join('/')}/`;
    byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
  }
  const rows = [...byPrefix.entries()].sort()
    .map(([k, n]) => `| \`${k}\` | ${n} |`).join('\n');

  return `# vendor/usdm-editor — provenance

**GENERATED by \`tools/sync-from-editor.mjs\`. Do not edit this file, and do not
edit a single byte under \`vendor/usdm-editor/\` or \`vendor/aoi/\`.**

A pinned, byte-identical copy of the parts of the
[USDM Editor](${m.source}) this viewer reads. Nothing is fetched from the
editor's origin at runtime: this page runs under \`default-src 'none'\` with
\`script-src 'self'\`, and the fleet's rule is no remote code.

| | |
|---|---|
| source | \`${m.sourcePath}\` (${m.source}) |
| commit | \`${m.commit}\` |
| subject | ${m.commitSubject || '—'} |
| synced | ${m.syncedAt} |
| files | ${m.count} |
${m.dirty ? '| ⚠ | the source tree was DIRTY at sync time — this copy is not reproducible |\n' : ''}
| prefix | files |
|---|---|
${rows}

## The shape, and why

\`vendor/usdm-editor/\` MIRRORS THE EDITOR'S ROOT — \`js/\` beside \`vendor/\` —
because every editor module imports its libraries by relative path
(\`js/archive.js\` → \`../vendor/hyparquet-1.28.2/…\`, \`js/mdtext.js\` →
\`../vendor/squire-rte-2.4.8/squire.mjs\`, \`js/layers.js\` → a lazy
\`../vendor/pmtiles-4.5.0/…\`). Under one mirrored prefix every one of those
resolves unchanged and no specifier is ever rewritten.

\`vendor/aoi/\` is the exception and sits at the **page root**: \`js/aois.js\`
names its TopoJSON as page-relative urls, which resolve against the document
rather than the module. \`climdiv.json\` is deliberately not copied — the viewer
resolves no climate division.

The style kit therefore lives at \`vendor/usdm-editor/vendor/style/\` (a fork of
\`sustainable-fsa/style\` v0.2.0; its own PROVENANCE.md travels with it), and
this app's \`js/*\` import the kit from there.

## Re-syncing

\`\`\`sh
node tools/sync-from-editor.mjs --write --source=../usdm-editor
node tools/sync-from-editor.mjs --check
\`\`\`

\`--write\` refuses a dirty source: the commit above is the provenance claim, and
a copy taken from a working tree cannot be reproduced from it. \`--check\` runs
in CI and verifies every sha256, refuses an unlisted file under the mirror,
resolves the import closure of the copy AND of \`js/\`, and confirms the
page-relative data files exist.

**Behaviour the viewer needs differently is a wrapper in \`js/\`, never an edit
here** — a drifted copy is a copy nobody can re-sync, and re-syncing is how the
viewer inherits an editor fix.
`;
}

/* ══ --check ════════════════════════════════════════════════════════════════ */

function doCheck() {
  console.log('── the vendored copy is the editor\'s bytes ────────────────────');

  if (!existsSync(MANIFEST_PATH)) {
    bad('vendor/usdm-editor/MANIFEST.json is missing — run --write');
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const entries = Object.entries(manifest.files ?? {});
  if (!entries.length) { bad('MANIFEST.json lists no files'); return; }

  /* 1. every listed file present, with the recorded bytes. */
  const missing = [];
  const changed = [];
  for (const [to, meta] of entries) {
    const abs = join(ROOT, to);
    if (!existsSync(abs)) { missing.push(to); continue; }
    if (sha256(readFileSync(abs)) !== meta.sha256) changed.push(to);
  }
  if (missing.length) for (const m of missing.slice(0, 12)) bad(`missing: ${m}`);
  if (changed.length) for (const c of changed.slice(0, 12)) bad(`EDITED since the sync: ${c}`);
  if (missing.length > 12) bad(`…and ${missing.length - 12} more missing`);
  if (changed.length > 12) bad(`…and ${changed.length - 12} more edited`);
  if (!missing.length && !changed.length) {
    ok(`${entries.length} file(s) match MANIFEST.json (editor ${String(manifest.commit).slice(0, 12)})`);
  }
  if (manifest.dirty) bad('the recorded sync was taken from a DIRTY source tree');

  /* 2. nothing unlisted under the mirror. */
  const listed = new Set(Object.keys(manifest.files));
  const generated = new Set(['vendor/usdm-editor/MANIFEST.json', 'vendor/usdm-editor/PROVENANCE.md']);
  const strays = mirrorFiles().filter((p) => !listed.has(p) && !generated.has(p));
  if (strays.length) for (const s of strays.slice(0, 12)) bad(`unlisted file under the mirror: ${s}`);
  else ok('nothing unlisted lives under vendor/usdm-editor/');

  /* 3. IMPORT CLOSURE. Both halves — the copy's own imports and this app's
        imports INTO the copy. A relative specifier that resolves to nothing is
        a module that never loads, and in the two places the editor guards its
        dynamic imports with `.catch(() => null)` it is a feature that silently
        is not there. */
  const sources = [
    ...listFiles(join(ROOT, 'vendor/usdm-editor/js')).map((p) => `vendor/usdm-editor/js/${p}`),
    ...listFiles(join(ROOT, 'js')).map((p) => `js/${p}`),
  ].filter((p) => p.endsWith('.js'));

  let unresolved = 0;
  let specifiers = 0;
  for (const rel of sources) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    for (const spec of relativeSpecifiers(text)) {
      specifiers++;
      const target = resolve(dirname(join(ROOT, rel)), spec);
      if (!existsSync(target)) { bad(`${rel} imports '${spec}' — no such file`); unresolved++; }
    }
  }
  if (!unresolved) ok(`import closure: ${specifiers} relative specifier(s) across ${sources.length} module(s) resolve`);

  /* 4. the page-relative data files. These are `fetch()`ed against the
        DOCUMENT, so no import graph can catch a missing one — the app just
        toasts "could not load that area" at the first click. */
  const aois = join(ROOT, 'vendor/usdm-editor/js/aois.js');
  if (!existsSync(aois)) bad('vendor/usdm-editor/js/aois.js is missing — cannot check the data files');
  else {
    const text = readFileSync(aois, 'utf8');
    const named = [...text.matchAll(/file:\s*["'](vendor\/aoi\/[^"']+)["']/g)].map((m) => m[1]);
    const neighbors = 'vendor/aoi/neighbors.json';
    const want = [...new Set([...named, neighbors])];
    let bads = 0;
    for (const w of want) {
      if (existsSync(join(ROOT, w))) continue;
      if (OPTIONAL_DATA.has(w)) { ok(`${w} is absent, which is allowed (no climate division is resolvable here)`); continue; }
      bad(`page-relative data file is missing: ${w}`); bads++;
    }
    if (!bads) ok(`page-root data files present (${want.length} named by js/aois.js + neighbors.json)`);
  }
}

/** Every file under `dir`, relative to it. [] when the directory is absent. */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  (function rec(prefix) {
    for (const name of readdirSync(join(dir, prefix)).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) rec(rel);
      else out.push(rel);
    }
  })('');
  return out;
}

/**
 * Relative import specifiers in a module's source — static and dynamic.
 *
 * Deliberately crude: a regex over the text rather than a parse. A false
 * POSITIVE costs a look at one line; a false negative costs a module that does
 * not load in a browser and nowhere else. In particular this must see a LAZY
 * import — the editor's `js/layers.js` reaches for pmtiles inside a
 * `.catch(() => null)`, which is exactly the specifier whose absence nothing
 * else in this repo would report.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not a convenience. `js/app.js`
 * carries a commented block naming every module the other work packages will
 * write, so that the import paths are decided once and each package writes its
 * module to the name app.js already calls. Scanning comments would turn that
 * deliberate signpost into twelve failures.
 *
 * Line comments are only stripped when `//` OPENS a line (after whitespace).
 * A `//` in the middle of a line is far more likely to be the scheme separator
 * of a url inside a string than the start of a comment, and eating the rest of
 * that line could swallow a real specifier.
 */
function relativeSpecifiers(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const src = noBlocks.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const out = new Set();
  for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+['"](\.[^'"]+)['"]/g)) out.add(m[1]);
  return out;
}

/* ══ main ═══════════════════════════════════════════════════════════════════ */

if (!wantWrite && !wantCheck) {
  console.error('usage: node tools/sync-from-editor.mjs --write [--source=../usdm-editor] | --check');
  process.exit(2);
}

if (wantWrite) doWrite();
if (wantCheck) {
  doCheck();
  console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}
