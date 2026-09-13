/* ══ USDM Edit Viewer · js/published.js ═══════════════════════════════════════
   The published week near a bounding box — THE ONE ENGINE-ADJACENT MODULE
   ALLOWED THE NETWORK, and it is allowed because everything else in the engine
   has to run under Node with no network at all (docs/contracts.md § 6).

   It does not call `fetch` itself: `fetchWeek` is INJECTED, from the vendored
   `js/archive.js` in the browser and from a cached parquet file in
   tools/compare.test.mjs. That is what lets the same code path be tested
   offline, and it is why tools/compare.test.mjs § 0's purity grep names this
   file as the one exception rather than as a hole in the rule.

   ── WHAT NEEDS IT, AND WHAT DOES NOT ──────────────────────────────────────
   A within-AOI comparison needs NO network: the published week is
   reconstructable from a package alone (js/proposal.js's header carries the
   argument and the measurement). The one thing that is not reconstructable is
   the far side of a seam whose neighbour nobody loaded — Montana's proposal
   says nothing about what is published inside the Crow Reservation. That, and
   only that, is what this module is for, which is why its unit is a BBOX and
   not a nation: a seam corridor is a few hundredths of a degree tall.

   ── A REJECTION IS NEVER FATAL ────────────────────────────────────────────
   The seam is still emitted with its side marked `unknown` and the app says so
   once (docs/contracts.md § 15). The in-flight promise is EVICTED on rejection
   so a retry is a real retry rather than a replay of the failure — the one
   thing a naive promise cache gets wrong, and the reason this is eight lines
   rather than one `Map.set`.
   ========================================================================== */

import {
  CLASSES, indexParts, clipToExtent, deriveBands,
} from '../vendor/usdm-editor/js/topology.js';

/** How far outside the asked-for box to keep geometry, in degrees. A seam
 *  sample sits 1 km inland; a clip flush to the box would answer `none` for a
 *  point the box's own rounding pushed outside it. */
const PAD_DEG = 0.05;

/** Bands are cached per box at a hundredth of a degree — ~1 km, which is the
 *  offset a seam samples at, so two corridors that round together answer the
 *  same question. */
const BOX_KEY_DP = 2;

/**
 * @param {object} opts
 * @param {Function} opts.fetchWeek  `(week) => Promise<{contours}>` — the
 *        vendored js/archive.js's, which HEALS the archive's nested rows on
 *        the way in, so the contours handed back are already nested and
 *        `deriveBands` over them is the archive's own stated derivation.
 * @returns {{bandsNear: Function, status: Function}}
 */
export function createPublishedProvider({ fetchWeek } = {}) {
  if (typeof fetchWeek !== 'function') {
    throw new Error('[usdm/published] createPublishedProvider needs a fetchWeek');
  }
  /** week → Promise<{contours}>; one fetch per week for the whole session. */
  const weeks = new Map();
  /** `week|bbox` → {D0..D4}; the derive is ~10 ms on a corridor and free after. */
  const boxes = new Map();
  let inFlight = 0;

  function weekData(week) {
    if (!weeks.has(week)) {
      inFlight++;
      const p = Promise.resolve(fetchWeek(week))
        .then((data) => { inFlight--; return data; })
        .catch((err) => {
          inFlight--;
          /* EVICT, so the next caller tries again. A cached rejection turns a
             dropped connection into a permanent one. */
          weeks.delete(week);
          throw err;
        });
      weeks.set(week, p);
    }
    return weeks.get(week);
  }

  async function bandsNear(week, bbox) {
    const key = `${week}|${bbox.map((n) => n.toFixed(BOX_KEY_DP)).join(',')}`;
    if (boxes.has(key)) return boxes.get(key);
    const data = await weekData(week);
    const contours = data?.contours ?? data;
    const box = [bbox[0] - PAD_DEG, bbox[1] - PAD_DEG, bbox[2] + PAD_DEG, bbox[3] + PAD_DEG];
    /* CLIP FIRST, DERIVE SECOND. `deriveBands` nationally is 7,667 ms
       (CLAUDE.md); over a seam corridor it is a difference between two
       handfuls of parts. `clipToExtent` is the bbox prefilter plus a
       `bboxClip` on the parts that straddle — never a naked intersect. */
    const clipped = {};
    for (const c of CLASSES) {
      clipped[c] = contours?.[c] ? clipToExtent(indexParts(contours[c]), box) : null;
    }
    const bands = Object.freeze(deriveBands(clipped));
    boxes.set(key, bands);
    return bands;
  }

  return Object.freeze({
    bandsNear,
    status: () => Object.freeze({ weeks: [...weeks.keys()], inFlight }),
  });
}
