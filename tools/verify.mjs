/* ============================================================================
   USDM Edit Viewer · tools/verify.mjs
   End-to-end behavioural verification, in a real browser, against the real
   demo set. Screenshots land in verify-out/.

     node tools/verify.mjs            # every section
     node tools/verify.mjs --headed   # watch it
     node tools/verify.mjs --fast     # skip the full-lane-only sections

   ── What this covers that the Node suites cannot ───────────────────────────
   tools/compare.test.mjs proves the comparison is RIGHT — 149 checks over the
   twelve real packages, under Node, with no browser anywhere near it. This
   proves it is WIRED: that twelve files dropped on a page become twelve rows
   and a ranked list, that the Hi-Line conflict a fixture found is the one a
   reader can click, that the map paints the picked proposal's classes into the
   source the fills read, that a brief downloads with both authors in it, and
   that a refused `?load=` origin says so instead of failing silently.

   It also guards failures that are invisible by construction:

     · A STALE CSP HASH. The one inline script is the anti-flash theme boot;
       blocked, the theme flash comes back and the page otherwise works
       perfectly. § 1 pins the hash COUNT (exactly one — this app has no import
       map and growing one silently would be a second) and the exact
       `connect-src` set, because a missing basemap origin 404s to a CSP
       violation that `resolveBaseStyle` swallows by design, leaving the app
       looking like a deliberate no-basemap build.
     · A SILENTLY REFUSED FETCH. `?load=` from a foreign origin must be refused
       BY THIS APP, with a sentence, before the request is made — § 7 asserts
       both halves, the sentence AND the absence of a CSP violation, because a
       CSP block produces a console line nobody reads and no sentence at all.
     · A FINDINGS LIST THAT IS NOT THE MAP'S TEXT TWIN. Everything the map
       marks is a row in the panel, in the same rank order (§ 3), and the
       `findings` source holds exactly as many features as the list has rows
       (§ 4). A canvas a screen reader cannot see is only as good as the list
       beside it.
     · A `queryRenderedFeatures` ASSERTION. This file asserts SOURCE data for
       "does it cover this" and rendered queries only for "is it painting at
       all", because `queryRenderedFeatures` is blind to holes (every ring
       reports a hit independently) and returns tile-simplified geometry. The
       editor lost its PNG export's state lines to the sibling mistake of
       reading `getSource()._data`, which in MapLibre v5 is not GeoJSON.

   ── The rule every wait in this file follows ───────────────────────────────
   WAITS ARE ON CONDITIONS, NEVER ON DURATIONS. A `waitForTimeout` is a bet
   that a machine is as fast as the machine the number was picked on, and CI's
   runners are not. The two exceptions are settle windows after an animation
   the app does not expose a flag for, and each is marked.
   ========================================================================== */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'verify-out');
const PORT = 8761;
const headed = process.argv.includes('--headed');

/* FAST is the day-to-day lane: push/PR CI and the local dev loop run it.
   FULL (no flag) is the pre-release / nightly lane and is the only one that
   proves everything.

   The split is safe only because of one rule: sections share this file's one
   `page`, and a later section may CONSUME what an earlier one produced. Today
   exactly one such pair exists — § 2 (kept, fast) produces `demoState`, which
   §§ 3–6 read — and both halves are in the fast lane, so nothing is at risk.
   Skipping a PRODUCER whose consumer stays in the fast lane would break the
   fast lane silently; don't. */
const FAST = process.argv.includes('--fast') || process.env.VERIFY_FAST === '1';

/* Every full-lane-only section runs through this, so the skip roster is
   DERIVED from the sites themselves and cannot drift from a hand-kept count.
   The editor's roster sat at 11 while the sites numbered 13, which is exactly
   the misreading ("a passing --fast run is a passing full run") the count was
   there to prevent. The tail prints the names. */
const skippedSections = [];
const fullOnly = (name) => {
  if (FAST) { skippedSections.push(name); return false; }
  return true;
};

/* The two timeout grades. NORMAL is the page default; SLOW is for the handful
   of actions that sit in front of real main-thread work — loading twelve
   packages and running the whole comparison sweep is seconds of boolean
   geometry, and it is the ACTION that needs the budget, not a wait after it.

   SLOW is a CATCHER, not a measurement. Nothing in this file may reason FROM
   it about what anything costs: the editor's § 6 did exactly that, asserted a
   cache with a stopwatch, and failed five nightlies running. */
const NORMAL = 30000;
const SLOW = 180000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  /* `.mjs` is not optional: it is what the Squire bundle ships under, and a
     module served as octet-stream is refused by the module loader. The
     vendored js/mdtext.js catches that and degrades to a plain source view by
     design — so a missing MIME type here does not fail, it LIES. */
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
  '.topojson': 'application/json; charset=utf-8',
  '.parquet': 'application/octet-stream',
  /* THE DEMO SET IS TWELVE `.json.gz` FILES. Served with the right
     content-type and NO content-encoding: the app gunzips them itself through
     the vendored js/gzip.js, and a server that set `content-encoding: gzip`
     would have the browser silently decompress first, handing the app plain
     JSON where it expects a gzip magic byte. That is the one server
     misconfiguration that makes `looksLikeGzip` a liar. */
  '.gz': 'application/gzip',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, normalize(rel === '/' ? '/index.html' : rel));
  if (!path.startsWith(ROOT) || !existsSync(path)) { res.writeHead(404); return res.end('not found'); }
  /* no-store: a stale stylesheet or a stale module is exactly the failure this
     run exists to catch, so the verifier must never look at a cached one. */
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(path));
});

let failures = 0;
const results = [];
const ok = (m) => { results.push(['ok', m]); console.log(`  ok   ${m}`); };
const bad = (m) => {
  failures++; results.push(['FAIL', m]); console.log(`  FAIL ${m}`);
  /* One screenshot per failing section, in EVERY lane. A fast-lane CI failure
     with no artifact leaves a re-run as the only way to look at it.
     Fire-and-forget: this is evidence, and it may never turn a failure into a
     hang. */
  if (!shotSections.has(currentStep)) {
    shotSections.add(currentStep);
    shot(`fail-${currentStep}`, { force: true }).catch(() => {});
  }
};
const shotSections = new Set();
const check = (c, m) => (c ? ok(m) : bad(m));

/* WHICH SECTION IS RUNNING, so a console error can say where it came from.
   § 10 fails the run on any console error, and an error that arrives with no
   location is an error somebody has to bisect a whole run for. */
let currentStep = 'before any section';
const step = (n, t) => {
  currentStep = `${n}. ${t}`;
  console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* A PORT ALREADY IN USE IS A SENTENCE, NOT A STACK TRACE. `server.listen`
   reports failure by emitting an 'error' event, and an unhandled one on an
   EventEmitter is an uncaught throw — so an interrupted previous run (a ^C
   between `listen` and `close`, which is most of them) greeted the next run
   with twenty lines of node internals and no hint of what to do about it. */
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, () => { server.removeListener('error', reject); resolve(); });
}).catch((err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n[verify] port ${PORT} is already in use — most likely a previous run that`);
    console.error('         did not get to close its server. Free it and try again:');
    console.error(`             lsof -ti :${PORT} | xargs kill\n`);
    process.exit(2);
  }
  console.error(`[verify] could not start the static server on ${PORT}: ${err?.message}`);
  process.exit(2);
});

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  /* § 6 reads the clipboard after "Copy brief". Without these the copy path
     silently takes its documented FALLBACK (download instead, one sentence
     saying so) and the section would be testing the fallback while believing
     it tested the clipboard. */
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
/* Playwright's own default, made explicit and greppable, so a bare call can no
   longer mean "whatever Playwright feels like". */
page.setDefaultTimeout(NORMAL);

/* ── the archive cache: A PROXY, NOT A FIXTURE ───────────────────────────────
   Only the seam engine's published far side reaches the archive, and only when
   a neighbour is unloaded — but a published week is ~3.5 MB and this suite
   boots the page a dozen times. A published week is IMMUTABLE, so the first
   fetch per week is LIVE (an origin outage still fails, and decode drift is
   still caught) and every later boot replays those same live bytes from
   tools/.cache — the same files tools/compare.test.mjs caches there.

   KEYED BY THE ARCHIVE DIRECTORY TOO. The masked (`parquet/`) and unclipped
   (`parquet_unclipped/`) products name their files identically, and a flat
   cache would serve one product's bytes for the other's URL.

   The MANIFEST is deliberately never cached: it is the one archive document
   that changes, and it stays a live fetch on every boot. */
const ARCHIVE_CACHE = join(ROOT, 'tools', '.cache');
await page.route('**/USDM_*.parquet', async (route) => {
  const segs = route.request().url().split('?')[0].split('/');
  const name = segs.pop();
  const dir = segs.pop();
  const path = join(ARCHIVE_CACHE, dir, name);
  if (existsSync(path)) {
    return route.fulfill({
      status: 200, contentType: 'application/octet-stream',
      headers: { 'access-control-allow-origin': '*' },
      body: readFileSync(path),
    });
  }
  const res = await route.fetch();
  const body = await res.body();
  if (res.status() === 200) {
    mkdirSync(join(ARCHIVE_CACHE, dir), { recursive: true });
    writeFileSync(path, body);
  }
  return route.fulfill({ response: res });
});

const consoleErrors = [];
const consoleWarnings = [];
const cspViolations = [];
page.on('console', (m) => {
  /* Warnings are COLLECTED BUT NEVER FAIL THE RUN, and § 10 prints them. A
     refused foreign origin and a seam whose far side could not be read are
     both the app working; but they are also the only trace of WHY, and a run
     that threw them away would make a real bug unplaceable. */
  if (m.type() === 'warning') { consoleWarnings.push(`[§ ${currentStep}] ${m.text()}`); return; }
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Content Security Policy/i.test(t)) cspViolations.push(`[§ ${currentStep}] ${t}`);
  consoleErrors.push(`[§ ${currentStep}] ${t}`);
});
page.on('pageerror', (e) => {
  /* THE STACK, not just the message. An uncaught throw from inside a vendored
     library names none of our code in its message. Trimmed to the first few
     frames, which is where the gesture is. */
  const frames = String(e.stack ?? '').split('\n').slice(1, 6)
    .map((f) => f.trim()).filter(Boolean).join(' ← ');
  consoleErrors.push(`[§ ${currentStep}] pageerror: ${e.message}`
    + (frames ? `\n         at ${frames}` : ''));
});
/* THE SECOND CHANNEL FOR A CSP BLOCK, and the one that matters. Chromium logs
   a violation to the console, but the console text is localised, reformatted
   between versions, and easy to miss; `securitypolicyviolation` is the event
   the platform guarantees. § 7 needs to prove a foreign origin was refused by
   the APP rather than by the browser, and that assertion is only as good as
   this listener. */
await page.addInitScript(() => {
  window.__cspHits = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspHits.push(`${e.violatedDirective} ${e.blockedURI}`);
  });

  /* ── the source reader, installed ONCE ─────────────────────────────────────
     Injected here rather than passed to `page.evaluate` as a string, because a
     string would have to be revived with `eval` INSIDE the page — and this
     page runs `script-src 'self'` with no `'unsafe-eval'`, so that call is
     blocked. `addInitScript` goes in through CDP before the document loads and
     is not subject to the page's CSP, which is also how the violation listener
     above survives.

     `GeoJSONSource.getData()` IS ASYNC IN MAPLIBRE v5 — it returns a Promise,
     and a Promise is a perfectly good object whose `.type` is undefined. A
     reader that forgets to await it falls into its own "not a
     FeatureCollection" branch and reports ONE feature for every source on the
     map: six assertions in this file quietly answered about the wrong object,
     and one of them PASSED, because "nothing covers this point" is true of a
     Promise too.

     `getSource()._data` is not the way out. It is a MapLibre PRIVATE field and
     in v5 is not GeoJSON at all (it holds `{ geojson: … }`, truthy and
     unparseable) — the editor's PNG export read it and shipped figures with no
     state lines on them for weeks. */
  window.__readSource = async (src) => {
    const m = window.__viewer?.ctx()?.map;
    const s = m?.getSource(src);
    if (!s) return null;
    let data = null;
    try { data = typeof s.getData === 'function' ? await s.getData() : null; } catch { data = null; }
    if (!data) { try { data = s.serialize?.()?.data ?? null; } catch { data = null; } }
    if (!data || typeof data === 'string') return null;
    return data;
  };

  /** Ray cast: does this ring contain the point? */
  window.__inRing = (ring, x, y) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  /** A polygon covers the point when its SHELL does and no HOLE does. */
  window.__inPoly = (rings, x, y) => window.__inRing(rings[0], x, y)
    && !rings.slice(1).some((r) => window.__inRing(r, x, y));
});

/* EVERY SCREENSHOT NAME IS SLUGIFIED, and it is not cosmetic: `bad()` shoots
   `fail-${currentStep}`, and a section title is prose with colons in it.
   actions/upload-artifact REFUSES a path containing any of " : < > | * ? and
   it refuses the WHOLE upload on the first one — so one colon in one title
   throws away every screenshot in the run and leaves a log line as the only
   evidence. Slugified here rather than at the call sites so a future title
   cannot reintroduce it. */
const slug = (name) => String(name).replace(/[\s:<>|*?"\\/\r\n]+/g, '-')
  .replace(/-+/g, '-').replace(/^-|-$/g, '');
const shot = (name, { force = false } = {}) => (FAST && !force) ? Promise.resolve()
  : page.screenshot({ path: join(OUT, `${slug(name)}.png`), fullPage: false });

const boot = (qs = '') => page.goto(`http://localhost:${PORT}/${qs}`, { waitUntil: 'load' });

/**
 * Wait for boot to have run ALL THE WAY TO THE END.
 *
 * Not "the map painted": `?load=` / `?demo` / `?pick` / `?show` / `?focus` are
 * applied LAST, after the map is up, precisely so a failed fetch leaves a
 * working read-only map rather than no map. A test that sampled the state
 * after the map loaded would read an empty session and report that `?demo`
 * did nothing. It did; it had not happened yet. `__viewer.booted` says so.
 */
const booted = (timeout = 180000) =>
  page.waitForFunction(() => window.__viewer?.booted === true, null, { timeout });

/** How many proposals the session holds, right now. 0 when there is no session. */
const loadedCount = () => page.evaluate(() => window.__viewer?.session?.size ?? 0);

/** Wait until the session holds at least `n` proposals AND the sweep has run. */
const loaded = (n, timeout = SLOW) => page.waitForFunction(
  (want) => (window.__viewer?.session?.size ?? 0) >= want
         && Array.isArray(window.__viewer?.findings),
  n, { timeout });

/** The one toast the kit's singleton is showing, or ''. */
const toastText = () => page.evaluate(() =>
  [...document.querySelectorAll('.ridr-toast')].map((n) => n.textContent.trim())
    .filter(Boolean).join(' | '));

/** Whatever the polite live region last said. */
const liveText = () => page.evaluate(() =>
  [...document.querySelectorAll('.sr-only[aria-live]')].map((n) => n.textContent.trim())
    .filter(Boolean).join(' | '));

/** Every CSP violation the PAGE saw, from the platform event. */
const cspHits = () => page.evaluate(() => window.__cspHits ?? []);

/**
 * A source's features, as properties and geometry TYPE only.
 *
 * The geometry itself is megabytes and crossing the bridge with it would make
 * every assertion in § 4 a transfer cost; the questions this file asks about
 * geometry are asked by `sourceCovers` and `interiorPoints`, which stay inside
 * the page. The reader itself is installed by `addInitScript` above — see the
 * note there on why it is not passed in as a string.
 */
const sourceFeatures = (id) => page.evaluate(async (src) => {
  const data = await window.__readSource(src);
  if (!data) return null;
  const feats = data.type === 'FeatureCollection' ? data.features : [data];
  return (feats ?? []).map((f) => ({
    properties: f.properties ?? {},
    type: f.geometry?.type ?? null,
  }));
}, id);

/**
 * Does the SOURCE geometry of `src` cover this longitude/latitude?
 *
 * Ray casting over every ring, HOLES INCLUDED — which is the whole reason this
 * is not `queryRenderedFeatures`. That call reports a hit for an interior ring
 * exactly as readily as an exterior one, so it is structurally incapable of
 * answering "is there a hole here", and the punch assertion is precisely that
 * question.
 */
const sourceCovers = (src, lng, lat, filter = null) => page.evaluate(
  async ({ src: s, lng: x, lat: y, filter: f }) => {
    const data = await window.__readSource(s);
    if (!data) return null;
    const feats = data.type === 'FeatureCollection' ? data.features : [data];
    for (const feat of feats ?? []) {
      if (f && Object.entries(f).some(([k, v]) => (feat.properties ?? {})[k] !== v)) continue;
      const g = feat.geometry;
      if (!g) continue;
      if (g.type === 'Polygon' && window.__inPoly(g.coordinates, x, y)) return true;
      if (g.type === 'MultiPolygon'
        && g.coordinates.some((rings) => window.__inPoly(rings, x, y))) return true;
    }
    return false;
  }, { src, lng, lat, filter });

/**
 * Points that are genuinely INSIDE the polygons of a source — one per feature.
 *
 * NEVER A BARE CENTROID. USDM polygons are wildly concave and a centroid is
 * regularly outside the shape it names; the editor records two investigations
 * that concluded Playwright could not drive MapLibre before finding that the
 * click had simply landed outside the polygon. So each candidate is TESTED
 * with the same ray cast that `sourceCovers` uses, and only the ones that hit
 * come back.
 *
 * The candidates are the part's bbox centre and a small lattice around it,
 * which finds an interior point for every real band in this app's data.
 */
const interiorPoints = (src, filter = null) => page.evaluate(
  async ({ src: s, filter: f }) => {
    const data = await window.__readSource(s);
    if (!data) return [];
    const feats = data.type === 'FeatureCollection' ? data.features : [data];
    const inPoly = window.__inPoly;
    const out = [];
    for (const feat of feats ?? []) {
      if (f && Object.entries(f).some(([k, v]) => (feat.properties ?? {})[k] !== v)) continue;
      const g = feat.geometry;
      if (!g) continue;
      const parts = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
      /* The LARGEST part first: a band's biggest piece is the one with room
         for an interior point, and the slivers are exactly where a lattice
         finds nothing. */
      const sized = parts.map((rings) => {
        const xs = rings[0].map((c) => c[0]), ys = rings[0].map((c) => c[1]);
        const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        return { rings, bb, span: (bb[2] - bb[0]) * (bb[3] - bb[1]) };
      }).sort((a, b) => b.span - a.span);

      let found = null;
      for (const { rings, bb } of sized) {
        const [w, s2, e, n] = bb;
        for (const fx of [0.5, 0.35, 0.65, 0.25, 0.75]) {
          for (const fy of [0.5, 0.35, 0.65, 0.25, 0.75]) {
            const x = w + (e - w) * fx, y = s2 + (n - s2) * fy;
            if (inPoly(rings, x, y)) { found = [x, y]; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) out.push({ point: found, properties: feat.properties ?? {} });
    }
    return out;
  }, { src, filter });

/** Every layer id on the map, in ladder order (bottom first). */
const layerIds = () => page.evaluate(() =>
  (window.__viewer?.ctx()?.map?.getStyle()?.layers ?? []).map((l) => l.id));

/** Where `id` sits in the ladder, or -1. */
const layerIndex = (ids, id) => ids.indexOf(id);

/** Is this layer visible right now? (`layout.visibility`, not a pixel read.) */
const layerVisible = (id) => page.evaluate((l) => {
  const m = window.__viewer?.ctx()?.map;
  if (!m || !m.getLayer(l)) return null;
  return m.getLayoutProperty(l, 'visibility') !== 'none';
}, id);

/** The three view segments' `aria-pressed`, as an object. */
const pressed = () => page.evaluate(() => Object.fromEntries(
  ['proposal', 'published', 'differences'].map((v) =>
    [v, document.getElementById(`view-${v}`)?.getAttribute('aria-pressed')])));

/** Click a view segment and wait for the app's own state to follow. */
async function setView(view) {
  await page.locator(`#view-${view}`).click();
  await page.waitForFunction((v) => window.__viewer?.view === v, view, { timeout: NORMAL });
}

/**
 * Load the demo set through the real control, and wait for the sweep.
 *
 * The BUTTON, not `?demo`, wherever a section is not specifically testing the
 * URL: the button is what a reader presses, and the two paths meet in
 * `loader.fromDemo()` — so driving the button covers the URL path's tail as
 * well while also proving the control is wired.
 */
async function loadDemo() {
  await page.locator('#btn-demo').click({ timeout: SLOW });
  await loaded(12);
}

/** A settle window for a CSS transition the app exposes no flag for. */
const SETTLE = 350;

/* ══════════════════════════════════════════════════════════════════════════ */

/** Filled by § 2 and read by §§ 3–6. See the FAST note at the top. */
let demoState = null;
/** Filled by § 4 and re-tested by § 5 — the two halves of the punch. */
let punchPoints = [];

try {

/* ══ § 1 · boot ═════════════════════════════════════════════════════════════ */

step(1, 'the page boots clean, and the CSP says exactly what it should');

await boot();
await booted();
await shot('01-boot');

{
  check(await page.evaluate(() => window.__viewer?.booted === true),
    'boot() ran all the way to the end');
  check(await page.title() === 'USDM Edit Viewer · NGP RIDR',
    `the title is ${JSON.stringify(await page.title())}`);

  /* ── the CSP, pinned exactly ──────────────────────────────────────────────
     Both halves matter and for different reasons. The HASH COUNT is one
     because this app has no import map: a second inline script would need a
     second hash, and growing one by accident is how a page starts carrying
     code nobody hashed. The `connect-src` SET is exact because a missing
     origin does not throw — `resolveBaseStyle` swallows the CSP failure by
     design and the app comes up looking like a deliberate no-basemap build. */
  const csp = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '');
  const scriptSrc = /script-src ([^;]*);/.exec(csp)?.[1] ?? '';
  const hashes = [...scriptSrc.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  check(hashes.length === 1,
    `script-src carries exactly ONE inline hash (${hashes.length}) — this app has no import map`);
  check(/script-src 'self'/.test(csp), "script-src is 'self' plus the hash, and names no other origin");

  const connect = (/connect-src ([^;]*);/.exec(csp)?.[1] ?? '').trim().split(/\s+/).sort();
  const wantConnect = [
    "'self'",
    'https://*.basemaps.cartocdn.com',
    'https://basemaps.cartocdn.com',
    'https://data.sustainable-fsa.com',
    'https://s3.amazonaws.com',
  ].sort();
  check(JSON.stringify(connect) === JSON.stringify(wantConnect),
    `connect-src is exactly the four origins: ${connect.join(' ')}`);
  check(/default-src 'none'/.test(csp), "default-src is 'none'");
  check(/style-src 'self'/.test(csp) && !/unsafe-inline/.test(csp),
    "style-src is 'self' with no 'unsafe-inline' — a style attribute would be DROPPED");
  check((await cspHits()).length === 0, 'the page reported no CSP violation on a clean boot');

  /* ── the empty state ─────────────────────────────────────────────────────
     It is the map's own surface, not a dialog, and it carries the two ways in.
     A first visit that opened a modal over the map would put a wall of prose
     where the two buttons should be. */
  check(await page.locator('#empty-state').isVisible(), 'the empty state is on screen');
  check(await page.locator('#empty-choose').isVisible()
     && await page.locator('#empty-demo').isVisible(),
    'with both ways in — choose files, or open the example set');
  check(await page.locator('#btn-briefs').isDisabled(),
    '#btn-briefs is disabled: there is nothing to write a brief about yet');
  check(await page.evaluate(() =>
    document.getElementById('info-modal')?.open !== true),
    'no dialog is open over the map on a first visit');

  /* The drawer's data sections start hidden — there is nothing in them. */
  for (const id of ['proposal-section', 'findings-section', 'legend-section']) {
    check(await page.locator(`#${id}`).isHidden(), `#${id} is hidden while nothing is loaded`);
  }

  /* The map itself came up, on real ground. */
  check(await page.evaluate(() => window.__viewer?.basemapDegraded === false),
    'the basemap resolved — this is not the blank-ground fallback');
  const ids = await layerIds();
  check(ids.includes('usdm-fill-D0') && ids.includes('aoi-line'),
    `the editor's layer ladder is mounted (${ids.length} layers)`);
  check(await page.evaluate(() =>
    document.querySelectorAll('.sr-only[aria-live]').length === 1),
    'exactly ONE live region — two would read every sentence twice');
}

/* ══ § 2 · the demo set ═════════════════════════════════════════════════════ */

step(2, 'the demo set loads: twelve proposals over five working areas');

await boot('?demo');
await booted();
await loaded(12);
await shot('02-demo');

{
  demoState = await page.evaluate(() => {
    const v = window.__viewer;
    const list = v.ctx().proposals ?? [];
    return {
      count: list.length,
      week: v.ctx().week,
      areas: [...new Set(list.map((p) => p.aoi?.id))],
      letters: list.map((p) => v.ctx().markFor?.(p.id)?.letter ?? null),
      shortIds: list.map((p) => p.shortId),
      findings: (v.findings ?? []).map((f) => ({
        id: f.id, kind: f.kind, areaKm2: f.areaKm2 ?? null,
        magnitude: f.magnitude ?? null, maxStep: f.maxStep ?? null,
        reciprocal: f.reciprocal ?? null, aoiId: f.aoiId ?? null,
        aoiIds: f.aoiIds ?? null,
        classA: f.classA ?? null, classB: f.classB ?? null,
        published: f.published ?? null,
        directionA: f.directionA ?? null, directionB: f.directionB ?? null,
        anchor: f.anchor ?? null,
      })),
    };
  });

  check(demoState.count === 12, `${demoState.count} proposals loaded`);
  check(demoState.week === '2026-09-08', `for the week of ${demoState.week}`);
  check(demoState.areas.length === 5,
    `over ${demoState.areas.length} working areas: ${demoState.areas.join(', ')}`);

  /* LETTERS ARE THE TEXT TWIN OF THE DASH and must be unique on screen — a
     repeated letter makes the legend name two different proposals the same
     thing. Load order is what assigns them, so the twelfth is L. */
  const letters = demoState.letters.filter(Boolean);
  check(letters.length === 12 && new Set(letters).size === 12,
    `twelve distinct letters, ${letters[0]}…${letters[11]}`);

  /* The drawer's three sections came up with it. */
  for (const id of ['proposal-section', 'findings-section', 'legend-section']) {
    check(await page.locator(`#${id}`).isVisible(), `#${id} is shown now there is something in it`);
  }
  check(await page.locator('#empty-state').isHidden(), 'and the empty state is gone');

  /* ── the session line ────────────────────────────────────────────────────
     One sentence: the week, the count, the areas, and all three finding counts
     — always all three, because "no conflicts" is a finding in its own right
     and a sentence that drops the word reads as one that did not look. */
  const session = (await page.locator('#session-line').textContent()).trim();
  check(/Week 2026-09-08/.test(session), `the session line names the week: ${JSON.stringify(session)}`);
  check(/12 proposals over 5 working areas/.test(session),
    'and the count and the areas');
  check(/conflicts?,/.test(session) && /one-sided/.test(session) && /seams?/.test(session),
    'and all three finding counts');

  /* ── the rows ────────────────────────────────────────────────────────────— */
  const rows = await page.locator('.proposal-row').count();
  check(rows === 12, `${rows} proposal rows in the drawer`);
  const groups = await page.locator('.proposal-group').count();
  check(groups === 5, `grouped into ${groups} working areas`);
  check(await page.locator('.proposal-row input[type="checkbox"]').count() === 12,
    'each with a checkbox that shows and hides it');
  check(await page.locator('.proposal-row .mark-swatch').count() === 12,
    'and a mark swatch beside the author — the dash the map draws');

  /* THE RE-CHECK IS DEFERRED, one proposal per tick, because reading
     `p.integrity` costs 106–663 ms per package and touching twelve inside the
     render would freeze the drawer. So it is waited for, not sampled. */
  await page.waitForFunction(() => {
    const lines = [...document.querySelectorAll('.recheck-line')];
    return lines.length === 12 && lines.every((n) => !/checking/i.test(n.textContent));
  }, null, { timeout: SLOW });
  const verdicts = await page.evaluate(() =>
    [...document.querySelectorAll('.recheck-line')].map((n) => n.textContent.trim()));
  check(verdicts.every((t) => /^Re-check:/.test(t)),
    'every row carries a re-check verdict once the queue drains');
  /* TEN OF THE TWELVE GRADE `residue`, and a residue grade is NOT a warning.
     A panel that painted ten of twelve reference proposals as defective would
     be the exact failure the magnitude grading exists to prevent. */
  const defects = await page.locator('.recheck-line.is-defect').count();
  check(defects === 0,
    `no proposal is graded a DEFECT (${defects}) — residue is residue, not a problem`);
  check(verdicts.some((t) => /residue/i.test(t)),
    'and at least one says so in the word: clipper residue, not an edit');

  /* ── the live region ─────────────────────────────────────────────────────
     The canvas is invisible to a screen reader; this sentence is the whole
     reading of what just happened for a third of this app's readers. */
  const said = await liveText();
  check(/12 proposals loaded for the week of 2026-09-08/.test(said),
    `the live region said: ${JSON.stringify(said.slice(0, 140))}`);
  check(/conflicts are listed first/.test(said),
    'and that conflicts are listed first');

  check(await page.locator('#btn-briefs').isEnabled(),
    '#btn-briefs is enabled now that there are findings to write about');
}

/* ══ § 3 · the findings ═════════════════════════════════════════════════════ */

/* ── PRESSING DEMO WITH THE DEMO ALREADY UP ────────────────────────────
   Kyle opened the live site and found the same sentence painted over the map
   twelve times — "That proposal is already loaded." × 12 — with a toast
   claiming "12 proposals loaded, with 12 warnings". The session answers a
   duplicate with an alreadyLoaded WARNING per package, and the intake painted
   every warning. A repeat of a set you already have changes nothing, so it
   says so once and paints nothing. Waited on the toast, asserted on the note. */
await page.click('#btn-demo');
await page.waitForFunction(() => [...document.querySelectorAll('.ridr-toast')]
  .some((t) => /already loaded/.test(t.textContent)), null, { timeout: 60000 });
const repeat = await page.evaluate(() => ({
  toast: [...document.querySelectorAll('.ridr-toast')].map((t) => t.textContent.trim())
    .find((t) => /already loaded/.test(t)) ?? '',
  noteHidden: document.getElementById('app-note')?.hidden !== false
    || !document.getElementById('app-note')?.textContent.trim(),
  painted: (document.getElementById('app-note')?.textContent.match(/already loaded/g) ?? []).length,
  rows: document.querySelectorAll('.proposal-row').length,
}));
check(repeat.toast === 'Those 12 proposals are already loaded.',
  `pressing Demo again says it ONCE, as one sentence: "${repeat.toast}"`);
check(repeat.noteHidden && repeat.painted === 0,
  `and paints nothing over the map (${repeat.painted} copies in #app-note)`);
check(repeat.rows === 12, `the drawer still lists twelve — nothing was added or doubled (${repeat.rows})`);

step(3, 'the findings: conflicts first, and the three the fixtures name');

{
  const f = demoState.findings;
  check(f.length > 0, `${f.length} findings in the ranked list`);

  const kinds = f.map((x) => x.kind);
  const firstOneSided = kinds.indexOf('one-sided');
  const firstSeam = kinds.indexOf('seam');
  const lastConflict = kinds.lastIndexOf('conflict');
  const conflicts = f.filter((x) => x.kind === 'conflict');
  check(conflicts.length >= 1, `${conflicts.length} conflict(s)`);
  /* CONFLICTS FIRST, ALWAYS. Two proposals answering the same ground
     differently is what a reconciliation meeting exists to settle; a one-sided
     difference usually is not a disagreement at all. */
  check(lastConflict === -1 || firstOneSided === -1 || lastConflict < firstOneSided,
    'every conflict is ranked above every one-sided difference');
  check(lastConflict === -1 || firstSeam === -1 || lastConflict < firstSeam,
    'and above every seam');

  /* ── the Milk River Hi-Line conflict ─────────────────────────────────────
     MT-4ab1b4a8 (the dissent) improves the block MT-06e8fb67 degraded: two
     readings of one week, opposite ways, over the same ~5,665 km², published
     D0, two classes apart. compare.test.mjs § 5b owns the numbers; this owns
     that the number reached the page. */
  const hiLine = conflicts.find((r) => r.areaKm2 > 5000
    && r.anchor && r.anchor[1] > 48 && r.anchor[1] < 49.1
    && r.anchor[0] > -108 && r.anchor[0] < -106);
  check(!!hiLine, 'the Milk River Hi-Line conflict is in the list');
  if (hiLine) {
    check(Math.abs(hiLine.areaKm2 - 5665) < 120,
      `over ${hiLine.areaKm2.toFixed(0)} km² (the block Reyes degraded is 5,665)`);
    check(hiLine.published === 'D0' && hiLine.magnitude === 2,
      `published ${hiLine.published}, and the two answers are ${hiLine.magnitude} classes apart`);
    check(hiLine.directionA !== hiLine.directionB
      && hiLine.directionA !== 'unchanged' && hiLine.directionB !== 'unchanged',
      `in OPPOSITE directions: ${hiLine.directionA} against ${hiLine.directionB}`);
    check(/^disc:[0-9a-f]{8}/.test(hiLine.id),
      `and its id is a deterministic ${hiLine.id} (docs/contracts.md § 8)`);
  }

  /* ── the seams ───────────────────────────────────────────────────────────— */
  const seams = f.filter((x) => x.kind === 'seam');
  check(seams.length >= 2, `${seams.length} seams`);
  check(seams.every((s) => /^seam:[0-9a-f]{8}/.test(s.id)),
    'every seam id is deterministic too');

  /* The SD/NE line: both states degraded up to it, so the seam is RECIPROCAL
     — the one in the original ten. */
  const sdne = await page.evaluate(() => (window.__viewer.seams ?? []).map((s) => ({
    id: s.id, reciprocal: s.reciprocal, maxStep: s.maxStep, lengthKm: s.lengthKm,
    aois: (s.aoiIds ?? []).slice().sort(),
    sides: [s.sideA?.proposal?.shortId ?? s.sideA?.kind, s.sideB?.proposal?.shortId ?? s.sideB?.kind],
    twoClassNew: (s.runs ?? []).filter((r) => Math.abs(r.step ?? 0) === 2 && r.kind === 'new').length,
    opposed: (s.runs ?? []).some((r) => r.kind === 'new' && r.changedBy === 'both'),
  })));
  const sdneSeam = sdne.find((s) => s.sides.includes('9c26907b') && s.sides.includes('3f4c9136'));
  check(!!sdneSeam, 'the SD-9c26907b × NE-3f4c9136 seam is found');
  if (sdneSeam) {
    check(sdneSeam.reciprocal === true, 'and it is RECIPROCAL — both sides carry a proposal');
    check(sdneSeam.lengthKm > 660 && sdneSeam.lengthKm < 700,
      `along ${sdneSeam.lengthKm.toFixed(0)} km of shared line (measured 681.5)`);
  }

  /* The MT-dissent × WY seam: Montana improved its side down to the 45° line
     while Wyoming degraded up to it. Opposite directions, two classes apart,
     across a jurisdiction line — which is almost never physical. */
  const mtwy = sdne.find((s) => s.sides.includes('4ab1b4a8') && s.sides.includes('53bc5877'));
  check(!!mtwy, 'the MT-4ab1b4a8 × WY-53bc5877 seam is found');
  if (mtwy) {
    check(mtwy.reciprocal === true, 'it is reciprocal');
    check(mtwy.maxStep >= 2, `with a step of ${mtwy.maxStep} classes at its worst`);
    check(mtwy.twoClassNew > 0,
      `${mtwy.twoClassNew} NEW run(s) two classes apart — the published map had no such step`);
    check(mtwy.opposed === true, 'and both sides moved the ground they abut, in opposite directions');
  }

  /* ── THE LIST IS THE MAP'S TEXT TWIN ─────────────────────────────────────
     Same findings, same rank order, three lines each. A canvas a screen reader
     cannot see is only as good as the list beside it. */
  const domIds = await page.evaluate(() =>
    [...document.querySelectorAll('.finding-row')].map((b) => b.dataset.findingId));
  check(domIds.length === f.length,
    `the panel lists all ${domIds.length} findings (the model has ${f.length})`);
  check(JSON.stringify(domIds) === JSON.stringify(f.map((x) => x.id)),
    'in exactly the model’s rank order — the list IS the map’s text twin');
  const firstRow = page.locator('.finding-row').first();
  check(await firstRow.locator('.finding-where').count() === 1
     && await firstRow.locator('.finding-what').count() === 1
     && await firstRow.locator('.finding-size').count() === 1,
    'and each row is three lines: where, what, how big');

  /* The count is mirrored into a role=status sentence — the same number, in
     words, for a reader who cannot count rows. */
  const status = (await page.locator('#findings-status').textContent()).trim();
  check(status.length > 0 && /\d/.test(status),
    `#findings-status carries the count in words: ${JSON.stringify(status.slice(0, 120))}`);
}

/* ══ § 4 · what the map paints ══════════════════════════════════════════════ */

step(4, 'the map paints it — asserted against SOURCE data, never a rendered query');

{
  /* ── the findings source holds exactly the findings ──────────────────────— */
  const findingFeats = await sourceFeatures('findings');
  check(findingFeats !== null, 'the `findings` source exists');
  if (findingFeats) {
    const regions = demoState.findings.filter((f) => f.kind !== 'seam');
    check(findingFeats.length === regions.length,
      `it holds ${findingFeats.length} features for ${regions.length} region findings`);
    check(findingFeats.every((f) => typeof f.properties.id === 'string'
      && ['conflict', 'one-sided'].includes(f.properties.kind)),
      'every feature carries the id and kind the panel and the card key on');
  }
  /* The `seams` source carries one feature PER RUN, not per seam — which is
     what its property list says (`step` and `lengthKm` are a Run's fields; a
     Seam has `maxStep`). A seam with a two-class step over 6 km and a
     one-class step over 90 km is two marks on the map and must be, because
     they are different disjunctures along one line. */
  const seamFeats = await sourceFeatures('seams');
  const seamFindings = demoState.findings.filter((f) => f.kind === 'seam');
  check(seamFeats !== null && seamFeats.length >= seamFindings.length,
    `the \`seams\` source holds ${seamFeats?.length} run features for ${seamFindings.length} seams`);
  if (seamFeats?.length) {
    const seamIds = new Set(seamFindings.map((s) => s.id));
    check(seamFeats.every((f) => seamIds.has(f.properties.id)),
      'and every run is keyed to a seam the panel lists — nothing paints that is not in the text twin');
    check(new Set(seamFeats.map((f) => f.properties.id)).size === seamFindings.length,
      'with every seam represented');
  }

  /* ── the picked proposal's classes are in `usdm-edit` ────────────────────— */
  const pick = await page.evaluate(() => {
    const p = window.__viewer.ctx().pick;
    return p ? { id: p.id, shortId: p.shortId, aoiId: p.aoi?.id, bbox: p.aoi?.bbox } : null;
  });
  check(!!pick, `a proposal is picked by default: ${pick?.shortId} over ${pick?.aoiId}`);
  const editFeats = await sourceFeatures('usdm-edit');
  check(editFeats !== null && editFeats.length > 0,
    `the \`usdm-edit\` source carries the picked proposal's ${editFeats?.length} class bands`);
  if (editFeats?.length) {
    check(editFeats.every((f) => /^D[0-4]$/.test(String(f.properties.usdm_class))),
      'each tagged with its USDM class, which is what the five fills filter on');
  }

  /* ── THE PUNCH ───────────────────────────────────────────────────────────
     The published week is painted with the picked proposal's working area cut
     OUT of it, so exactly one group covers any pixel. Without the punch an
     improvement changes nothing on screen, because an opaque fill can only
     ADD — the proposal's D1 would sit invisibly under the published D2 and the
     whole edit would look like it did not take.

     Asserted against SOURCE geometry, and it has to be: the question is "is
     there a HOLE here", and `queryRenderedFeatures` reports a hit for an
     interior ring exactly as readily as an exterior one. It is structurally
     incapable of answering.

     THE POINTS ARE INTERIOR POINTS OF THE PROPOSAL'S OWN BANDS, never the
     AOI's bbox centre. A bbox centre proves nothing: if the published week has
     no drought there, "not covered" is true with or without a punch, and the
     assertion passes forever while the punch is broken. A point inside the
     picked proposal's painted band is a point where SOMETHING must cover the
     pixel — so the published source not covering it is the punch, and § 5
     re-tests these same points in the Published view, where the hole is filled
     back in and they must be covered again. Neither half means much alone. */
  punchPoints = await interiorPoints('usdm-edit');
  check(punchPoints.length > 0,
    `${punchPoints.length} interior point(s) inside the picked proposal's own bands`);
  if (punchPoints.length) {
    const insideEdit = [];
    const insidePublished = [];
    for (const { point: [x, y] } of punchPoints) {
      insideEdit.push(await sourceCovers('usdm-edit', x, y));
      insidePublished.push(await sourceCovers('usdm', x, y));
    }
    check(insideEdit.every((v) => v === true),
      'every one is genuinely inside the proposal source — the picker tests, it does not trust a centroid');
    check(insidePublished.every((v) => v === false),
      `and the published source covers NONE of them (${insidePublished.filter(Boolean).length} hits) ` +
      '— the working area is punched out of it');
    const anyPublished = (await sourceFeatures('usdm'))?.length ?? 0;
    check(anyPublished > 0,
      `while the published source is not merely empty — it holds ${anyPublished} band features`);
  }

  /* ── the ladder ──────────────────────────────────────────────────────────
     Order is behaviour here, not decoration: `findings-fill` sits UNDER
     `hillshade-over` so terrain reads through it the way it reads through the
     classes, and every viewer line sits under the place labels, which are the
     one symbol allowed over the drought ramp because a glyph replaces pixels
     rather than blending them. */
  const ids = await layerIds();
  const firstPlace = ids.findIndex((id) => /^place_|^watername_/.test(id));
  const want = ['findings-fill', 'hillshade-over', 'seams-line'];
  for (const id of want) check(ids.includes(id), `the ladder carries \`${id}\``);
  if (want.every((id) => ids.includes(id))) {
    check(layerIndex(ids, 'findings-fill') < layerIndex(ids, 'hillshade-over'),
      'findings-fill sits UNDER hillshade-over — terrain reads through it');
    check(layerIndex(ids, 'hillshade-over') < layerIndex(ids, 'seams-line'),
      'and the seam lines sit above the hillshade');
  }
  check(firstPlace === -1 || layerIndex(ids, 'seams-line') < firstPlace,
    'every viewer line is below the first raised place label');
  /* FOUR patch layers, because `line-dasharray` is not data-driven in
     MapLibre. Collapsing them to one is the refactor that silently makes every
     proposal draw the same dash. */
  const patchLayers = ids.filter((id) => /^patches-line-\d$/.test(id));
  check(patchLayers.length === 4,
    `four patches-line-* layers (${patchLayers.length}) — line-dasharray is not data-driven`);
  check(ids.includes('anchors-label'),
    'and the anchor letters are a symbol layer — the one documented doctrine exception');

  /* One rendered query, and only for the question rendered queries CAN answer:
     is anything painting at all. */
  const paintedClasses = await page.evaluate(() => {
    const m = window.__viewer?.ctx()?.map;
    if (!m?.isStyleLoaded()) return -1;
    return m.queryRenderedFeatures({ layers:
      ['usdm-fill-D0', 'usdm-fill-D1', 'usdm-fill-D2', 'usdm-fill-D3', 'usdm-fill-D4'] }).length;
  });
  check(paintedClasses > 0, `the class fills are painting (${paintedClasses} rendered features)`);
  await shot('04-paints');
}

/* ══ § 5 · the three views ══════════════════════════════════════════════════ */

step(5, 'the three views are modes, and the URL carries them');

{
  check(JSON.stringify(await pressed())
      === JSON.stringify({ proposal: 'true', published: 'false', differences: 'false' }),
    'A proposal is pressed at rest, and it alone');

  await setView('differences');
  await shot('05-differences');
  check(JSON.stringify(await pressed())
      === JSON.stringify({ proposal: 'false', published: 'false', differences: 'true' }),
    'pressing Differences moves the pressed state, and only one is pressed');
  /* THE CLASS FILLS ARE HIDDEN in Differences, because NDMC's change ramp is
     painted at 1.0 over the findings and two published encodings competing for
     one pixel is the one thing this app may never do. */
  check(await layerVisible('usdm-fill-D2') === false,
    'the class fills are hidden — the change ramp has the map to itself');
  check(await layerVisible('findings-fill') === true, 'and findings-fill is visible');
  /* Patch outlines go off: in Differences the subject is the disagreement, not
     who drew what. */
  check(await layerVisible('patches-line-0') === false,
    'patch outlines are off — the subject here is the disagreement');
  check(await page.locator('#pick-row').isHidden(),
    'and the "whose classes to paint" picker is gone: no proposal is painted');

  await setView('published');
  check(await layerVisible('usdm-fill-D2') === true, 'Published brings the class fills back');
  /* ── THE OTHER HALF OF THE PUNCH ─────────────────────────────────────────
     The same points § 4 proved the published source does NOT cover. Here the
     hole is filled back in, so it must cover them again — and it is a DATA
     SWAP rather than a hide, because hiding the punched fills would leave the
     hole on screen with nothing in it.

     "At least one", not "all": the proposal may legitimately paint drought
     where the published week had none (that is what a degradation IS), so
     demanding every point would be demanding the proposal changed nothing.
     One point recovering is enough to prove the swap happened, and § 4 already
     proved all of them were missing. */
  if (punchPoints.length) {
    const back = [];
    for (const { point: [x, y] } of punchPoints) back.push(await sourceCovers('usdm', x, y));
    check(back.some((v) => v === true),
      `UNPUNCHED — the published week covers ${back.filter(Boolean).length} of ` +
      `${back.length} points it had a hole over, so the swap is data, not a hide`);
  }

  await setView('proposal');
  check(await page.locator('#pick-row').isVisible(), 'and A proposal brings the picker back');

  /* ── the legend follows the view ─────────────────────────────────────────
     Every swatch carries its NAME. Both published ramps are CVD-hostile
     through their middles; a bare swatch is not a reading. */
  const legendNamed = await page.evaluate(() =>
    [...document.querySelectorAll('#legend-body .legend-row')]
      .every((r) => (r.textContent ?? '').trim().length > 0));
  check(legendNamed, 'every legend row carries a name beside its swatch');
  const classLegend = await page.locator('#legend-body').textContent();
  check(/Severe|Moderate|Extreme|Exceptional|Abnormally/.test(classLegend ?? ''),
    'the class ramp names its classes in words in the proposal view');

  await setView('differences');
  const changeLegend = await page.locator('#legend-body').textContent();
  check(/No change/i.test(changeLegend ?? ''),
    'and the change ramp carries the labelled hole: "No change — unshaded"');
  await setView('proposal');

  /* ── `?view=` boots ──────────────────────────────────────────────────────— */
  await boot('?demo&view=differences');
  await booted();
  await loaded(12);
  check(await page.evaluate(() => window.__viewer.view) === 'differences',
    '?view=differences boots straight into it');
  check((await pressed()).differences === 'true', 'with the segment pressed to match');
}

/* ══ § 6 · a finding card, and the brief that leaves the browser ════════════ */

step(6, 'a finding opens a card with both authors, and a brief downloads');

{
  await boot('?demo');
  await booted();
  await loaded(12);

  /* Open the FIRST CONFLICT through the list — the row a reader clicks, not a
     model call, because the wiring between the two is what this proves. */
  const row = page.locator('#findings-conflicts .finding-row').first();
  check(await row.count() === 1, 'there is a conflict row to open');
  const findingId = await row.getAttribute('data-finding-id');
  await row.click();
  await page.waitForFunction(() => document.getElementById('detail-card')?.hidden === false,
    null, { timeout: NORMAL });
  await shot('06-finding-card');

  const title = (await page.locator('#card-title').textContent()).trim();
  check(/^Conflict/.test(title), `the card is titled ${JSON.stringify(title)}`);
  check(await page.evaluate(() => window.__viewer.ctx().selection?.id) === findingId,
    'and the app’s selection is the finding that was clicked');
  check(await page.evaluate(() =>
    document.querySelector('.finding-row[aria-current="true"]')?.dataset.findingId)
    === findingId,
    'the row marks itself current — the same attribute a screen reader reads');

  /* ── THE SIDE-BY-SIDE ────────────────────────────────────────────────────
     A disagreement is two answers about one piece of ground. Reading them one
     after the other asks the reader to hold the first in their head while they
     read the second, which is the thing they came here to compare. */
  const sides = await page.locator('#card-content .side').count();
  check(sides === 2, `the body is a side-by-side grid with ${sides} columns`);
  const cardText = await page.locator('#card-content').textContent();
  const authors = await page.evaluate((id) => {
    const f = window.__viewer.ctx().findingById(id);
    const byId = (pid) => window.__viewer.ctx().proposalById(pid)?.author?.name ?? null;
    return [byId(f?.proposalA), byId(f?.proposalB)].filter(Boolean);
  }, findingId);
  check(authors.length === 2, `the finding names two authors: ${authors.join(' and ')}`);
  check(authors.every((a) => (cardText ?? '').includes(a)),
    'and the card shows both of them');
  check(await page.locator('#card-content .questions li').count() >= 3,
    'with at least three questions for discussion');

  /* ── the brief ───────────────────────────────────────────────────────────— */
  check(await page.locator('#brief-download').count() === 1
     && await page.locator('#brief-copy').count() === 1,
    'both transports are on the card');
  /* NO TRANSPORT LABEL CONTAINS ANOTHER'S — "Copy brief" and "Download brief
     (.md)" share no substring, and neither sits inside the navbar's "Briefs —
     download every finding as markdown". */
  const names = await page.evaluate(() => {
    const acc = (n) => (n?.getAttribute('aria-label') ?? n?.textContent ?? '').trim();
    return [acc(document.getElementById('brief-download')), acc(document.getElementById('brief-copy')),
            acc(document.getElementById('btn-briefs'))];
  });
  const contained = names.some((a, i) => names.some((b, j) =>
    i !== j && a && b && a.toLowerCase().includes(b.toLowerCase())));
  check(!contained, `no transport label contains another's: ${names.map((n) => JSON.stringify(n)).join(', ')}`);

  const dl = page.waitForEvent('download', { timeout: SLOW });
  await page.locator('#brief-download').click();
  const download = await dl;
  const name = download.suggestedFilename();
  check(/\.md$/.test(name), `the download is markdown: ${name}`);
  check(name.includes('2026-09-08'), 'and the filename leads with the week');

  const path = join(OUT, 'brief.md');
  await download.saveAs(path);
  const md = readFileSync(path, 'utf8');
  check(authors.every((a) => md.includes(a)), 'the brief names both authors');
  check(/\?focus=/.test(md), 'and links back with ?focus= so the reader can open what it is about');
  check(md.includes(findingId), `by this finding's own id (${findingId})`);
  /* MILES ON SCREEN AND IN THE BRIEF, metric only in the JSON keys. */
  check(/mi²|square miles/.test(md), 'areas are in square miles');
  check(!/\bkm²/.test(md), 'and never in km² — metric is a key name, not a sentence');

  /* Closing the card clears the selection, which is what un-highlights the map
     and the row together. */
  await page.locator('#card-close').click();
  await page.waitForFunction(() => document.getElementById('detail-card')?.hidden === true,
    null, { timeout: NORMAL });
  check(await page.evaluate(() => window.__viewer.ctx().selection) === null,
    'closing the card clears the selection');
}

/* ══ § 7 · ?load= ═══════════════════════════════════════════════════════════ */

if (fullOnly('7')) {
  step(7, '?load= takes two files — and refuses a foreign origin BY NAME');

  const two = [
    'demo/usdm-proposal-2026-09-08-state-MT-06e8fb67.json.gz',
    'demo/usdm-proposal-2026-09-08-state-MT-4ab1b4a8.json.gz',
  ].join(',');
  await boot(`?load=${encodeURIComponent(two)}`);
  await booted();
  await loaded(2);
  check(await loadedCount() === 2, '?load= with two same-origin urls loads both');
  check(await page.evaluate(() =>
    (window.__viewer.findings ?? []).some((f) => f.kind === 'conflict')),
    'and the pair’s conflict is found — the Hi-Line, from a URL');

  /* ── THE FOREIGN ORIGIN ──────────────────────────────────────────────────
     Refused BY THIS APP, with a sentence, BEFORE the fetch. This is the whole
     reason js/load.js checks at all: a CSP block produces a console line
     nobody reads and no sentence whatsoever, so an unchecked fetch to a third
     origin is indistinguishable from a network failure. Both halves are
     asserted — the sentence, and the ABSENCE of a violation. */
  await page.evaluate(() => { window.__cspHits = []; });
  await boot('?load=https%3A%2F%2Fexample.com%2Fproposal.json.gz');
  await booted();
  /* Wait for the app to have SAID something rather than for a duration: the
     refusal is synchronous but the toast is the kit's singleton. */
  await page.waitForFunction(() => {
    const t = [...document.querySelectorAll('.ridr-toast')].map((n) => n.textContent).join(' ');
    const note = document.getElementById('app-note')?.textContent ?? '';
    return /origin/i.test(t) || /origin/i.test(note);
  }, null, { timeout: NORMAL }).catch(() => {});

  const said = `${await toastText()} ${(await page.locator('#app-note').textContent()) ?? ''}`;
  check(/example\.com/.test(said) && /is not an origin this tool will fetch from/.test(said),
    `refused by name: ${JSON.stringify(said.trim().slice(0, 160))}`);
  check(await loadedCount() === 0, 'and nothing was loaded');
  const hits = await cspHits();
  check(hits.length === 0,
    `with NO CSP violation (${hits.length}) — the app refused it, not the browser`);
  await shot('07-foreign-origin');
}

/* ══ § 8 · the picker, and what it refuses ══════════════════════════════════ */

if (fullOnly('8')) {
  step(8, 'the file picker: four kinds of file, four sentences');

  await boot();
  await booted();

  /**
   * Hand the page a file through the real `<input type=file>`, the way a
   * reader does. `setInputFiles` with an in-memory buffer, so a fixture never
   * has to be written to disk and cleaned up after.
   */
  const pick = async (name, mimeType, buffer) => {
    await page.setInputFiles('#load-file-input', [{ name, mimeType, buffer }]);
    /* Wait for the app to answer — a sentence or a changed count, never a
       duration. */
    await page.waitForFunction((before) => {
      const t = [...document.querySelectorAll('.ridr-toast')].map((n) => n.textContent).join(' ');
      const note = document.getElementById('app-note')?.textContent ?? '';
      return (window.__viewer?.session?.size ?? 0) !== before || t.trim() || note.trim();
    }, await loadedCount(), { timeout: SLOW }).catch(() => {});
    return `${await toastText()} ${(await page.locator('#app-note').textContent()) ?? ''}`;
  };

  /* 1. A real proposal, gzipped, as the demo ships it. */
  const real = readFileSync(join(ROOT, 'demo/usdm-proposal-2026-09-08-state-MT-06e8fb67.json.gz'));
  await pick('mt.json.gz', 'application/gzip', real);
  check(await loadedCount() === 1, 'a gzipped proposal loads through the picker');

  /* 2. The SAME proposal again — deduped by id, not silently doubled. */
  const dupSaid = await pick('mt-again.json.gz', 'application/gzip', real);
  check(await loadedCount() === 1, 'the same proposal a second time stays one proposal');
  check(/already loaded/i.test(dupSaid), `and says so: ${JSON.stringify(dupSaid.trim().slice(0, 90))}`);

  /* 3. A proposal for ANOTHER WEEK — refused, naming both weeks, because a
        session is one week by definition and quietly comparing across two
        would produce differences that are calendar, not drought. */
  const other = JSON.parse(gunzipSync(real).toString('utf8'));
  other.id = `${other.id}-otherweek`;
  other.baseline = { ...other.baseline, week: '2026-09-01' };
  const weekSaid = await pick('other-week.json',
    'application/json', Buffer.from(JSON.stringify(other)));
  check(await loadedCount() === 1, 'a proposal for another week is not loaded');
  check(/2026-09-01/.test(weekSaid) && /2026-09-08/.test(weekSaid),
    `and the refusal names BOTH weeks: ${JSON.stringify(weekSaid.trim().slice(0, 150))}`);

  /* 4. Not a proposal at all — named by the schema it actually carries. */
  const notOne = await pick('notes.json', 'application/json',
    Buffer.from(JSON.stringify({ schema: 'usdm-session-archive/1', hello: true })));
  check(/not a USDM proposal file/i.test(notOne),
    `a session archive is refused by its schema: ${JSON.stringify(notOne.trim().slice(0, 130))}`);

  /* 5. A version 1 proposal — refused with the way forward, not just a no. */
  const v1 = await pick('old.json', 'application/json',
    Buffer.from(JSON.stringify({ schema: 'usdm-edit-proposal/1' })));
  check(/version 1/i.test(v1) && /editor/i.test(v1),
    `and a /1 package is told how to become comparable: ${JSON.stringify(v1.trim().slice(0, 140))}`);

  /* 6. Not JSON at all. */
  const junk = await pick('photo.json', 'application/json', Buffer.from([0x00, 0x01, 0x02, 0x03]));
  check(/could not be read as JSON|neither JSON nor gzipped/i.test(junk),
    `and a file that is not JSON says which: ${JSON.stringify(junk.trim().slice(0, 120))}`);
  await shot('08-picker');
}

/* ══ § 9 · the URL round-trips ══════════════════════════════════════════════ */

if (fullOnly('9')) {
  step(9, 'the URL: defaults emit nothing, and every state reproduces');

  await boot();
  await booted();
  check(await page.evaluate(() => location.search) === '',
    'a view at defaults emits NO query string — camera included');

  await boot('?demo');
  await booted();
  await loaded(12);

  /* Pick a different proposal and show a subset, then read the address bar. */
  const state = await page.evaluate(() => {
    const v = window.__viewer.ctx();
    const list = v.proposals;
    const pick = list[1];
    v.setPick(pick.id);
    v.setShown([list[0].id, list[1].id]);
    return { pick: pick.shortId, shown: [list[0].shortId, list[1].shortId] };
  });
  await page.waitForFunction((want) => new URLSearchParams(location.search).get('pick') === want,
    state.pick, { timeout: NORMAL });
  const q = new URLSearchParams(await page.evaluate(() => location.search));
  check(q.get('pick') === state.pick, `?pick= carries the picked proposal (${q.get('pick')})`);
  check((q.get('show') ?? '').split(',').sort().join(',') === state.shown.slice().sort().join(','),
    `?show= carries the subset, and only because it IS a subset (${q.get('show')})`);

  /* And it comes back. A shared link has to open on the comparison. */
  const url = await page.evaluate(() => location.search);
  await boot(url);
  await booted();
  await loaded(12);
  check(await page.evaluate(() => window.__viewer.ctx().pick?.shortId) === state.pick,
    'the same link reopens on the same picked proposal');
  check(await page.evaluate(() => window.__viewer.ctx().shown.size) === 2,
    'and the same two shown');

  /* ?focus= reopens a specific finding — this is what every brief links to. */
  const fid = demoState.findings[0].id;
  await boot(`?demo&focus=${encodeURIComponent(fid)}`);
  await booted();
  await loaded(12);
  await page.waitForFunction((id) => window.__viewer.ctx().selection?.id === id, fid,
    { timeout: SLOW }).catch(() => {});
  check(await page.evaluate(() => window.__viewer.ctx().selection?.id) === fid,
    `?focus=${fid} reopens that finding`);
  check(await page.locator('#detail-card').isVisible(), 'with its card open');

  /* An id that names nothing is not an error — it is a sentence. */
  await boot('?demo&focus=disc:deadbeef');
  await booted();
  await loaded(12);
  const missSaid = `${await toastText()} ${(await page.locator('#app-note').textContent()) ?? ''}`;
  check(/does not contain/i.test(missSaid),
    `an unknown ?focus= says so rather than failing: ${JSON.stringify(missSaid.trim().slice(0, 120))}`);
}

/* ══ § 9b · compact ═════════════════════════════════════════════════════════ */

if (fullOnly('9b')) {
  step('9b', 'a phone: the sheet, and nothing running off the side');

  await page.setViewportSize({ width: 390, height: 844 });
  await boot('?demo');
  await booted();
  await loaded(12);
  await shot('09b-compact');

  /* THE PAGE NEVER SCROLLS SIDEWAYS. A tool whose findings list runs off the
     right of a phone is a tool nobody reads on a phone. */
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `no horizontal overflow at 390px (${overflow}px)`);

  /* The card becomes the kit's bottom sheet, and `--sheet-h` is what lifts
     MapLibre's attribution clear of it — a licence term, not decoration. */
  await page.locator('#btn-drawer').click().catch(() => {});
  await page.locator('.finding-row').first().click();
  await page.waitForFunction(() => document.getElementById('detail-card')?.hidden === false,
    null, { timeout: NORMAL });
  await page.waitForTimeout(SETTLE);   // the kit's dock transition; no flag for it
  const sheet = await page.evaluate(() => {
    const card = document.getElementById('detail-card');
    const frame = document.getElementById('map-frame');
    const r = card.getBoundingClientRect(), f = frame.getBoundingClientRect();
    return {
      wide: r.width >= f.width * 0.9,
      sheetH: getComputedStyle(document.documentElement).getPropertyValue('--sheet-h').trim(),
    };
  });
  check(sheet.wide, 'the card is a bottom SHEET at this width, not a dock');
  check(sheet.sheetH && sheet.sheetH !== '0px',
    `and --sheet-h is stamped (${sheet.sheetH}) — the attribution lifts clear of it`);

  await page.setViewportSize({ width: 1440, height: 900 });
}

/* ══ § 9c · theme ═══════════════════════════════════════════════════════════ */

if (fullOnly('9c')) {
  step('9c', 'high contrast is the default, and ?theme=light is the way back');

  await boot('?demo');
  await booted();
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'high-contrast',
    'the default theme is high-contrast, decided by the anti-flash boot');

  await boot('?demo&theme=light');
  await booted();
  await loaded(12);
  check(await page.evaluate(() => document.documentElement.dataset.theme) === 'light',
    '?theme=light is the only route back, and it works');

  /* The seam colour is the reach token in BOTH themes — it is a MARK, and a
     mark that changed hue between themes would be a mark nobody could learn. */
  const seamColour = await page.evaluate(() => {
    const m = window.__viewer?.ctx()?.map;
    const paint = m?.getPaintProperty?.('seams-line', 'line-color') ?? null;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue('--map-reach-line').trim();
    return { paint, token };
  });
  check(!!seamColour.token, `--map-reach-line resolves in the light theme (${seamColour.token})`);
  check(typeof seamColour.paint === 'string' && seamColour.paint.length > 0,
    `and seams-line is painted with it (${JSON.stringify(seamColour.paint)})`);
  await shot('09c-light');
}

/* ══ § 10 · the console ═════════════════════════════════════════════════════ */

step(10, 'console is clean');

{
  /* Printed, not asserted. A seam whose far side could not be read and a
     refused origin are both the app working — but they are the only trace of
     WHY, and a run that discarded them would make a real bug unplaceable. */
  if (consoleWarnings.length) {
    const seen = new Set();
    console.log(`  note ${consoleWarnings.length} warning(s) — printed, never fatal:`);
    for (const w of consoleWarnings) {
      if (seen.has(w)) continue;
      seen.add(w);
      if (seen.size > 12) { console.log('       …'); break; }
      console.log(`       ${w}`);
    }
  }
  /* `favicon` and `ERR_` are the browser's own noise about things this app
     does not control. Everything else is ours. */
  const noise = consoleErrors.filter((t) => !/favicon|ERR_/.test(t));
  check(noise.length === 0,
    `no console errors${noise.length ? `: ${noise.slice(0, 3).join(' | ')}` : ''}`);
  check(cspViolations.length === 0,
    `no CSP violations across the whole run${cspViolations.length ? `: ${cspViolations[0]}` : ''}`);
}

} catch (err) {
  bad(`harness threw: ${err.message}`);
  console.error(err);
  await shot('99-failure', { force: true }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

/* The roster is DERIVED from the fullOnly() sites, so it cannot drift from a
   hand-kept count — which is exactly the misreading ("a passing --fast run is
   a passing full run") the count existed to prevent. The lane label comes from
   FAST, so the two can never be confused. */
console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}` +
  `  ·  screenshots in verify-out/`);
console.log(FAST
  ? `fast lane — ${skippedSections.length} section(s) skipped ` +
    `(${skippedSections.join(', ')}); run without --fast for the full sweep`
  : 'full lane — every section ran');
process.exit(failures === 0 ? 0 : 1);
