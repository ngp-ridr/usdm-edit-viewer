/* ============================================================================
   USDM Editor · js/delta.js
   The change map: how many classes each piece of ground moved, as polygons.

   DOM-free, like js/topology.js, js/changeset.js and js/changes.js — it runs
   beside the editor in the browser and under Node in tools/topology.test.mjs.
   No `window`, no `document`, no `fetch`. Turf comes from `globalThis.turf`.

   Reproduces NDMC's published change-map arithmetic: an ordinal subtraction
   over SIX states (none = −1, D0 = 0 … D4 = 4 — "no drought" being a state is
   why the scale runs to ±5). Positive is degradation, negative improvement;
   js/color.js carries NDMC's own ramp. Compared here: a proposal against its
   baseline, in the units a reviewer already reads every Thursday.

   EXACT POLYGONS, never a sampled grid: a proposal is judged by area (a
   polygon's, not cells × cell size), the pieces are ribbons thinner than any
   fast grid, the output is zoomed, and it costs nothing — both sides are
   already exact bands. The arithmetic: complete each side into a partition of
   the working area (a synthetic `none` band = area ∖ D0), then for each level
   pair i ≠ j the ground that moved is `band_i^before ∩ band_j^after` with
   delta `ord(j) − ord(i)`. Pieces are disjoint by construction, so a diagonal
   is their CONCATENATION — a union would cost a boolean op to change nothing.
   ========================================================================== */

import {
  T, CLASSES, asMulti, asFeature, indexParts, bboxOverlaps, deriveBands, envelopeOf,
} from './topology.js';
import { normalizeAOI } from './changeset.js';
import { MIN_PATCH_AREA_M2 } from './changes.js';
import { CHANGE_STEPS, USDM_CHANGE_LABELS } from './color.js';

/**
 * The six states a place can be in, mildest first. The index IS the NDMC
 * ordinal plus one, so a delta is just a difference of indices — see the header.
 */
const LEVELS = Object.freeze(['none', ...CLASSES]);

/** Level index → the NDMC ordinal it stands for. `none` is −1, D0 is 0. */
const ordinalAt = (i) => i - 1;

/**
 * Below this a diagonal's part is clipper residue, not a change.
 *
 * The SAME floor js/changes.js applies to a patch, imported rather than
 * restated: a needle the change list refuses to demand a rationale for is a
 * needle the change map must not paint either, or the two views of one
 * proposal disagree about what is in it. 0.01 km²; see MIN_PATCH_AREA_M2 for
 * the measurements behind that number.
 */
export const MIN_DELTA_AREA_M2 = MIN_PATCH_AREA_M2;

/**
 * The change map for a proposal against its baseline.
 *
 * ── On the working area ────────────────────────────────────────────────────
 * `aoi` takes anything `normalizeAOI` takes — an AOI record, or a bare
 * `[w, s, e, n]` — and is REQUIRED, because the `none` band is defined by
 * subtraction from it: without a bounded ground there is no such thing as "was
 * clear and is now D0", only an infinite plane of it. A bbox-only changeset
 * (`aoi.geometry` absent) grounds on its rectangle, which is what such a
 * working area IS — the same branch js/changeset.js's `aoiPolygon` takes.
 *
 * There is deliberately no second `aoiPolygon` parameter to pass a prepared
 * ground in through. One door means the ground can never disagree with the AOI
 * the contours were clipped to, and building it costs one `turf.difference`
 * against geometry already cut to a jurisdiction.
 *
 * @param {object} opts
 * @param {object} opts.baseline  {D0..D4} cumulative contours, AOI-clipped
 * @param {object} opts.working   {D0..D4} the same, as the author has them
 * @param {object|number[]} opts.aoi  the working area
 * @param {number} [opts.minAreaM2]  see MIN_DELTA_AREA_M2
 * @returns {{deltas: object, nonzero: string[]}} `deltas` is keyed by the ten
 *          steps js/color.js paints — `'-5'` … `'-1'`, `'1'` … `'5'` — each a
 *          MultiPolygon or null. There is no `'0'`: unchanged ground is the
 *          complement of all ten, and it is deliberately never painted.
 *          `nonzero` lists the steps that carry geometry, worst-first.
 */
export function deriveChangeMap({
  baseline, working, aoi = null, minAreaM2 = MIN_DELTA_AREA_M2,
} = {}) {
  if (!aoi) {
    throw new Error('[usdm/delta] deriveChangeMap needs the working area — the `none` ' +
      'band is the working area minus D0, and there is no change map without it.');
  }
  const area = normalizeAOI(aoi);
  const ground = groundOf(area);

  const before = partitionOf(baseline, ground);
  const after = partitionOf(working, ground);

  /* delta value → the parts collected for it, from every (i, j) pair that
     produces it. Six levels give 30 ordered pairs off the diagonal, and each
     lands in exactly one of the ten buckets. */
  const buckets = new Map();
  for (let i = 0; i < LEVELS.length; i++) {
    if (!before[i]) continue;
    for (let j = 0; j < LEVELS.length; j++) {
      if (i === j || !after[j]) continue;
      const both = intersectLevels(before[i], after[j]);
      if (!both) continue;
      const step = String(ordinalAt(j) - ordinalAt(i));
      if (!buckets.has(step)) buckets.set(step, []);
      for (const rings of both.coordinates) buckets.get(step).push(rings);
    }
  }

  const deltas = {};
  const nonzero = [];
  for (const step of CHANGE_STEPS) {
    const kept = (buckets.get(step) ?? []).filter((rings) => partAreaM2(rings) >= minAreaM2);
    deltas[step] = kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
    if (deltas[step]) nonzero.push(step);
  }
  return { deltas, nonzero };
}

/**
 * The worst thing the change map says about one patch of ground.
 *
 * This is the seam the change list reads through: a patch from js/changes.js
 * knows WHICH classes moved under it and which way, and this says how far. A
 * patch usually spans several diagonals — a boundary pushed out leaves a
 * 1-class ribbon beside a 2-class core — and a reviewer scanning a list wants
 * the strongest claim it makes, not an average of them.
 *
 * TIES GO TO DEGRADATION. A patch that both improved and degraded by two is
 * reported as the degradation, because a proposal that makes drought worse is
 * the one a reviewer has to look at first, and burying it under an equal-sized
 * improvement is the one failure mode that matters here.
 *
 * Bbox-prefiltered, then one `booleanIntersects` per surviving candidate, and
 * it returns on the FIRST hit — the candidates are walked worst-first, so the
 * answer is known before most of them are touched.
 *
 * @param {object} patchGeometry (Multi)Polygon — `patch.geometry` from js/changes.js
 * @param {object} deltas  `deriveChangeMap().deltas`
 * @returns {{delta: number, step: string, label: string}|null} null when the
 *          patch meets no nonzero diagonal at all, which is what an edit that
 *          reshapes a boundary without moving any class across it looks like.
 */
export function worstDeltaWithin(patchGeometry, deltas) {
  const turf = T();
  const patch = asFeature(patchGeometry);
  if (!patch || !deltas) return null;
  const box = envelopeOf(indexParts(patch.geometry));
  if (!box) return null;

  /* Worst-first, degradation before improvement at equal magnitude — which is
     exactly the order js/color.js lists the ramp in. */
  for (const step of CHANGE_STEPS) {
    const g = deltas[step];
    if (!g) continue;
    const near = indexParts(g).filter((p) => bboxOverlaps(p.bbox, box));
    if (!near.length) continue;
    const candidate = asFeature({ type: 'MultiPolygon', coordinates: near.map((p) => p.rings) });
    if (!turf.booleanIntersects(patch, candidate)) continue;
    return { delta: Number(step), step, label: USDM_CHANGE_LABELS[step] };
  }
  return null;
}

/* ── the two partitions ───────────────────────────────────────────────────── */

/**
 * The working area as a MultiPolygon: the AOI's own boundary when it has one,
 * its rectangle when it does not. The same branch `createChangeset` takes to
 * build `aoiPolygon`, and for the same reason — a bbox-only working area IS its
 * rectangle, and that absence is meaningful rather than a default.
 */
function groundOf(area) {
  if (area.geometry) return asMulti(area.geometry);
  const [w, s, e, n] = area.bbox;
  return { type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] };
}

/**
 * One side's contours → a partition of the working area into six prepared
 * levels, `none` first, any of which may be null (most weeks have no D4).
 *
 * The `none` band is the ground minus the D0 contour, which is the only place
 * in this module a whole-area boolean op runs. When there is no D0 at all, the
 * working area is entirely clear and the `none` band IS the ground — no
 * difference to take, and taking one against a null operand would return the
 * ground anyway, more slowly.
 */
function partitionOf(contours, ground) {
  const turf = T();
  const bands = deriveBands(contours ?? {});
  const d0 = asMulti(contours?.D0 ?? null);
  const none = d0
    ? asMulti(turf.difference(turf.featureCollection([asFeature(ground), asFeature(d0)])))
    : ground;
  return [none, ...CLASSES.map((c) => bands[c])].map(prepare);
}

/** A level, indexed once: its geometry, its parts by bbox, and its envelope. */
function prepare(geometry) {
  const m = asMulti(geometry);
  if (!m) return null;
  const parts = indexParts(m);
  const bbox = envelopeOf(parts);
  return bbox ? { parts, bbox } : null;
}

/**
 * `level_a ∩ level_b`, with the clipper handed only the parts that can possibly
 * contribute.
 *
 * The `intersectNear` pattern from js/topology.js, applied to BOTH operands
 * instead of one. `intersectNear` prunes its subject by the mask's boxes and
 * then hands the clipper the whole mask, which is the right trade when the mask
 * is the small operand and the subject is a national class. Here neither
 * operand is privileged — a 40-part `none` band meets a 12-part D1 band, and
 * both sides have parts the other cannot reach — so each is pruned by the
 * other. It is the same argument in both directions: a part whose bounding box
 * misses every box on the far side cannot intersect anything over there, so
 * dropping it removes no area from the answer.
 *
 * The whole-envelope test first, because 30 pairs of a six-level partition are
 * mostly nowhere near each other and arithmetic is free.
 *
 * ── ONE PASS, BOTH SIDES, AND WHY NOT A SWEEP LINE ─────────────────────────
 * The two sets fall out of a single pairwise pass: `a_i` is kept iff it meets
 * some `b_j`, `b_j` iff it meets some `a_i`. That second predicate is stated in
 * the code below against ALL of `b`'s partners rather than against the surviving
 * `nearA`, and the two are the same set — if `b_j` meets any `a_i` at all, that
 * `a_i` is in `nearA` by the first predicate. So the marking pass replaces a
 * second filter that re-ran the same comparisons, and both lists are emitted in
 * their original part order, which is what keeps the concatenated output
 * byte-identical.
 *
 * A sort-by-minX event sweep was written and MEASURED against this, because
 * pairwise is O(|a|·|b|) and this file's neighbours say never. It loses, and not
 * marginally: the operands here are AOI-CLIPPED bands, which run to single-digit
 * part counts (Montana, 6 committed edits: none/D0..D4 = 2/6/4/4/1/0 before and
 * 2/9/7/7/2/0 after — 367 bbox comparisons across all 30 pairs), and at those
 * sizes the event array, its sort and two live sets cost 2.6-3.4 µs against
 * 0.3-1.0 µs for the pass below. The sweep only overtakes above ~200 parts a
 * side and wins properly at 1,000 (4,338 → 997 µs), which is a national band,
 * which is a shape `deriveChangeMap` never receives.
 *
 * The premise behind looking at all was wrong, and the number is worth keeping
 * so nobody re-opens it: of the 406 ms a first switch to the change view costs
 * (Montana, 6 edits), the bbox prefilter is 0.1 ms. `partitionOf` is 2 × ~104 ms
 * (a `deriveBands` and the `none` difference per side) and `turf.intersect` is
 * 199 ms across the 17 pairs that survive the filter.
 */
function intersectLevels(a, b) {
  if (!bboxOverlaps(a.bbox, b.bbox)) return null;
  const aHit = new Uint8Array(a.parts.length);
  const bHit = new Uint8Array(b.parts.length);
  for (let i = 0; i < a.parts.length; i++) {
    for (let j = 0; j < b.parts.length; j++) {
      if (!bboxOverlaps(a.parts[i].bbox, b.parts[j].bbox)) continue;
      aHit[i] = 1;
      bHit[j] = 1;
    }
  }
  const nearA = [];
  for (let i = 0; i < a.parts.length; i++) if (aHit[i]) nearA.push(a.parts[i]);
  if (!nearA.length) return null;
  const nearB = [];
  for (let j = 0; j < b.parts.length; j++) if (bHit[j]) nearB.push(b.parts[j]);
  if (!nearB.length) return null;
  const turf = T();
  return asMulti(turf.intersect(turf.featureCollection([
    asFeature({ type: 'MultiPolygon', coordinates: nearA.map((p) => p.rings) }),
    asFeature({ type: 'MultiPolygon', coordinates: nearB.map((p) => p.rings) }),
  ])));
}

/* ── small arithmetic ─────────────────────────────────────────────────────── */

/** One part's area in m², interior rings subtracted — `turf.area` does that. */
function partAreaM2(rings) {
  return T().area({ type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: rings } });
}
