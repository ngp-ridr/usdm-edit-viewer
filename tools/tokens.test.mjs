/* ============================================================================
   USDM Edit Viewer · tools/tokens.test.mjs
   Assert that every design token the app reads actually RESOLVES in a browser,
   in both themes; that the measured contrast contract still holds; that neither
   published USDM ramp has leaked into the theme; and — this app's two additions
   — that css/app.css carries no raw hex and that its kit-override header count
   is true.

     node tools/tokens.test.mjs

   ── Why a whole tool for this ──────────────────────────────────────────────
   A CSS custom property that does not exist is not an error. `var(--accent)`
   with no `--accent` falls back to nothing, `getPropertyValue` returns '', and
   the page renders — wrong, but without a single console message.

   That is not hypothetical. The kit shipped with a token block that never
   parsed at all: a comment in the file header wrote two class globs separated
   by a slash, and the star-slash that produced closed the comment early and
   desynced the parser through the entire `:root` block. Every colour in the app
   silently fell back to a browser default, and nothing anywhere said so.

   It runs headless — no browser binary needed. The CSS is parsed the way a
   browser parses it (comments first, then declarations), which is precisely the
   behaviour under test.

   ── What is different here from the editor's copy ──────────────────────────
   1. The theme and js/color.js are read out of the VENDORED COPY.
   2. The app-source list TOLERATES A MISSING FILE. Five work packages build
      this app in parallel; the gate has to be green before js/map.js exists or
      it is a gate nobody can run. A missing file is reported as a skip, by
      name, so it cannot be forgotten either.
   3. NO RAW HEX IN css/app.css. The two USDM ramps are data and live in
      js/color.js; a literal colour in the stylesheet is either a leaked ramp
      value or a token somebody did not look up, and both are bugs.
   4. THE KIT-OVERRIDE COUNT IN THE HEADER IS CHECKED. A count that is kept by
      hand is a count that drifts, and the whole value of the tag is that the
      number in the header can be trusted without reading the file.
   ========================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = 'vendor/usdm-editor/vendor/style/theme/ridr-theme.css';
const COLOR_JS = 'vendor/usdm-editor/js/color.js';
const APP_CSS = 'css/app.css';

/* The app's own sources, read so that a new `var()` is covered the moment it is
   written. Hand-kept in one respect — WHICH files — so it follows the code.
   A file that does not exist yet is SKIPPED with a note (see the header). */
const APP_SOURCES = [
  APP_CSS,
  'js/app.js',
  'js/map.js',
  'js/panels.js',
  'js/cards.js',
  /* The vendored layer stack carries the ladder's own `cssVar` reads, and this
     app mounts it unchanged — so its tokens are this app's tokens. */
  'vendor/usdm-editor/js/layers.js',
];

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const skip = (m) => console.log(`  skip ${m}`);
const check = (c, m) => (c ? ok(m) : bad(m));

const css = readFileSync(join(ROOT, THEME), 'utf8');

/* ── strip comments exactly as a CSS parser does ──────────────────────────── */
function stripComments(s) {
  let out = '', i = 0, inC = false;
  while (i < s.length) {
    if (!inC && s.startsWith('/*', i)) { inC = true; i += 2; continue; }
    if (inC && s.startsWith('*/', i)) { inC = false; i += 2; continue; }
    if (!inC) out += s[i];
    i++;
  }
  return { text: out, unterminated: inC };
}

const { text, unterminated } = stripComments(css);
check(!unterminated, 'no unterminated comment in ridr-theme.css');

/**
 * Split the comment-free CSS into top-level `selector { body }` pairs.
 * Brace-depth aware, so an @media block cannot be mistaken for a rule.
 */
function topLevelRules(src) {
  const rules = [];
  let depth = 0, selStart = 0, bodyStart = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) { bodyStart = i; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart > -1) {
        rules.push({
          selector: src.slice(selStart, bodyStart).trim(),
          body: src.slice(bodyStart + 1, i),
        });
        selStart = i + 1; bodyStart = -1;
      }
    }
  }
  return rules;
}
const RULES = topLevelRules(text);

/** All declarations of the FIRST top-level rule with this exact selector. */
function tokensIn(selector) {
  const r = RULES.find((x) => x.selector === selector);
  if (!r) return null;
  const out = {};
  for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

console.log('\n── token blocks parse ──────────────────────────────────────');
const light = tokensIn(':root');
const hc = tokensIn('[data-theme="high-contrast"]');
check(light !== null, ':root block is present and parseable');
check(hc !== null, '[data-theme="high-contrast"] block is present and parseable');
if (!light || !hc) { console.log('\n✗ cannot continue'); process.exit(1); }

/* The z-index ladder lives in its own later :root; the FIRST :root must be the
   design tokens. If a parse desync eats the token block, this is what notices. */
check('--accent' in light && '--font-ui' in light,
  `the first :root carries the design tokens (${Object.keys(light).length} declarations)`);

console.log('\n── every token the app reads exists ────────────────────────');
const present = APP_SOURCES.filter((f) => existsSync(join(ROOT, f)));
for (const f of APP_SOURCES) {
  if (!present.includes(f)) skip(`${f} does not exist yet — its tokens are unchecked`);
}
check(present.includes(APP_CSS), `${APP_CSS} exists (the one source that is never optional)`);

const appSrc = present.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
const used = new Set();
for (const m of appSrc.matchAll(/var\((--[a-z0-9-]+)/gi)) used.add(m[1]);
for (const m of appSrc.matchAll(/cssVar\(\s*['"](--[a-z0-9-]+)['"]/gi)) used.add(m[1]);

/* The theme's tokens, PLUS any custom property css/app.css declares for itself.
   The rule this check enforces is "no `var()` pointing at nothing" — not "every
   property is the kit's". An app legitimately owns a measurement of its own:
   `--app-footer-h` is the height of THIS app's footer, which the kit cannot
   know and which two rules here have to agree about (the footer and the toast
   that clears it). App-owned properties are spelled `--app-*` so a reader can
   tell at a glance which side of the line one is on. */
const appDefined = [...readFileSync(join(ROOT, APP_CSS), 'utf8')
  .matchAll(/(--app-[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
const allDefined = new Set([...Object.keys(light), ...Object.keys(hc),
  ...[...text.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
  ...appDefined]);
const missing = [...used].filter((t) => !allDefined.has(t));
check(missing.length === 0,
  `all ${used.size} token(s) referenced by the app are defined` +
  (missing.length ? ` — MISSING: ${missing.join(', ')}` : '') +
  (appDefined.length ? ` (${appDefined.length} app-owned: ${[...new Set(appDefined)].join(', ')})` : ''));

console.log('\n── theme parity ────────────────────────────────────────────');
const INDEPENDENT = new Set(['--font-ui', '--font-serif', '--font-mono', '--heading-weight',
  '--radius-sm', '--radius-md', '--radius-lg', '--transition', '--sheet-h', '--drawer-w']);
const themed = Object.keys(light).filter((t) => !INDEPENDENT.has(t));
const missingHc = themed.filter((t) => !(t in hc));
const extraHc = Object.keys(hc).filter((t) => !(t in light));
check(missingHc.length === 0, `every themed token has a high-contrast value` +
  (missingHc.length ? ` — MISSING: ${missingHc.join(', ')}` : ` (${themed.length})`));
check(extraHc.length === 0, 'high-contrast defines nothing the light theme lacks' +
  (extraHc.length ? ` — EXTRA: ${extraHc.join(', ')}` : ''));

console.log('\n── the measured contrast contract still holds ──────────────');
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const cr = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const hexOnly = (v) => /^#[0-9a-f]{6}$/i.test(v);

for (const [name, toks] of [['light', light], ['high-contrast', hc]]) {
  const surfaces = ['--bg-deep', '--bg-surface', '--bg-raised'].map((k) => toks[k]);
  if (!surfaces.every(hexOnly)) { bad(`${name}: surfaces are not plain hex`); continue; }
  const worst = (tok) => Math.min(...surfaces.map((s) => cr(toks[tok], s)));

  for (const tok of ['--text-primary', '--text-secondary', '--text-muted', '--text-dim', '--accent-line']) {
    if (!hexOnly(toks[tok])) { bad(`${name} ${tok} is not plain hex`); continue; }
    const w = worst(tok);
    check(w >= 4.5, `${name} ${tok} ${toks[tok]} → ${w.toFixed(2)}:1 worst surface (needs 4.5)`);
  }
  const cb = worst('--ctrl-border');
  check(cb >= 3, `${name} --ctrl-border ${toks['--ctrl-border']} → ${cb.toFixed(2)}:1 (needs 3, WCAG 1.4.11)`);
  const onAccent = cr(toks['--text-on-accent'], toks['--accent']);
  check(onAccent >= 4.5,
    `${name} --text-on-accent on --accent → ${onAccent.toFixed(2)}:1 (needs 4.5)`);
}

console.log('\n── the USDM ramp is NOT in the theme ───────────────────────');
/* The drought colours are data, not brand. If they ever appear as theme tokens
   they will start varying by theme, and a D3 that changes colour between themes
   is a D3 nobody can trust. */
const ramp = ['#ffff00', '#fcd37f', '#ffaa00', '#e60000', '#730000'];
const leaked = ramp.filter((c) => text.toLowerCase().includes(c));
check(leaked.length === 0,
  'no USDM class colour is defined in the theme' + (leaked.length ? ` — LEAKED: ${leaked.join(', ')}` : ''));

const colorJs = readFileSync(join(ROOT, COLOR_JS), 'utf8');
const colorJsLower = colorJs.toLowerCase();
for (const [cls, hex] of [['D0', '#ffff00'], ['D1', '#fcd37f'], ['D2', '#ffaa00'],
                          ['D3', '#e60000'], ['D4', '#730000']]) {
  check(new RegExp(`${cls}:\\s*'${hex}'`).test(colorJs), `${COLOR_JS} ${cls} = ${hex}`);
}
/* Label ink, measured — black on D0–D2, white on D3–D4. */
for (const [cls, hex] of [['D0', '#ffff00'], ['D1', '#fcd37f'], ['D2', '#ffaa00'],
                          ['D3', '#e60000'], ['D4', '#730000']]) {
  const black = cr(hex, '#000000'), white = cr(hex, '#ffffff');
  const want = black > white ? '#000000' : '#ffffff';
  const got = (cls === 'D3' || cls === 'D4') ? '#ffffff' : '#000000';
  check(want === got && Math.max(black, white) >= 4.5,
    `${cls} label ink ${got} → ${Math.max(black, white).toFixed(2)}:1`);
}

console.log('\n── nor is the NDMC change ramp ─────────────────────────────');
/* The second published encoding, held to the same rule and for the same reason.
   This app paints it over every finding, so it matters here at least as much as
   it does in the editor. Ten swatches, because "no drought" is a state and the
   scale runs to ±5. */
const CHANGE_RAMP = [
  ['1', '#ffff73'], ['2', '#ffd438'], ['3', '#ff9900'], ['4', '#a87000'], ['5', '#543005'],
  ['-1', '#cdffd4'], ['-2', '#8ad48c'], ['-3', '#359766'], ['-4', '#016678'], ['-5', '#003d75'],
];
const changeLeaked = CHANGE_RAMP.map(([, hex]) => hex).filter((c) => text.toLowerCase().includes(c));
check(changeLeaked.length === 0,
  `no change-map colour is defined in the theme (${CHANGE_RAMP.length} checked)` +
  (changeLeaked.length ? ` — LEAKED: ${changeLeaked.join(', ')}` : ''));

for (const [step, hex] of CHANGE_RAMP) {
  check(new RegExp(`'${step}':\\s*'${hex}'`).test(colorJsLower), `${COLOR_JS} ${step} = ${hex}`);
}

/* ── this app's two additions ─────────────────────────────────────────────── */

console.log('\n── css/app.css carries no raw hex ──────────────────────────');
/* Every colour in this file is a token. A literal is either a leaked published
   ramp value (which must never vary by theme and must never be duplicated) or a
   token somebody did not look up — and a token somebody did not look up is a
   colour that will not follow the high-contrast theme.

   Comments are stripped first, exactly as the parser does, so the file may go
   on WRITING about `#cccccc` (which is documented and deliberately never
   painted) without failing its own gate. */
const appCss = readFileSync(join(ROOT, APP_CSS), 'utf8');
const { text: appCssBody } = stripComments(appCss);
const hexes = [...appCssBody.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
  /* An id selector made only of hex letters would read as a colour. None exist
     today; this keeps the check from becoming a trap if one is ever added. */
  .filter((m) => !/[a-zA-Z0-9_-]/.test(appCssBody[m.index + m[0].length] ?? ''))
  .map((m) => m[0]);
check(hexes.length === 0,
  'no raw hex colour in css/app.css' + (hexes.length ? ` — FOUND: ${[...new Set(hexes)].join(', ')}` : ''));

console.log('\n── the kit-override count in the header is true ────────────');
/* Every rule in app.css that names a KIT selector is tagged, and the header
   states how many there are. A hand-kept number is a number that drifts, and
   the whole value of the tag is being able to trust the header without reading
   the file. */
const stated = /kit-override count:\s*(\d+)/.exec(appCss);
check(stated !== null, 'css/app.css states a kit-override count in its header');
if (stated) {
  /* Count the TAGS, not the header's own mention of the phrase: the header says
     "kit-override count:", which is not a tag. */
  const tags = [...appCss.matchAll(/\/\*\s*kit-override:/g)].length;
  check(Number(stated[1]) === tags,
    `header says ${stated[1]} kit-override(s); ${tags} tagged in the file`);
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
