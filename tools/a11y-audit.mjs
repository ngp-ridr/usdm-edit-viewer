/* ============================================================================
   USDM Edit Viewer · tools/a11y-audit.mjs
   axe-core over the app's real states, in a real browser.

     node tools/a11y-audit.mjs

   Nightly and on dispatch, not on every push — the same lane as the full
   verify. It is the slowest gate with the least per-commit signal, and a
   feature batch landing in the panels will legitimately move its findings
   around for a day.

   ── Why several states and not one page load ───────────────────────────────
   Almost nothing in this app exists on the boot screen. The proposal list, the
   findings list and the legend are all `hidden` until something is loaded; the
   detail card is built fresh per finding and holds a different DOM for a
   proposal, a conflict and a seam; the change ramp only ever renders in the
   Differences view; and the drawer is a different component under compact. A
   single scan of the empty state would report on the navbar and the footer and
   pass cleanly while the rest of the interface was broken.

   axe does not report on hidden content — correctly, since a screen reader
   cannot reach it either — so each state below is DRIVEN INTO EXISTENCE first
   and scanned second.

   ── What axe cannot see, and what covers it instead ────────────────────────
   The map is a WebGL canvas and axe has nothing to say about it. The two
   things that matter most there are covered elsewhere, deliberately:

     · that the findings list is the map's TEXT TWIN — same findings, same rank
       order, same words — is tools/verify.mjs § 3;
     · that no class or mark is ever signalled by colour alone, and that every
       measured contrast ratio holds in both themes, is tools/tokens.test.mjs
       and the legend assertions in verify § 5.

   This file covers the DOM around the canvas.

   ── The one rule that is checked here and nowhere else ─────────────────────
   NO ACCESSIBLE NAME ON ONE SCREEN MAY CONTAIN ANOTHER'S (WCAG 2.5.3's
   neighbour, and the editor's § 9f rule). axe does not check it. The navbar,
   the drawer and an OPEN CARD are on screen together, so they are swept
   together — see `names()` at the bottom.
   ========================================================================== */

import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* Its own port and its own server: this file must never queue behind the
   50-minute full verify, and a hang here should not sit behind a green run. */
const PORT = 8767;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  /* `.mjs` is not optional — it is what the Squire bundle ships under, and a
     module served as octet-stream is refused by the module loader. The
     vendored js/mdtext.js catches that and degrades to a plain source view by
     design, so a missing MIME type here does not fail the audit: it makes the
     audit quietly scan the FALLBACK and report it as the real thing. */
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
  '.topojson': 'application/json; charset=utf-8',
  '.parquet': 'application/octet-stream',
  /* No `content-encoding`: the app gunzips the demo packages itself. */
  '.gz': 'application/gzip',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, normalize(rel === '/' ? '/index.html' : rel));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(path));
});

await new Promise((r) => server.listen(PORT, r));
const browser = await chromium.launch();
/* axe-core/playwright requires a page created from an explicit CONTEXT — it
   refuses a page made straight off the browser. */
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

let violations = 0;
let nameClashes = 0;
let states = 0;
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };

const boot = (qs = '') => page.goto(`http://localhost:${PORT}/${qs}`, { waitUntil: 'load' });
const booted = () => page.waitForFunction(() => window.__viewer?.booted === true,
  null, { timeout: 180000 });
/** Wait for a full session AND the comparison sweep. Conditions, never durations. */
const loaded = (n = 12) => page.waitForFunction(
  (want) => (window.__viewer?.session?.size ?? 0) >= want
         && Array.isArray(window.__viewer?.findings),
  n, { timeout: 180000 });
/** The deferred re-check queue has drained — the rows carry verdicts, not "checking…". */
const rechecked = () => page.waitForFunction(() => {
  const lines = [...document.querySelectorAll('.recheck-line')];
  return lines.length > 0 && lines.every((n) => !/checking/i.test(n.textContent));
}, null, { timeout: 180000 }).catch(() => {});
const cardOpen = () => page.waitForFunction(
  () => document.getElementById('detail-card')?.hidden === false, null, { timeout: 30000 });

/**
 * Scan one state.
 *
 * `color-contrast` is not disabled, but `#map` is EXCLUDED — axe samples the
 * WebGL canvas behind a control and reports whatever pixel it happens to find
 * there, which is a drought polygon rather than a background. Chrome contrast
 * is measured for real, against the tokens themselves, in
 * tools/tokens.test.mjs.
 */
async function scan(name) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('#map')
    .analyze();
  states++;
  const found = results.violations;
  if (!found.length) { ok(name); return; }
  violations += found.length;
  console.log(`  FAIL ${name} — ${found.length} violation(s)`);
  failures++;
  for (const v of found) {
    console.log(`         [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) console.log(`           ${n.target.join(' ')}`);
    if (v.nodes.length > 3) console.log(`           …and ${v.nodes.length - 3} more`);
  }
}

/**
 * Every accessible name on screen right now, from the elements a reader can
 * reach with a keyboard.
 *
 * Crude on purpose — `aria-label` else trimmed text — because the rule it
 * serves is about what a screen reader ANNOUNCES, and both of those are what
 * it announces. A false positive costs a look at two labels.
 */
const names = () => page.evaluate(() => {
  const sel = 'button, a[href], input, select, summary, [role="button"]';
  const seen = [];
  for (const n of document.querySelectorAll(sel)) {
    if (n.closest('[hidden]') || n.hidden) continue;
    if (!n.getClientRects().length) continue;
    const name = (n.getAttribute('aria-label')
      ?? (n.labels?.[0]?.textContent)
      ?? n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (name) seen.push(name);
  }
  return seen;
});

/**
 * THE RULE AXE DOES NOT CHECK: no SPEAKABLE accessible name may contain
 * another's.
 *
 * "Save" inside "Save a checkpoint" is ambiguous to anyone driving by voice —
 * "click Save" has two answers and the software picks one. The editor carries
 * the same sweep at its § 9f and it caught two real collisions there.
 *
 * TWO QUALIFIERS, and both are the rule rather than a softening of it.
 *
 * 1. BOTH NAMES MUST BE SPEAKABLE. What 2.5.3's neighbour protects is a person
 *    saying a label out loud, so the collision only exists between things
 *    somebody would say. This app's findings list is its TEXT TWIN: every row's
 *    name is a whole sentence — "Nebraska · Change 1 (Whitcomb) vs Change 1
 *    (Steffensmeier) · D0 Whitcomb vs D2 Steffensmeier · published D1 ·
 *    2-class span · 665 mi²". The word "published" is an ADJECTIVE in there,
 *    and a sweep that flagged it against the "Published" view segment reported
 *    168 collisions on a screen that has none. Nobody addresses a control by
 *    reciting ninety characters, so a container that long is not a competing
 *    answer to anything.
 *
 * 2. THE CONTAINMENT MUST BE AT WORD BOUNDARIES. "Load" inside "Download" is
 *    not an ambiguity; "Load" inside "Load proposal files" is.
 *
 * Duplicates are allowed and are a different question: several finding rows
 * legitimately begin the same way and each names its own ground. What must not
 * happen is one short name being a strict word-boundary substring of another.
 */
const SPEAKABLE = 44;

async function sweepNames(where) {
  const all = await names();
  const uniq = [...new Set(all)];
  const short = uniq.filter((n) => n.length <= SPEAKABLE);
  const clashes = [];
  for (const a of short) {
    for (const b of short) {
      if (a === b) continue;
      const i = a.toLowerCase().indexOf(b.toLowerCase());
      if (i < 0) continue;
      /* Word boundaries on both ends, so "Load" ⊂ "Download" is not a finding
         while "Load" ⊂ "Load proposal files" is. */
      const before = i === 0 ? ' ' : a[i - 1];
      const after = i + b.length >= a.length ? ' ' : a[i + b.length];
      if (/[\w]/.test(before) || /[\w]/.test(after)) continue;
      clashes.push(`${JSON.stringify(b)} ⊂ ${JSON.stringify(a)}`);
    }
  }
  if (!clashes.length) {
    ok(`${where}: ${short.length} speakable name(s) of ${uniq.length}, none contains another`);
    return;
  }
  nameClashes += clashes.length;
  bad(`${where}: ${clashes.length} containing name pair(s)`);
  for (const c of clashes.slice(0, 8)) console.log(`           ${c}`);
  if (clashes.length > 8) console.log(`           …and ${clashes.length - 8} more`);
}

try {
  console.log('\n── states ──────────────────────────────────────────────────');

  /* 1. THE EMPTY STATE — the navbar, the footer, the three view segments and
        the two ways in. This is a first visit, and it is the only screen some
        readers ever see if the load fails. */
  await boot();
  await booted();
  await scan('empty state');
  await sweepNames('empty state');

  /* 2. THE DEMO SET — twelve proposal rows with their checkboxes and labels,
        the three findings groups, the legend, and the session line. This is
        the densest DOM in the app and the one a reviewer lives in. */
  await boot('?demo');
  await booted();
  await loaded();
  await rechecked();
  await scan('demo loaded — proposals, findings, legend');
  await sweepNames('demo loaded');

  /* 3. A PROPOSAL CARD — the author block, the re-check verdict, rendered
        markdown, the evidence list and the change list. Opened through the
        row's own Details button, because that is the path a reader takes and
        a card opened by a model call would not prove the button is wired. */
  const details = page.locator('.proposal-row button', { hasText: /^Details$/ }).first();
  if (await details.count()) {
    await details.click();
    await cardOpen();
    await scan('proposal card');
    await sweepNames('proposal card open');
  } else {
    bad('no Details button on a proposal row — cannot scan the proposal card');
  }

  /* 4. A FINDING CARD — the side-by-side grid, two author blocks, the
        questions list and the two brief transports. */
  const conflict = page.locator('#findings-conflicts .finding-row').first();
  if (await conflict.count()) {
    await conflict.click();
    await cardOpen();
    await scan('finding card — the side-by-side');
    await sweepNames('finding card open');
  } else {
    bad('no conflict row — cannot scan the finding card');
  }

  /* 5. A SEAM CARD — a different body again: the run table, both sides, and
        the border notes. A table is the one structure axe has real opinions
        about, and this is the only one in the app. */
  const seam = page.locator('#findings-seams .finding-row').first();
  if (await seam.count()) {
    await seam.click();
    await cardOpen();
    await scan('seam card — the run table');
    await sweepNames('seam card open');
  } else {
    bad('no seam row — cannot scan the seam card');
  }

  /* 6. DIFFERENCES — the legend swaps to NDMC's change ramp, which is ten
        swatches and the labelled hole. A different set of rows entirely. */
  await page.locator('#card-close').click().catch(() => {});
  await page.locator('#view-differences').click();
  await page.waitForFunction(() => window.__viewer?.view === 'differences', null, { timeout: 30000 });
  await scan('Differences view — the change ramp legend');

  /* 7. COMPACT — the drawer is an overlay with a scrim, the card is a bottom
        sheet, and the tab is a different control. Three components the desktop
        scans never touched. */
  await page.setViewportSize({ width: 390, height: 844 });
  await boot('?demo');
  await booted();
  await loaded();
  await rechecked();
  await page.locator('#btn-drawer').click().catch(() => {});
  await scan('compact — the drawer as an overlay');
  await page.locator('.finding-row').first().click().catch(() => {});
  await cardOpen().catch(() => {});
  await scan('compact — the card as a bottom sheet');
  await sweepNames('compact, sheet open');
  await page.setViewportSize({ width: 1440, height: 900 });

  /* 8. LIGHT — the other theme. Every token is redefined there, so every
        contrast pair axe measures is a different pair. */
  await boot('?demo&theme=light');
  await booted();
  await loaded();
  await rechecked();
  await scan('light theme');
} catch (err) {
  bad(`audit threw: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}

/* The two counts are reported SEPARATELY because they are different claims and
   a reader acts on them differently: an axe violation is a WCAG failure in the
   markup, a name clash is an ambiguity between two controls. A summary that
   added them together once read "5 states with findings — 0 axe violations",
   which is a sentence nobody can do anything with. */
console.log(`\n${failures === 0
  ? `✓ no violations — ${states} state(s) scanned`
  : `✗ ${failures} check(s) failed: ${violations} axe violation(s), ` +
    `${nameClashes} name clash(es), over ${states} state(s)`}`);
process.exit(failures === 0 ? 0 : 1);
