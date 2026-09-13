/* ============================================================================
   USDM Edit Viewer · js/bands.js
   The published week — fetched once, derived once, punched once per area.

   docs/contracts.md § 9. This module is the app's ONLY route to the archive:
   `js/published.js` (the engine's one fetching module) is handed THIS module's
   cached `fetchWeek`, so the week a seam's far side is read from is the same
   bytes the map is painting, fetched once.

   ── What it owns, and why each cache exists ────────────────────────────────
   1. `fetchWeek` — an in-flight PROMISE cache keyed by week. Two callers ask
      for the same week within a few milliseconds of each other on every boot
      (the map wants it to paint; the seam engine wants it to read a far side);
      caching the promise rather than the result is what makes that one HTTP
      request instead of two. A REJECTION EVICTS, so a retry is a retry and not
      a replay of the failure — the vendored `createWeekCache` learned that one
      first and this copies its rule.

   2. `weekBands` — one national `deriveBands` per week. Measured in the editor
      at ~200–231 ms nationally on the unclipped product (843–944 ms heal +
      614–625 ms derive on CI); this app records the real number in
      `lastDeriveMs`, and `window.__viewer.lastDeriveMs` is how a regression
      shows up as a number rather than as "it feels slow".

      MEASURED HERE — week 2026-09-08 (the demo set's week) against the live
      archive under Node 22, 2026-09-12: **903 ms** to fetch, decode and heal,
      then **234 ms** to derive. 31 D0 parts over 2,590,750 km²; D4 present at
      143,396 km². The week leaks its nesting (D1 outside D0 by under a km²)
      and `fetchWeek` heals it on the way in, which is why nothing downstream
      has to.

      WHY BANDS AND NOT THE CONTOURS: the archive's rows are NESTED CUMULATIVE
      CONTOURS (`contour[n] = band[n] ∪ contour[n+1]`). Painted straight they
      look right — the fills go D0 first, D4 last — but every point query would
      report several classes for one pixel, and this app's `hitTest` and the
      seam sampler are point queries. One class per pixel is the requirement,
      so bands it is.

   3. `punched` — the published bands with the picked proposal's working area
      cut out, cached on `(week, aoi.id)`. This is the editor's `app.js:616–632`
      as a WRAPPER over the vendored `differenceNear`, not an edit to the copy
      (CLAUDE.md, the vendored-copy rule). The editor measures 418–572 ms for a
      state on the masked product; MEASURED HERE over Montana's real AOI ring
      on the unclipped one it is **280 ms cold and 0 ms cached** (a 102,460 km²
      hole in the national D0 band). Affordable once per working area, a bug
      once per interaction — `lastPunchMs` exists to catch exactly that.

      ONE CACHE. js/map.js ships a punch of its own for the same twelve lines;
      js/app.js hands THIS one in as its `punch` dependency so only one of them
      ever holds a cache. Two caches means paying the cold number twice.

      WHY PUNCH AT ALL: an opaque fill can only ADD a class. Ground a proposal
      improved OUT of a class has no edited polygon over it, so without the hole
      the published fill shows through and an improvement changes nothing on
      screen. The punch is what makes the proposal's fills complete rather than
      additive — and it is why the Published view feeds the UNPUNCHED bands
      instead of hiding a layer: hiding leaves a hole where the punch was.

   ── What it does NOT own ───────────────────────────────────────────────────
   Anything about a proposal. A proposal's own bands arrive parsed
   (`Proposal.bands`, docs/contracts.md § 2) and never pass through here.

   Not DOM-free, but close: it touches no element and no global except
   `performance`. It is not in the engine's Node-tested set because `fetchWeek`
   is the network.
   ========================================================================== */

import {
  CLASSES, deriveBands, differenceNear,
} from '../vendor/usdm-editor/js/topology.js';

/**
 * The published week, for painting.
 *
 * @param {object} deps
 * @param {(week: string, opts?: object) => Promise<{contours: object}>} deps.fetchWeek
 *        the vendored `js/archive.js` export. Injected rather than imported so
 *        a test can hand in a cached parquet reader and never touch the wire.
 * @param {(msg: string) => void} [deps.live] progress, one sentence at a time.
 */
export function createBandProvider({ fetchWeek, live = () => {} }) {
  /** week → Promise<weekData>. The promise, not the value. See the header. */
  const weeks = new Map();
  /** week → Promise<{D0..D4}>. */
  const bands = new Map();
  /** `${week}|${aoiId}` → Promise<{D0..D4}>. */
  const punches = new Map();

  let lastFetchMs = 0;
  let lastDeriveMs = 0;
  let lastPunchMs = 0;

  /**
   * One week's decoded rows — healed contours, as the archive's own derivation
   * says they are to be read.
   *
   * The progress callback is wired to the live region and NOT to a toast: a
   * download is news for as long as it is running and the toast is a singleton
   * that a load report is about to need.
   */
  function fetchWeekCached(week, { signal } = {}) {
    if (weeks.has(week)) return weeks.get(week);
    const t0 = now();
    let said = -1;
    const p = fetchWeek(week, {
      signal,
      onProgress: ({ loaded, total }) => {
        /* Every 25%, not every chunk: a live region read aloud on every packet
           is a live region nobody can listen to. */
        const pct = total ? Math.floor((loaded / total) * 4) : -1;
        if (pct > said && pct < 4) {
          said = pct;
          live(`Reading the published week of ${week} — ${pct * 25}%.`);
        }
      },
    }).then((data) => {
      lastFetchMs = Math.round(now() - t0);
      return data;
    }).catch((err) => {
      /* EVICT. A cached rejection makes every later caller fail for a reason
         that may have been a dropped packet ninety seconds ago. */
      weeks.delete(week);
      throw err;
    });
    weeks.set(week, p);
    return p;
  }

  /**
   * The week's national bands — disjoint, one class per pixel.
   *
   * @param {string} week 'YYYY-MM-DD'
   * @returns {Promise<{D0: object|null, …, D4: object|null}>}
   */
  function weekBands(week, { signal } = {}) {
    if (bands.has(week)) return bands.get(week);
    const p = fetchWeekCached(week, { signal }).then((data) => {
      const t0 = now();
      const out = deriveBands(data.contours);
      lastDeriveMs = Math.round(now() - t0);
      return out;
    }).catch((err) => {
      bands.delete(week);
      throw err;
    });
    bands.set(week, p);
    return p;
  }

  /**
   * The week's bands with one working area cut out of them.
   *
   * `aoi` is a `Proposal.aoi` record (docs/contracts.md § 2): `{ kind, id,
   * name, bbox, geometry }`. A null or geometry-less aoi is not an error — it
   * answers with the unpunched bands, which is what the Published view wants.
   *
   * @returns {Promise<{D0: object|null, …, D4: object|null}>}
   */
  function punched(week, aoi, { signal } = {}) {
    if (!aoi?.geometry) return weekBands(week, { signal });
    const key = `${week}|${aoi.id}`;
    if (punches.has(key)) return punches.get(key);
    const p = weekBands(week, { signal }).then((national) => {
      const t0 = now();
      const out = {};
      for (const c of CLASSES) {
        const g = national[c];
        /* `differenceNear`, never a naked `turf.difference` over the nation:
           it hands the clipper only the parts the working area can touch.
           Montana's D0 is one part of several dozen. */
        out[c] = g ? differenceNear(g, aoi.geometry) : null;
      }
      lastPunchMs = Math.round(now() - t0);
      return out;
    }).catch((err) => {
      punches.delete(key);
      throw err;
    });
    punches.set(key, p);
    return p;
  }

  /** What is cached, for the verification hook and for a note that says why. */
  function status() {
    return {
      weeks: [...weeks.keys()],
      punches: [...punches.keys()],
      lastFetchMs, lastDeriveMs, lastPunchMs,
    };
  }

  return {
    weekBands,
    punched,
    /** Handed to `createPublishedProvider` so the engine shares this cache. */
    fetchWeek: fetchWeekCached,
    status,
    get lastFetchMs() { return lastFetchMs; },
    get lastDeriveMs() { return lastDeriveMs; },
    get lastPunchMs() { return lastPunchMs; },
  };
}

/** `performance.now()` where there is one, `Date.now()` where there is not. */
function now() {
  return typeof performance === 'object' && performance?.now ? performance.now() : Date.now();
}
