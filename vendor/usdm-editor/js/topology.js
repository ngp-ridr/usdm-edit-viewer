/* ============================================================================
   USDM Editor · js/topology.js
   The rules engine: the bands↔contours transform pair, the extent clip, and
   every hard validation rule an edit must pass.

   DOM-FREE: runs in the browser (Terra Draw's `validation` hook) AND under
   Node (tools/topology.test.mjs; the deferred server-side submission gate).
   No window/document/fetch; turf comes off `globalThis.turf` through `T()`.

   The archive stores NESTED CUMULATIVE CONTOURS (since 2026-09, the
   `parquet_unclipped` product): each row covers its class AND every more
   severe one, so D1 ⊂ D0 ⊂ …, exactly the shape this engine edits. The
   archive's metadata says mutually exclusive classes are DERIVED by
   differencing each class with the next severer — i.e. `deriveBands()` below
   is the archive's own stated derivation. Nesting is NOT strict everywhere:
   measured over one week per year, 10 of 31 have an inner class leaking
   outside its outer one by 0.05–84 km², one by 1,185 km² (2014-07-08, D3
   outside D2). So archive rows are HEALED with the suffix union before use
   (`healContours`), which is that same derivation re-accumulated, and a
   no-op on a clean week. (Until 2026-09 the app read the masked product,
   a planar partition of disjoint bands; the algebra below is unchanged.)

     contour[4] = band[4]              band[4] = contour[4]
     contour[n] = band[n] ∪ contour[n+1]   band[n] = contour[n] ∖ contour[n+1]

   so `contour[4] ⊆ … ⊆ contour[0]` is the single invariant and shared-edge
   correctness is a property of `deriveBands()` rather than a check. Round trip
   is exact: identical part counts, relative area delta ~1e-13.

   Two measured facts shaped everything here (national week: 260,722 vertices,
   2,068 parts — the MASKED product; the app has read the unclipped one since
   2026-09, ~18,400 vertices / 149 parts, so these are upper bounds — see the
   js/archive.js header): a naked `turf.intersect` clip is ~2,600 ms where the bbox
   prefilter + per-part `bboxClip` is 1–4 ms (125–340×, agreeing to 1e-14) — so
   `clipToExtent` never uses a boolean op, and `clipToAOI` is the ONE sanctioned
   exception (its header carries the terms); and whole-nation union/difference
   is ~5.5/6.4 s — fine once at package time, never per keystroke, which is why
   the editor is always scoped to a working area.

   Turf's boolean ops return Polygon OR MultiPolygon; `asMulti()` is the only
   place that distinction may exist, and every function here returns a
   normalized MultiPolygon (or null).
   ========================================================================== */

/* The ONE import: the miles an author reads. js/units.js is DOM-free and
   turf-free, so the engine stays runnable under Node (§ 14h scans it). */
import { fmtMi2, fmtMi2Fine, fmtMi2Notice, fmtFt, FT_PER_M, MI2 } from './units.js';

export const CLASSES = Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4']);

/* ── Thresholds, all three set from measurements against the real archive ──
   Getting these wrong is not a tuning detail; a threshold set by intuition
   rejects the USDM's own published geometry. Measured over USDM_2026-08-11's
   2,068 band parts:

     smallest part   0.5 m²        p5    0.065 km²
     p1              617 m²        p10   0.221 km²
     median          1.16 km²      max   1,112,778 km²

   46% of REAL archive parts are under 1 km². A "no slivers" rule set at 1 km²
   — the intuitive value, and the one this file originally shipped — rejects
   nearly half the archive. Tiny parts are not defects here; they are islands,
   coastal fragments and lake shores. */

/** A part below this is geometrically DEGENERATE — a collapsed ring, not a
 *  place.
 *
 *  0.01 m² (1 cm²), and the value is bounded from both sides by measurement,
 *  not taste. The archive's smallest genuine part is **0.5 m²**, so anything at
 *  or above 1 m² rejects the USDM's own published geometry — this file shipped
 *  1 m² briefly and the test caught exactly that, failing on an unedited
 *  archive week. Collapsed rings, meanwhile, come out around 1e-9 m². 1 cm²
 *  sits 50× under the smallest real part and seven orders above the noise. */
export const MIN_PART_AREA_M2 = 0.01;

/** Area below which a "part outside its parent contour" is float noise along a
 *  shared edge rather than a real containment violation. Round-trip noise
 *  measured at ~0.075 m²; 100 m² is four orders of margin and still three
 *  orders below the smallest edit anyone would draw on purpose. */
export const CONTAINMENT_TOLERANCE_M2 = 100;

/* Anything narrower than this is clipper RESIDUE, not ground. Two kinds,
   both measured over all 1,391 weeks of the nested product (bands derived
   from healed contours, 2026-09-02): slivers left where two boolean ops cut
   along the same edge from different sides — 44 weeks over the 100 m² area
   tolerance, every one under 1 m wide (median 0.09 m) — and, on 9 weeks,
   STRIPS up to 26 m wide (mean width; 31 m with noding) along the Rio Grande,
   where every class's ring traces the same river and crosses the others back
   and forth for 200 km: there `contour[n] ∖ contour[n+1]` comes back with a
   strip that belongs to neither band. That second kind is a clipper failure
   on coincident traces, not a sliver, and it is recorded as such in
   docs/deferred.md; it is accepted here because it is bounded (nothing wider
   than 31 m in the archive), invisible at any zoom the map offers, and a
   corrupted band — what this rule exists to catch — is kilometres wide.
   Used by `validateDerivedBands`' overlap rule; see the note there. */
export const RESIDUE_WIDTH_M = 50;

/** Parts smaller than this are worth MENTIONING in review — never blocking.
 *  Set at the archive's own 5th percentile, so the advice says "this is smaller
 *  than 95% of real USDM parts", which is a statement an author can act on. */
export const SLIVER_ADVICE_M2 = 65000;

/* ── turf access ──────────────────────────────────────────────────────────── */

export function T() {
  const t = globalThis.turf;
  if (!t) {
    throw new Error(
      '[usdm/topology] window.turf is not defined. In the browser, load ' +
      'vendor/turf-7.4.0/turf.min.js as a CLASSIC script before any module ' +
      'that imports this file. Under Node, assign globalThis.turf before the ' +
      'first import of js/topology.js.'
    );
  }
  return t;
}

/* ── shape normalization ──────────────────────────────────────────────────── */

/**
 * Any Feature/geometry/null → a MultiPolygon geometry, or null if empty.
 * The one place Polygon-vs-MultiPolygon is allowed to be ambiguous.
 */
export function asMulti(x) {
  if (!x) return null;
  const g = x.type === 'Feature' ? x.geometry : x;
  if (!g || !g.coordinates || !g.coordinates.length) return null;
  if (g.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [g.coordinates] };
  if (g.type === 'MultiPolygon') return g;
  throw new Error('[usdm/topology] expected Polygon or MultiPolygon, got ' + g.type);
}

/** MultiPolygon geometry → turf Feature, or null. */
export function asFeature(g, properties = {}) {
  const m = asMulti(g);
  return m ? { type: 'Feature', properties, geometry: m } : null;
}

/* A vertex where the ring turns back on itself within this angle of 180° is a
   SPIKE TIP — the ring went out along a line and came straight back. cos(θ) <
   −0.999999 is a turn within ~0.08° of a full reversal: no drought contour has
   a corner that sharp, and the clipper's residue is exactly that sharp. */
const SPIKE_COS = -0.999999;

/**
 * Remove zero-width spikes from every ring.
 *
 * `turf.difference` over two rings that share thousands of identical vertices
 * (a baseline contour and the same contour after one edit) can emit an
 * out-and-back needle along a shared edge: measured on 2026-08-11, an edit of
 * a 0.5° square in Montana came back with a D1 diff whose ring ran 31 km west
 * of the square and back along the D1 edge, carrying −6,446 m² (an inverted
 * lobe) and a bounding box twice the square's. Nothing boolean removes it —
 * union with itself, a zero buffer, an intersect with itself all return it
 * unchanged, because to the clipper it is consistent — but the vertex pattern
 * is unmistakable: consecutive vertices reversing direction. On the masked
 * product the same needle was 8 km; the nested product's near-coincident
 * contours make it long enough to reach real ground, which is how a thread
 * detector growing each edit by 0.5 km reported an edit 55 km away (§ 18b).
 *
 * Removes the reversing vertex and repeats until the ring is stable; a ring
 * that collapses below a triangle is dropped, and a part whose shell collapsed
 * goes with it. Pure and DOM-free; safe on clean geometry, which it returns
 * unchanged (a genuine ring has no 0.08° corners).
 *
 * THE ORDER OF REMOVAL IS PART OF THE OUTPUT and is kept exactly: at every
 * step the LOWEST-INDEX spike in the ring as it currently stands is the one
 * removed (on a collinear zig-zag, removing b first keeps d and removing d
 * first keeps b — different bytes). The first version rescanned from index 0
 * after every splice, O(n · removals) per ring, which on the unsimplified FSA
 * boundary's ~3,450-vertex rings ran twenty times per commit. This one keeps
 * the ring as a cyclic linked list over the original indices plus a min-heap
 * of candidates: a removal changes only its two neighbours' triples, so those
 * two are the only re-checks, and because the ring keeps its original order
 * the smallest surviving original index IS the lowest current index. Same
 * removal sequence, same bytes (§ 18e pins it against the old loop),
 * O((n + removals) log n).
 */
export function despike(geometry) {
  const g = asMulti(geometry);
  if (!g) return null;
  const parts = [];
  for (const part of g.coordinates) {
    const rings = [];
    for (const ring of part) {
      const r = despikeRing(ring.slice(0, -1));
      if (r.length >= 3) rings.push([...r, r[0]]);
      else if (!rings.length) break;                 // the shell collapsed: drop the part
    }
    if (rings.length) parts.push(rings);
  }
  return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
}

/** Is `b` a spike between `a` and `d`: a zero-length edge or a near-reversal. */
function isSpike(a, b, d) {
  const abx = b[0] - a[0], aby = b[1] - a[1], bdx = d[0] - b[0], bdy = d[1] - b[1];
  const ab = Math.hypot(abx, aby), bd = Math.hypot(bdx, bdy);
  return ab === 0 || bd === 0 || (abx * bdx + aby * bdy) / (ab * bd) < SPIKE_COS;
}

/** One open ring (no closing vertex) → its surviving vertices, in order. */
function despikeRing(r) {
  const n = r.length;
  if (n < 3) return r;
  const prev = new Int32Array(n), next = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; }
  let count = n;
  /* A binary min-heap of candidate indices, seeded with every vertex. */
  const heap = Array.from({ length: n }, (_, i) => i);
  for (let i = (n >> 1) - 1; i >= 0; i--) siftDown(heap, i);
  while (heap.length && count >= 3) {
    const i = heap[0];
    const last = heap.pop();
    if (heap.length) { heap[0] = last; siftDown(heap, 0); }
    if (!alive[i]) continue;
    const p = prev[i], q = next[i];
    if (!isSpike(r[p], r[i], r[q])) continue;
    alive[i] = 0; count--;
    next[p] = q; prev[q] = p;
    heapPush(heap, p); heapPush(heap, q);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(r[i]);
  return out;
}

function siftDown(h, i) {
  const n = h.length;
  for (;;) {
    const l = 2 * i + 1, rr = l + 1;
    let m = i;
    if (l < n && h[l] < h[m]) m = l;
    if (rr < n && h[rr] < h[m]) m = rr;
    if (m === i) return;
    const t = h[i]; h[i] = h[m]; h[m] = t; i = m;
  }
}

function heapPush(h, v) {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p] <= h[i]) return;
    const t = h[i]; h[i] = h[p]; h[p] = t; i = p;
  }
}

/* ── bbox helpers (pure arithmetic — no turf, no allocation in the hot path) ─ */

/** bbox of one polygon part's exterior ring. */
export function ringBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of rings[0]) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export const bboxOverlaps = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
export const bboxContains = (inner, outer) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/**
 * Index every part of a MultiPolygon by its bbox, once, at load. 25 ms for all
 * five national bands (2,068 parts) — after which every extent clip is a bbox
 * scan instead of a geometry op.
 */
export function indexParts(geometry) {
  const m = asMulti(geometry);
  if (!m) return [];
  return m.coordinates.map((rings) => ({ bbox: ringBBox(rings), rings }));
}

/** Envelope of an indexed part list, or null when there are none. */
export function envelopeOf(parts) {
  if (!parts.length) return null;
  const bb = parts[0].bbox.slice();
  for (const p of parts) {
    if (p.bbox[0] < bb[0]) bb[0] = p.bbox[0];
    if (p.bbox[1] < bb[1]) bb[1] = p.bbox[1];
    if (p.bbox[2] > bb[2]) bb[2] = p.bbox[2];
    if (p.bbox[3] > bb[3]) bb[3] = p.bbox[3];
  }
  return bb;
}

/* ── extent clip ──────────────────────────────────────────────────────────── */

/**
 * Clip an indexed band to `bbox`, cheaply.
 *
 * Three tiers, cheapest first: parts whose bbox misses the extent are dropped
 * without touching a coordinate; parts wholly inside are passed through
 * untouched; only parts that genuinely straddle the boundary are clipped, with
 * `turf.bboxClip` (Sutherland–Hodgman, linear in vertices — exact here because
 * a rectangle is convex). Never `turf.intersect`: see the header.
 *
 * @param {Array<{bbox:number[],rings:number[][][]}>} parts from indexParts()
 * @param {number[]} bbox [minX, minY, maxX, maxY]
 * @returns {object|null} MultiPolygon geometry, or null if nothing survives
 */
export function clipToExtent(parts, bbox) {
  const turf = T();
  const kept = [];
  for (const p of parts) {
    if (!bboxOverlaps(p.bbox, bbox)) continue;
    if (bboxContains(p.bbox, bbox)) { kept.push(p.rings); continue; }
    const clipped = asMulti(turf.bboxClip({ type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: p.rings } }, bbox));
    if (!clipped) continue;
    for (const rings of clipped.coordinates) kept.push(rings);
  }
  return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
}

/**
 * Clip an indexed band to a POLYGON area of interest — a state, a county, a
 * tribal area, a climate division — rather than to a rectangle.
 *
 * THE ONE SANCTIONED `turf.intersect` on a clip path (CLAUDE.md). Not a
 * violation of "never clip an extent with a naked intersect": that rule is
 * about the SIZE of the input, and `clipToExtent` runs first in full, so the
 * intersect only ever sees geometry already cut to the AOI's envelope. The
 * prefilter alone cannot answer a polygon boundary — its inside-the-bbox tier
 * is exact for a rectangle and simply false for a state (a part inside
 * Montana's envelope can lie entirely in Idaho).
 *
 * Measured (USDM_2026-08-11 × the 204-vertex Montana boundary): 9–20 ms per
 * class vs 171–1,758 ms naked — 60–190× — and ~50 ms for a whole five-class
 * changeset, paid once at build. § 10a asserts the speed AND that both paths
 * return identical parts, interior rings, and area to 1e-16. Do not add a
 * second exception.
 *
 * `aoiBbox` must be the AOI polygon's own envelope (or larger). A smaller box
 * is not an error — it is simply a smaller working area — but it will truncate
 * the AOI, which is rarely what a caller means.
 *
 * @param {Array<{bbox:number[],rings:number[][][]}>} parts from indexParts()
 * @param {object|null} aoiGeometry (Multi)Polygon boundary; null → bbox only,
 *                      which is bit-identical to `clipToExtent` and is how
 *                      every rectangle-extent caller still behaves
 * @param {number[]} aoiBbox [minX, minY, maxX, maxY]
 * @returns {object|null} MultiPolygon geometry, or null if nothing survives
 */
export function clipToAOI(parts, aoiGeometry, aoiBbox) {
  const pre = clipToExtent(parts, aoiBbox);
  if (!aoiGeometry || !pre) return pre;
  const aoi = asFeature(aoiGeometry);
  if (!aoi) return pre;
  const turf = T();
  return asMulti(turf.intersect(turf.featureCollection([asFeature(pre), aoi])));
}

/** Convenience: clip a whole {D0..D4} class set (bands or contours) to an extent. */
export function clipClassSet(classSet, bbox) {
  const out = {};
  for (const c of CLASSES) {
    const g = classSet[c];
    out[c] = g ? clipToExtent(indexParts(g), bbox) : null;
  }
  return out;
}

/* ── the transform pair ───────────────────────────────────────────────────── */

/**
 * Suffix union: `contour[n] = row[n] ∪ contour[n+1]`, so `contour[n]` is
 * "D-n or worse". ONE function with three honest readings, and it is the same
 * arithmetic in all three:
 *
 *   · disjoint bands → cumulative contours (the masked product's rows);
 *   · nested contours → the SAME contours (a geometric no-op — the union of a
 *     shape with something inside it is the shape);
 *   · LEAKY nested contours → healed ones: where row[n+1] pokes outside
 *     row[n], the union brings that ground into contour[n], which is exactly
 *     what the archive's own derivation (difference, then re-accumulate) gives.
 *
 * `healContours` below is this function under the name the second and third
 * readings deserve. Missing classes are simply absent (null), which is normal:
 * most weeks have no D4 in most extents.
 */
export function deriveContours(bands) {
  const turf = T();
  const contours = {};
  let acc = asMulti(bands.D4);
  contours.D4 = acc;
  for (let n = 3; n >= 0; n--) {
    const band = asMulti(bands['D' + n]);
    if (!band) { contours['D' + n] = acc; continue; }
    acc = acc
      ? asMulti(turf.union(turf.featureCollection([asFeature(band), asFeature(acc)])))
      : band;
    contours['D' + n] = acc;
  }
  return contours;
}

/**
 * Nest a {D0..D4} class set of archive rows: `deriveContours` under the name
 * of what it does to the archive's nested product. Idempotent — measured
 * national cost on the unclipped product ~250 ms, and on a clean week the
 * output differs from the input by nothing but coordinate order.
 */
export const healContours = deriveContours;

/**
 * How much each class leaked outside the next less severe one, in m², from
 * the raw rows and their healed counterpart: `area(healed[n]) − area(raw[n])`
 * is the area of "everything severer that lay outside row n". Four area
 * calls, no boolean op — cheap enough to run on every fetch. D4 has nothing
 * inside it to leak, so the result carries D0..D3.
 */
export function nestingLeaks(raw, healed) {
  const turf = T();
  const area = (g) => (g ? turf.area(asFeature(g)) : 0);
  const out = {};
  for (let n = 0; n < CLASSES.length - 1; n++) {
    const c = CLASSES[n];
    out[c] = Math.max(0, area(healed[c]) - area(raw[c]));
  }
  return out;
}

/**
 * WHERE a class leaked: `healed[cls] ∖ raw[cls]`, the ground the heal brought
 * into contour `cls`. One boolean difference — call it only when
 * `nestingLeaks` says there is something to see (a clean week pays nothing).
 * Returns a MultiPolygon or null.
 */
export function nestingLeakGeometry(raw, healed, cls) {
  const turf = T();
  const outer = asMulti(healed[cls]), inner = asMulti(raw[cls]);
  if (!outer) return null;
  if (!inner) return outer;
  return asMulti(turf.difference(turf.featureCollection([asFeature(outer), asFeature(inner)])));
}

/**
 * Cumulative contours → disjoint bands (the exclusive representation), by
 * difference. The inverse of
 * deriveContours(), and the step that makes adjacent-class boundaries
 * coincident by construction — and, per the archive's metadata, the way it
 * says mutually exclusive class polygons are to be derived from its rows.
 */
export function deriveBands(contours) {
  const bands = { D4: asMulti(contours.D4) };
  for (let n = 3; n >= 0; n--) {
    const outer = asMulti(contours['D' + n]);
    const inner = asMulti(contours['D' + (n + 1)]);
    if (!outer) { bands['D' + n] = null; continue; }
    bands['D' + n] = inner
      ? dropResidueParts(robustDifference(outer, inner, `D${n} ∖ D${n + 1}`))
      : outer;
  }
  return bands;
}

/**
 * `turf.difference` that does not take the proposal down with it.
 *
 * polygon-clipping THROWS ("Unable to complete output ring starting at …")
 * on operands it cannot node — measured twice on the South Dakota / Big Sioux
 * line, where a folded national contour carries spike vertices the fold's
 * union emitted along the state line (2026-09-08 session 367e00a2: D2 ∖ D3
 * and D0 ∖ D1 both threw; tools/fixtures/sd-big-sioux-clipper.json.gz holds
 * the pairs). Inside `deriveBands` at package time that was the step-4 gate
 * dying with the clipper's sentence and no way forward.
 *
 * THE LADDER, each rung tried only if the one before threw, and each one
 * measured on the fixture: (1) the operands as given; (2) `scrubResidue` on
 * both — removes exactly the spikes that provoked the throw and nothing the
 * archive itself carries (§ 21e), area identical; (3) coordinates snapped to
 * 1e-10° (~10 µm), area identical to the metre; (4) 1e-8° (~1 mm), area
 * within 0.002 km² of 2.6 million. A rung that is not the first says so once
 * on the console — a heal, measured and told — and the last rethrows with a
 * sentence that names the place, so the author is told where to look rather
 * than handed the clipper's internals. `applyToNational` scrubs its own
 * output so rung 1 is the one that runs; this is the belt under it.
 */
export function robustDifference(outer, inner, label = 'difference') {
  const turf = T();
  const diff = (a, b) => asMulti(turf.difference(turf.featureCollection([asFeature(a), asFeature(b)])));
  const rungs = [
    ['as given', (a, b) => diff(a, b)],
    ['scrubbed operands', (a, b) => diff(scrubResidue(a), scrubResidue(b))],
    ['coordinates snapped to 1e-10°', (a, b) => diff(snap(a, 10), snap(b, 10))],
    ['coordinates snapped to 1e-8°', (a, b) => diff(snap(a, 8), snap(b, 8))],
  ];
  let last = null;
  for (const [name, fn] of rungs) {
    try {
      const out = fn(outer, inner);
      if (name !== 'as given') console.warn(`[usdm/topology] ${label}: the clipper threw on the operands as given and succeeded with ${name}.`);
      return out;
    } catch (err) { last = err; }
  }
  const at = String(last?.message ?? '').match(/ends at \[([-\d.]+), ([-\d.]+)\]/);
  const where = at ? ` near ${Number(at[2]).toFixed(3)}°N, ${Math.abs(Number(at[1])).toFixed(3)}°W` : '';
  const e = new Error(`The map library could not separate ${label}${where} — an edge there runs too close ` +
    'to another one. Reshape the edge in that area (a few hundred metres is enough) and try again.');
  e.cause = last;
  throw e;
}

/** Coordinates rounded to `decimals` places — a fresh geometry, the input untouched. */
function snap(geometry, decimals) {
  const g = asMulti(geometry);
  if (!g) return null;
  const k = 10 ** decimals;
  const r = (v) => Math.round(v * k) / k;
  return { type: 'MultiPolygon', coordinates: g.coordinates.map((part) => part.map((ring) => ring.map(([x, y]) => [r(x), r(y)]))) };
}

/**
 * Drop parts below `MIN_PART_AREA_M2` — the clipper's residue by the same
 * definition `ruleNoDegenerateParts` uses. On the nested product a difference
 * along a healed contour's spliced ring leaves them: measured on 20 of 1,391
 * weeks, the largest 5.9e-3 m². Cheap (one area per part) and only ever
 * removes what the gate would have refused.
 */
function dropResidueParts(geometry) {
  const g = asMulti(geometry);
  if (!g) return null;
  const turf = T();
  const kept = g.coordinates.filter((part) =>
    turf.area({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: part } }) >= MIN_PART_AREA_M2);
  if (kept.length === g.coordinates.length) return g;
  return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
}

/**
 * The clipper's residue, removed: `despike` (out-and-back spurs ON a ring)
 * then the part floor (parts that ARE a spur — a 4-vertex needle with two
 * coincident vertices and ~1e-6 m² of area). The two catch different shapes
 * of the same thing, and both only ever remove what `ruleNoDegenerateParts`
 * would refuse or what carries no area.
 *
 * WHY THIS RUNS ON WHAT THE OPS PRODUCE (js/changeset.js `tidy`) and on what a
 * restore brings back, and not only inside `deriveBands`: an edit whose
 * clipped edge coincides with the working-area ring leaves a needle along the
 * ring — measured 5 km long at 1e-6 m² on the North Dakota / 49°N line
 * (2026-09-08 session) and 2 km at 8.6e-8 m² along the Red River (docs/
 * deferred.md, 2026-09-12). `deriveBands` dropped it, so the map painted
 * clean, but `validate()` reads the CONTOURS, so the gate stayed red, and the
 * author had no ring to select and nothing to drag. Safe on the archive's own
 * geometry: over the healed national contours of 2026-08-11, 2026-09-08 and
 * 2020-10-20 `despike` removes 0 of ~10,800 vertices per week and the floor
 * drops 0 parts; on a clipped state baseline it touches only what the clip
 * itself invented (Florida's coastline clip: 7 of 18,835 vertices). Cost:
 * 0.8 ms for every class of Montana.
 */
export function scrubResidue(geometry) {
  return dropResidueParts(despike(geometry));
}

/* ── measurement ──────────────────────────────────────────────────────────── */

/** Mean width of a sliver-shaped geometry in metres: 2·area/perimeter. */
export function meanWidthM(geometry) {
  const f = asFeature(geometry);
  if (!f) return 0;
  const turf = T();
  const len = turf.length(f, { units: 'meters' });
  return len ? (2 * turf.area(f)) / len : 0;
}

/** Area in km², 0 for null. */
export function areaKm2(geometry) {
  const f = asFeature(geometry);
  return f ? T().area(f) / 1e6 : 0;
}

/** Shape census — parts, interior rings, vertices. Used in tests and the review UI. */
export function tally(geometry) {
  const m = asMulti(geometry);
  if (!m) return { parts: 0, holes: 0, verts: 0 };
  return {
    parts: m.coordinates.length,
    holes: m.coordinates.reduce((a, p) => a + p.length - 1, 0),
    verts: m.coordinates.reduce((a, p) => a + p.reduce((b, r) => b + r.length, 0), 0),
  };
}

/* ══ Validation rules ═══════════════════════════════════════════════════════
   Handoff §3a, one function per rule. Every rule returns the SAME shape:

     { id, ok, message, geometry }

   `geometry` is the offending region when there is one, so the UI can zoom the
   author straight to it instead of saying "invalid" and leaving them to hunt.
   That is also why containment is checked as a difference rather than with
   `turf.booleanWithin`: `booleanWithin` answers yes/no (and measured 722 ms on
   a Great-Plains extent), while `difference` answers *where* in ~44 ms.

   Rules are pure. They never mutate their input and never touch the DOM, so the
   same call site works inside Terra Draw's `validation` hook, in the package
   step, and in Node.
   ══════════════════════════════════════════════════════════════════════════ */

const pass = (id, message = '') => ({ id, ok: true, message, geometry: null });
const fail = (id, message, geometry = null) => ({ id, ok: false, message, geometry });

/**
 * No self-intersection.
 *
 * PER PART, deliberately. `turf.kinks` is a brute-force all-pairs segment test,
 * so handing it a whole national class is quadratic in total vertices: measured
 * 1.3 s at 16.8k vertices, 17.9 s at 58k, and well over a minute for D0's 137k
 * — roughly two minutes to check one week, which is what a naive implementation
 * of this rule cost before it was split.
 *
 * Splitting is not an approximation: a ring self-intersects within itself, and a
 * segment in Montana cannot cross one in Florida. Cost drops from O((Σnᵢ)²) to
 * O(Σnᵢ²) — for 602 parts averaging ~96 vertices that is ~600× less work.
 * Distinct parts OVERLAPPING each other is a different defect, and
 * `rulePartsDontOverlap` is what catches it.
 */
export function ruleNoSelfIntersection(geometry, label = 'geometry') {
  const turf = T();
  const m = asMulti(geometry);
  if (!m) return pass('self-intersection');
  const points = [];
  for (const rings of m.coordinates) {
    const k = turf.kinks({ type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: rings } });
    for (const f of k.features) points.push(f.geometry.coordinates);
    if (points.length > 64) break;   // enough to point the author at the problem
  }
  if (!points.length) return pass('self-intersection');
  return fail('self-intersection',
    `${label} crosses itself at ${points.length}${points.length > 64 ? '+' : ''} point` +
    `${points.length === 1 ? '' : 's'}.`,
    { type: 'MultiPoint', coordinates: points });
}

/**
 * Distinct parts of one class must not overlap each other.
 *
 * Only bbox-overlapping pairs reach the clipper, which on real data is a
 * handful out of ~1,000 parts — the rule costs milliseconds where an
 * all-pairs `intersect` would cost minutes.
 */
export function rulePartsDontOverlap(geometry, { minAreaM2 = MIN_PART_AREA_M2, label = 'geometry' } = {}) {
  const turf = T();
  const m = asMulti(geometry);
  if (!m || m.coordinates.length < 2) return pass('part-overlap');
  const parts = m.coordinates.map((rings) => ({ bbox: ringBBox(rings), rings }));
  const offenders = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (!bboxOverlaps(parts[i].bbox, parts[j].bbox)) continue;
      const both = asMulti(turf.intersect(turf.featureCollection([
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: parts[i].rings } },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: parts[j].rings } },
      ])));
      if (both && areaKm2(both) * 1e6 > minAreaM2) offenders.push(both.coordinates[0]);
      if (offenders.length > 16) break;
    }
    if (offenders.length > 16) break;
  }
  return offenders.length
    ? fail('part-overlap',
        `${label} has ${offenders.length}${offenders.length > 16 ? '+' : ''} overlapping part ` +
        `pair${offenders.length === 1 ? '' : 's'}. Parts of one class must be disjoint.`,
        { type: 'MultiPolygon', coordinates: offenders })
    : pass('part-overlap');
}

/**
 * Rings are closed and have enough distinct vertices to bound an area.
 *
 * Deliberately hand-rolled rather than delegated to `turf.booleanValid`: a ring
 * of 2 coordinate pairs is the exact artifact produced by reading a turf
 * boolean result at the wrong nesting depth, and it needs to be caught with a
 * message that says so rather than a generic "invalid geometry".
 */
export function ruleValidRings(geometry, label = 'geometry') {
  const m = asMulti(geometry);
  if (!m) return pass('valid-rings');
  const problems = [];
  m.coordinates.forEach((rings, pi) => {
    rings.forEach((ring, ri) => {
      const what = ri === 0 ? `part ${pi} exterior ring` : `part ${pi} hole ${ri}`;
      if (ring.length < 4) { problems.push(`${what} has only ${ring.length} points`); return; }
      const [fx, fy] = ring[0];
      const [lx, ly] = ring[ring.length - 1];
      if (fx !== lx || fy !== ly) problems.push(`${what} is not closed`);
    });
  });
  return problems.length
    ? fail('valid-rings', `${label}: ` + problems.slice(0, 4).join('; ') +
        (problems.length > 4 ? ` (+${problems.length - 4} more)` : '') + '.')
    : pass('valid-rings');
}

/**
 * No DEGENERATE parts. A part below `minAreaM2` (1 m²) has no meaningful
 * interior — it is clipper residue or a collapsed ring, not a place.
 *
 * This deliberately does NOT reject "small" parts. The archive's own smallest
 * real part is 0.5 m² and 46% of its parts are under 1 km²; a rule that treats
 * small as invalid rejects the USDM itself. Smallness is reported separately
 * and advisorily by `adviseSmallParts`.
 */
export function ruleNoDegenerateParts(geometry, { minAreaM2 = MIN_PART_AREA_M2, label = 'geometry' } = {}) {
  const turf = T();
  const m = asMulti(geometry);
  if (!m) return pass('degenerate-parts');
  const bad = m.coordinates.filter((rings) => turf.area(
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }) < minAreaM2);
  if (!bad.length) return pass('degenerate-parts');
  return fail('degenerate-parts',
    `${label} has ${bad.length} part${bad.length === 1 ? '' : 's'} with effectively no area ` +
    `(under ${(minAreaM2 * FT_PER_M * FT_PER_M).toLocaleString(undefined, { maximumFractionDigits: 1 })} sq ft).`,
    { type: 'MultiPolygon', coordinates: bad });
}

/**
 * ADVISORY: parts smaller than the archive's 5th percentile (0.065 km²).
 *
 * Never blocking, and never reported for geometry the author did not touch —
 * pass `only` (typically the changed region) to scope it. Its whole value is
 * telling someone "you left a fragment behind", which is only useful about
 * fragments they created.
 */
export function adviseSmallParts(geometry, { thresholdM2 = SLIVER_ADVICE_M2, label = 'geometry', only = null } = {}) {
  const turf = T();
  const m = asMulti(geometry);
  if (!m) return { id: 'small-parts', ok: true, advisory: true, message: '', geometry: null };
  const scope = only ? indexParts(only).map((p) => p.bbox) : null;
  const small = m.coordinates.filter((rings) => {
    if (scope) {
      const bb = ringBBox(rings);
      if (!scope.some((s) => bboxOverlaps(bb, s))) return false;
    }
    return turf.area({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }) < thresholdM2;
  });
  return small.length
    ? { id: 'small-parts', ok: true, advisory: true,
        message: `${label} has ${small.length} part${small.length === 1 ? '' : 's'} smaller than ` +
                 `${fmtMi2Fine(thresholdM2 / 1e6)} ${MI2} — smaller than 95% of real USDM parts. ` +
                 `Check they are intended and not leftovers.`,
        geometry: { type: 'MultiPolygon', coordinates: small } }
    : { id: 'small-parts', ok: true, advisory: true, message: '', geometry: null };
}

/**
 * Containment for ONE adjacent pair: every part of the worse class must lie
 * inside the milder one. Answers *where* it escapes, not just whether.
 *
 * `toleranceM2` absorbs the float noise a clipper leaves along a shared edge —
 * without it, a boundary two contours legitimately share reports a few m² of
 * "escape" on every commit.
 */
export function ruleContainedIn(inner, outer, {
  innerLabel = 'inner', outerLabel = 'outer', toleranceM2 = CONTAINMENT_TOLERANCE_M2,
} = {}) {
  const turf = T();
  const id = 'containment';
  const i = asMulti(inner);
  if (!i) return pass(id);
  const o = asMulti(outer);
  if (!o) {
    return fail(id, `${innerLabel} exists where there is no ${outerLabel} at all. ` +
      `Every ${innerLabel} area must sit inside ${outerLabel}.`, i);
  }
  const escaped = asMulti(turf.difference(turf.featureCollection([asFeature(i), asFeature(o)])));
  if (!escaped) return pass(id);
  const km2 = areaKm2(escaped);
  if (km2 * 1e6 <= toleranceM2) return pass(id);
  return fail(id,
    `${fmtMi2(km2)} ${MI2} of ${innerLabel} falls outside ${outerLabel}. ` +
    `A ${innerLabel} area must always sit inside ${outerLabel}.`, escaped);
}

/**
 * NO GROUND MAY MOVE MORE THAN ONE CLASS from the published week.
 *
 * The two verbs are each one-class against the state they run on, but nothing
 * constrains the state itself: two ops in sequence over the same ground move it
 * two classes through perfectly legal intermediate states. Measured on the
 * session that reported it (state:CO, 2026-08-25): 28,950 km² moved TWO
 * classes against 88,648 km² that moved one, and everything else passed. The
 * structural fix — clip each verb's operand to unmoved ground — is recorded in
 * docs/deferred.md; this rule is the complete guarantee in the meantime.
 *
 * The algebra needs only the contours. Read levels as 0 = no drought … 5 = D4,
 * so `contour[D_k]` is "level ≥ k+1"; ground improved by two or more classes is
 *
 *     ⋃(i = 1..4)  baseline.D_i ∖ working.D_{i−1}
 *
 * and degradation is its mirror, `working.D_i ∖ baseline.D_{i−1}`. Eight
 * differences, no bands, no change map — deliberately NO import of js/delta.js,
 * which would be a cycle. Cross-checked against `deriveChangeMap` on the
 * reported session: 28,950.2 vs 28,950.249 km², two independent computations.
 *
 * Tolerance is the containment tolerance: a rule that fires on 4 m² of clipper
 * noise is a rule authors learn to route around.
 *
 * `region` NARROWS THE RULE TO THE CHANGED GROUND, exactly, and is opt-in:
 *   - `undefined` (the default, the exported rule, the deferred server gate):
 *     the full algebra over whole contours, whatever the caller hands in.
 *   - `null`: nothing changed, so nothing can have moved two classes — pass.
 *   - a MultiPolygon (the changeset's `changedRegion`, = ⋃ over ALL classes of
 *     (B_c ∖ W_c) ∪ (W_c ∖ B_c), despiked and AOI-clipped): both operands of
 *     every difference are first cut to the rectangles of the region's parts
 *     with `clipToExtent` (bboxClip — never `intersect`).
 * Why that loses nothing, given the baseline B is NESTED (B_i ⊆ B_{i−1}, which
 * `createChangeset` guarantees by healing — the reason this is opt-in and not
 * the default): write D for the region. For up_i = B_i ∖ W_{i−1}: a point p
 * in it has p ∈ B_i ⊆ B_{i−1} and p ∉ W_{i−1}, so p ∈ B_{i−1} ∖ W_{i−1} ⊆ D.
 * For down_i = W_i ∖ B_{i−1}: if p ∈ W_{i−1} then p ∈ W_{i−1} ∖ B_{i−1} ⊆ D;
 * otherwise p ∈ W_i ∖ W_{i−1} (containment broken — the rule must still
 * answer), and p ∉ B_i (else p ∈ B_i ∖ B_{i−1} = ∅), so p ∈ W_i ∖ B_i ⊆ D.
 * Every term lies inside D — note the two cases land in DIFFERENT classes'
 * diffs, which is why the region must be the union over all classes — and for
 * R ⊇ D, (X ∩ R) ∖ (Y ∩ R) = (X ∖ Y) ∩ R = X ∖ Y whenever X ∖ Y ⊆ R. The
 * region is despiked and clipped, both of which move less than the tolerance.
 *
 * The TOTAL is the area of the UNION of the pieces, not their sum: ground that
 * jumped three classes sits in up_1, up_2 and up_3 at once, and the sum
 * reported it three times (the cross-check above was a two-class jump, where
 * the terms happen to be disjoint).
 */
export function ruleOneClassMove(baselineContours, workingContours, {
  toleranceM2 = CONTAINMENT_TOLERANCE_M2,
  region = undefined,
  baselineLabel = null,
} = {}) {
  const turf = T();
  const id = 'one-class-move';
  if (!baselineContours || !workingContours) return pass(id);
  if (region === null) return pass(id);

  /* The rectangles of the changed region's parts, or null for the full rule. */
  const boxes = region === undefined ? null : indexParts(region).map((p) => p.bbox);
  if (boxes && !boxes.length) return pass(id);
  const narrow = (g) => {
    if (!boxes) return asMulti(g);
    const parts = indexParts(g);
    if (!parts.length) return null;
    const kept = [];
    for (const bb of boxes) {
      const c = clipToExtent(parts, bb);
      if (c) kept.push(...c.coordinates);
    }
    return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
  };

  const minus = (a, b) => {
    const x = narrow(a);
    if (!x) return null;
    const y = narrow(b);
    if (!y) return x;
    return asMulti(turf.difference(turf.featureCollection([asFeature(x), asFeature(y)])));
  };

  const jumped = [];
  for (let i = 1; i <= 4; i++) {
    const inner = 'D' + i, outer = 'D' + (i - 1);
    /* IMPROVED by two or more: it was D_i or worse, and it is now milder than
       D_{i−1} — so it skipped D_{i−1} entirely. */
    const up = minus(baselineContours[inner], workingContours[outer]);
    if (up && areaKm2(up) * 1e6 > toleranceM2) {
      jumped.push({ dir: 'improve', from: inner, to: outer, geometry: up, km2: areaKm2(up) });
    }
    /* DEGRADED by two or more: the mirror. */
    const down = minus(workingContours[inner], baselineContours[outer]);
    if (down && areaKm2(down) * 1e6 > toleranceM2) {
      jumped.push({ dir: 'degrade', from: inner, to: outer, geometry: down, km2: areaKm2(down) });
    }
  }
  if (!jumped.length) return pass(id);

  jumped.sort((a, b) => b.km2 - a.km2);
  const worst = jumped[0];
  /* The union, once, for both the total and the geometry the UI zooms to. */
  let all;
  try {
    all = jumped.length === 1 ? asMulti(jumped[0].geometry)
      : asMulti(turf.union(turf.featureCollection(jumped.map((j) => asFeature(j.geometry)))));
  } catch {
    all = null;
  }
  if (!all) {
    all = { type: 'MultiPolygon', coordinates: jumped.flatMap((j) => asMulti(j.geometry).coordinates) };
  }
  const total = areaKm2(all);
  /* ONE SENTENCE, NAMING THE BIGGEST PIECE. A rule that lists eight differences
     is a rule nobody finishes reading, and every piece is in the geometry the
     UI zooms to. The verb is named because the fix differs: an over-improvement
     is undone by degrading it back, and vice versa. */
  return fail(id,
    /* `fmtMi2Notice`: this rule fires on residue-scale pieces too, and at
       `fmtMi2`'s precision both numbers printed as "0" — a check that reports
       "0 mi² moves more than one drought class … the largest is 0 mi²" is a
       failure nobody can act on or believe (#17). */
    /* THE DATE, NOT "LAST WEEK": a proposal is the FOLLOWING week's map drawn
       from the published one, and relative words sent an author looking for a
       second class their edits never made (2026-09-14). */
    `${fmtMi2Notice(total)} ${MI2} moves more than one drought class from the ` +
    `published ${baselineLabel ?? 'map'}${baselineLabel ? ' map' : ''} — the largest is ${fmtMi2Notice(worst.km2)} ${MI2} that ` +
    `${worst.dir === 'improve' ? 'improved past' : 'degraded past'} ` +
    `${worst.to}. Only one class of change a week is allowed, so this needs ` +
    `${worst.dir === 'improve' ? 'degrading' : 'improving'} back by one.`, all);
}

/**
 * Select the parts of `geometry` that lie near `region` — the changed area.
 * Bbox-only, so it is cheap and deliberately generous: it may include a part
 * that merely shares a bounding box with an edit, which costs a little extra
 * checking and never misses a part that was actually touched.
 */
export function partsNear(geometry, region) {
  const m = asMulti(geometry);
  if (!m) return null;
  if (!region) return m;
  const boxes = indexParts(region).map((p) => p.bbox);
  if (!boxes.length) return null;
  const kept = m.coordinates.filter((rings) => {
    const bb = ringBBox(rings);
    return boxes.some((b) => bboxOverlaps(bb, b));
  });
  return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
}

/* ══ Local boolean editing primitives ═══════════════════════════════════════
   Three narrowed boolean ops, and one shared trick. Each splits its subject's
   parts by bounding box into FAR (provably untouched by the operand) and NEAR,
   runs the clipper on the near group alone, and CONCATENATES the far parts back
   onto the result.

   The concatenation is exact, not an approximation, and the argument is the
   same one `applyToNational` makes about its own far/near split: a part whose
   bounding box misses the operand's bounding boxes cannot intersect the
   operand, so `union` would return it unchanged and `difference` would return
   it unchanged. Handing it to the clipper anyway buys nothing and costs
   everything — the operand for a cascade heal is a few hundred m², while the
   subject can be a 59,802-vertex state contour.

   The result is a MultiPolygon whose parts are the far parts plus the clipped
   near group. Far parts may end up EDGE-ABUTTING a healed near part; touching
   parts have zero-area overlap and pass `rulePartsDontOverlap`.
   ══════════════════════════════════════════════════════════════════════════ */

/** `geometry ∪ addition`, with the clipper handed only the parts near `addition`. */
export function unionNear(geometry, addition) {
  const turf = T();
  const add = asMulti(addition);
  if (!add) return asMulti(geometry);
  const { far, near } = splitByProximity(geometry, add);
  const joined = near.length
    ? asMulti(turf.union(turf.featureCollection([
        asFeature({ type: 'MultiPolygon', coordinates: near }), asFeature(add)])))
    : add;
  return concatParts(far, joined);
}

/** `geometry ∖ cut`, with the clipper handed only the parts near `cut`. */
export function differenceNear(geometry, cut) {
  const turf = T();
  const knife = asMulti(cut);
  if (!knife) return asMulti(geometry);
  const { far, near } = splitByProximity(geometry, knife);
  const kept = near.length
    ? asMulti(turf.difference(turf.featureCollection([
        asFeature({ type: 'MultiPolygon', coordinates: near }), asFeature(knife)])))
    : null;
  return concatParts(far, kept);
}

/**
 * `geometry ∩ mask`. No far parts survive an intersection, so this one only
 * narrows the input — `partsNear` throws away everything that cannot contribute
 * before the clipper sees it.
 */
export function intersectNear(geometry, mask) {
  const turf = T();
  const m = asMulti(mask);
  if (!m) return null;
  const near = partsNear(geometry, m);
  if (!near) return null;
  return asMulti(turf.intersect(turf.featureCollection([asFeature(near), asFeature(m)])));
}

function splitByProximity(geometry, operand) {
  const boxes = indexParts(operand).map((p) => p.bbox);
  const far = [], near = [];
  for (const p of indexParts(geometry)) {
    (boxes.some((b) => bboxOverlaps(p.bbox, b)) ? near : far).push(p.rings);
  }
  return { far, near };
}

function concatParts(far, clipped) {
  const coordinates = [...far, ...(clipped ? asMulti(clipped)?.coordinates ?? [] : [])];
  return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
}

/* ══ The containment cascade ════════════════════════════════════════════════

   An edit to one class can break the single invariant this file exists to hold:
   `contour[4] ⊆ contour[3] ⊆ … ⊆ contour[0]`. Push D2 out past D1 and D2 is no
   longer inside D1; erase a piece of D0 and whatever D1 sat there is orphaned.
   The rules ALREADY detect both (`ruleContainedIn`), and detecting them is the
   wrong answer for the primary editing gesture: an author who widens a severe
   area means "and the moderate area around it widens too", which is what the
   cumulative-contour model says a stacked USDM map is.

   So the cascade REPAIRS, and `validateContours` keeps rejecting — the gate and
   the editor stay two different questions with two different answers. Nothing
   below is reachable from `validate()`, `finalize()`, or the deferred
   server-side gate.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A cheap superset of an edit's symmetric difference, used to narrow every
 * check the cascade runs.
 *
 * Parts are keyed by `JSON.stringify(rings)`, with multiplicity, so a part
 * present on both sides with an identical key is UNCHANGED and contributes
 * nothing. Every unmatched part, from EITHER side, contributes its bounding
 * rectangle. The result is a MultiPolygon of those rectangles, or **null when
 * everything matched** — which lets a caller skip the cascade outright on a
 * no-op commit.
 *
 * ── Why this is sound ──────────────────────────────────────────────────────
 * A containment pair can only newly fail where geometry actually changed, and
 * every changed part's footprint lies inside that part's bounding box. So the
 * union of the unmatched parts' boxes is a superset of the delta. It is
 * generous — a moved vertex reports its whole part's box — and generous is the
 * correct posture here, the same one `partsNear` takes: extra area costs one
 * more bbox test per part and can never MISS a part that was touched.
 *
 * ── Why a hash and not a boolean op ────────────────────────────────────────
 * The honest region is `symmetricDifference(old, new)`, which is two clipper
 * passes over a whole class — seconds on a national contour, and the thing this
 * function is called to avoid. Stringifying is linear in vertices and has no
 * numeric behaviour at all: two parts either are the same bytes or they are
 * not. It cannot report a false MATCH (identical bytes are identical geometry),
 * and a false MISMATCH only widens the region, which is safe by the argument
 * above.
 *
 * @param {object|null} oldGeom (Multi)Polygon before the edit
 * @param {object|null} newGeom (Multi)Polygon after it
 * @returns {object|null} MultiPolygon of bounding rectangles, or null
 */
export function changedBBoxRegion(oldGeom, newGeom) {
  const a = asMulti(oldGeom), b = asMulti(newGeom);
  if (!a && !b) return null;

  /* key → { bbox, count }. The count is what makes duplicate parts — legal, and
     produced by any clipper that emits the same fragment twice — cancel one for
     one instead of all at once. */
  const pool = new Map();
  if (a) {
    for (const rings of a.coordinates) {
      const key = JSON.stringify(rings);
      const seen = pool.get(key);
      if (seen) seen.count++;
      else pool.set(key, { bbox: ringBBox(rings), count: 1 });
    }
  }

  const boxes = [];
  if (b) {
    for (const rings of b.coordinates) {
      const seen = pool.get(JSON.stringify(rings));
      if (seen && seen.count > 0) { seen.count--; continue; }
      boxes.push(ringBBox(rings));
    }
  }
  for (const seen of pool.values()) {
    for (let i = 0; i < seen.count; i++) boxes.push(seen.bbox);
  }
  if (!boxes.length) return null;
  return { type: 'MultiPolygon', coordinates: boxes.map(bboxRing) };
}

function bboxRing([x0, y0, x1, y1]) {
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

/**
 * Repair the containment invariant after an edit to one class, by moving the
 * NEIGHBOURING classes.
 *
 * Pure: the input `contours` object is not mutated and neither is any geometry
 * inside it. Classes the cascade did not heal are passed through by reference.
 *
 * @param {object} contours {D0..D4}; any class may be null
 * @param {object} opts
 * @param {string} [opts.editedClass] which class the author changed. Required
 *        unless `sweepAll` — the sweeps are defined relative to it.
 * @param {object|null} [opts.region] where the edit happened — typically
 *        `changedBBoxRegion(before, after)`, or the drawn shape itself when the
 *        caller knows it exactly. Null checks everything, which is correct and
 *        slow.
 * @param {number} [opts.toleranceM2] the containment rule's own tolerance; a
 *        pair that passes within it is never healed.
 * @param {boolean} [opts.sweepAll] grow-milder-only repair over ALL pairs, with
 *        no early stop — see below.
 * @param {function|null} [opts.clean] optional post-processor applied to every
 *        geometry the cascade PRODUCES (never to one it passes through). Pure
 *        `(geometry) => geometry`. js/changeset.js passes its AOI clip here, so
 *        that a heal cannot leave clipper noise outside a polygon working area
 *        — including transiently, between one healed pair and the next check.
 * @returns {{contours: object, healed: Array<{usdmClass:string,
 *           op:'grew'|'shrank'|'removed'|'created', areaKm2:number}>}}
 *          `healed` is in heal order; `areaKm2` is the area of the escaped
 *          region that provoked the heal — what the class gained (grew,
 *          created) or lost (shrank, removed).
 *
 * The full correctness argument lived in this header and moved to git history
 * (`git log -L` on this function); tools/topology.test.mjs §§ 12–13 pin the
 * behaviour and print the timings (0.8–9 ms across county- to state-scale
 * edits — all of it `region` narrowing). The short form:
 *   · narrowing BOTH operands of the per-pair check is EXACT, not approximate:
 *     an outer part whose bbox misses `innerNear` cannot reduce the difference,
 *     and an inner part away from `region` was contained by unmoved geometry;
 *   · the two sweeps write disjoint classes (down: index > n, shrink-only;
 *     up: index < n, grow-only), so one monotone pass per direction is
 *     complete, and stopping at the first passing pair is sound because the
 *     class that pair would write is still byte-identical to its pre-edit
 *     (already-contained) self;
 *   · `sweepAll` (resetShape has no editedClass) checks ALL pairs, grow-milder
 *     only — POLICY: a reset seam can strand a severer part the author KEPT,
 *     and growing the milder class preserves that work where trimming it would
 *     destroy it;
 *   · a pair that PASSES is never healed, or every commit would churn the few
 *     m² of clipper noise on a shared edge. Above ~20,000 near-vertices the
 *     narrowing is defeated; `CASCADE_BUSY_VERTS` (js/editor.js) says so.
 */
export function cascadeContainment(contours, {
  editedClass = null,
  region = null,
  toleranceM2 = CONTAINMENT_TOLERANCE_M2,
  sweepAll = false,
  clean = null,
} = {}) {
  /* Shallow copy: heals replace whole class entries, and nothing below writes
     into a geometry object. Untouched classes are shared with the input by
     reference, which is what every other function in this file does too. */
  const out = { ...contours };
  const healed = [];
  const tidy = (g) => (clean && g ? clean(g) : g);

  /** The escaped region for pair (D_m ⊆ D_{m-1}), or null when the pair holds. */
  function escapeOf(m) {
    const innerNear = partsNear(out['D' + m], region);
    if (!innerNear) return null;
    const outerNear = partsNear(out['D' + (m - 1)], innerNear);
    const r = ruleContainedIn(innerNear, outerNear, {
      innerLabel: 'D' + m, outerLabel: 'D' + (m - 1), toleranceM2,
    });
    return r.ok ? null : r.geometry;
  }

  function growOuter(m, escaped) {
    const cls = 'D' + (m - 1);
    const before = out[cls];
    out[cls] = tidy(before ? unionNear(before, escaped) : structuredClone(asMulti(escaped)));
    healed.push({ usdmClass: cls, op: before ? 'grew' : 'created', areaKm2: areaKm2(escaped) });
  }

  function trimInner(m, escaped) {
    const cls = 'D' + m;
    const next = tidy(differenceNear(out[cls], escaped));
    out[cls] = next;
    healed.push({ usdmClass: cls, op: next ? 'shrank' : 'removed', areaKm2: areaKm2(escaped) });
  }

  if (sweepAll) {
    for (let m = 4; m >= 1; m--) {
      const escaped = escapeOf(m);
      if (escaped) growOuter(m, escaped);
    }
    return { contours: out, healed };
  }

  const n = CLASSES.indexOf(editedClass);
  if (n < 0) {
    throw new Error('[usdm/topology] cascadeContainment needs an editedClass ' +
      `(got ${JSON.stringify(editedClass)}), or sweepAll: true`);
  }

  for (let m = n + 1; m <= 4; m++) {
    const escaped = escapeOf(m);
    if (!escaped) break;
    trimInner(m, escaped);
  }
  for (let m = n; m >= 1; m--) {
    const escaped = escapeOf(m);
    if (!escaped) break;
    growOuter(m, escaped);
  }
  return { contours: out, healed };
}

/**
 * The full §3a gate over a contour set. `contours` is {D0..D4}; any class may
 * be null.
 *
 * ── Two options that exist for measured reasons ────────────────────────────
 *
 * `scope` names what was checked ('extent' or 'national') in the record the
 * proposal package carries, so a reviewer can tell a live in-editor check from
 * the final whole-country one. It also picks the default for `checkPartOverlap`,
 * and that default is the opposite of the obvious one:
 *
 *   · At EXTENT scope the rule runs. This is where a person draws, so it is
 *     where a self-overlap can actually be created — and with a handful of
 *     parts in view it costs under a millisecond.
 *   · At NATIONAL scope it does not. Those contours came straight out of
 *     `turf.union`, which yields disjoint parts by construction, so the rule
 *     can only confirm what the algorithm already guarantees — and it is
 *     quadratic in parts, which on D0's 1,775 contour parts means over a
 *     million candidate pairs and minutes of clipper work.
 *
 * `checkSelfIntersection` is **off by default**, and that is not a performance
 * concession — it is where the check belongs. See the block comment on
 * `validateEditedFeature` below. `changedRegion` narrows it when you do turn it
 * on. `turf.kinks` is quadratic
 * in the vertices of a single part, and `union` produces a few very large ones:
 * checking D0's national contour whole costs **37 seconds**. It is also work
 * nobody needs — the archive validates and repairs its geometry with S2 before
 * publishing, so inherited vertices are already known-good, and the only vertices
 * that can newly self-intersect are the ones an author moved. Pass the changed
 * region and the check runs against the parts that were touched — though even
 * that is not enough on its own, because a single inherited D0 part can carry
 * 100k+ vertices and cost 40 s by itself.
 */
export function validateContours(contours, {
  minAreaM2 = MIN_PART_AREA_M2,
  toleranceM2 = CONTAINMENT_TOLERANCE_M2,
  scope = 'extent',
  checkPartOverlap = scope === 'extent',
  checkSelfIntersection = false,
  changedRegion = null,
  baselineContours = null,
  narrowOneClassMove = false,
  baselineLabel = null,
} = {}) {
  const results = [];
  for (const c of CLASSES) {
    const g = contours[c];
    if (!g) continue;
    results.push(withClass(ruleValidRings(g, `${c} contour`), c));
    results.push(withClass(ruleNoDegenerateParts(g, { minAreaM2, label: `${c} contour` }), c));
    if (checkSelfIntersection) {
      const touched = partsNear(g, changedRegion);
      if (touched) results.push(withClass(ruleNoSelfIntersection(touched, `${c} contour`), c));
    }
    if (checkPartOverlap) {
      results.push(withClass(rulePartsDontOverlap(g, { minAreaM2, label: `${c} contour` }), c));
    }
  }
  for (let n = 4; n >= 1; n--) {
    const inner = contours['D' + n], outer = contours['D' + (n - 1)];
    if (!inner) continue;
    results.push(withClass(ruleContainedIn(inner, outer, {
      innerLabel: `D${n}`, outerLabel: `D${n - 1}`, toleranceM2,
    }), `D${n}`));
  }
  /* ONE CLASS A WEEK, and only when there is a baseline to compare against.
     `validateContours` is also called on geometry with no baseline in hand —
     the national fold, `validateDerivedBands`' sibling checks — and a rule that
     silently passes when it cannot run is better than one that demands an
     argument every caller has to invent. See `ruleOneClassMove`. */
  if (baselineContours) {
    /* `narrowOneClassMove` is set by the LIVE changeset alone, whose baseline
       is healed and whose `changedRegion` is exact; the exported gate keeps
       the full algebra (see the rule's header for why nesting is required). */
    results.push(ruleOneClassMove(baselineContours, contours, {
      toleranceM2, baselineLabel, ...(narrowOneClassMove ? { region: changedRegion ?? null } : {}),
    }));
  }
  return {
    scope,
    passed: results.every((r) => r.ok),
    failures: results.filter((r) => !r.ok),
    rules: results,
    ranAt: new Date().toISOString(),
  };
}

const withClass = (r, usdmClass) => ({ ...r, usdmClass });

/**
 * Derived-output sanity check (handoff §3a, last row). Runs AFTER deriveBands():
 * the derivation should never produce anything invalid, so a failure here means
 * a clipper bug rather than an author mistake — and it must block a submission
 * rather than be repaired silently.
 *
 * Self-intersection is off here for the same reason as above.
 */
export function validateDerivedBands(bands, {
  minAreaM2 = MIN_PART_AREA_M2, toleranceM2 = CONTAINMENT_TOLERANCE_M2,
  checkSelfIntersection = false, changedRegion = null,
} = {}) {
  const results = [];
  for (const c of CLASSES) {
    const g = bands[c];
    if (!g) continue;
    results.push(withClass(ruleValidRings(g, `${c} band`), c));
    results.push(withClass(ruleNoDegenerateParts(g, { minAreaM2, label: `${c} band` }), c));
    if (checkSelfIntersection) {
      const touched = partsNear(g, changedRegion);
      if (touched) results.push(withClass(ruleNoSelfIntersection(touched, `${c} band`), c));
    }
  }
  /* Bands are a partition: adjacent classes must not overlap. STACKING is what
     this catches — the same ground carrying two classes — and stacking has
     width. Along an edge both bands were cut from (contour[n+1]'s ring, an
     outer edge for one and a hole for the other) the clipper leaves residue
     that can total more than `toleranceM2` while being metres wide or less:
     0.07 km² over 7 parts on 2020-10-20, 6.4 km² at 21 m along the Rio Grande
     on 2011-01-11 (the measurements are at `RESIDUE_WIDTH_M`). So an overlap
     fails only if it is also WIDER than residue (mean width =
     2·area/perimeter); a corrupted band (verify § 7j replaces D2 with a
     square) is kilometres wide and still fails.

     BBOX-PREFILTERED, like every other boolean op in this file. This was the
     one naked `turf.intersect` left in it: four whole-band intersections, each
     handed every part of two national classes. `partsNear` in both directions
     then `intersectNear` is EXACT here for the same reason it is exact for
     `rulePartsDontOverlap` — a part whose bounding box misses every box on the
     far side contributes no area to the intersection, so dropping it cannot
     change `m2`, cannot change `meanWidthM`, and cannot turn a failure into a
     pass. (`partsNear(a, bNear)` rather than `partsNear(a, b)` loses nothing
     either: a part of `b` that the first pass dropped missed every box of `a`,
     so no part of `a` was reaching it.)

     THE WIN IS SMALL AND THE REASON IS WORTH KEEPING. Measured over the four
     national pairs (2026-09-08 folded back from Montana): the filter drops
     31→25, 47→31, 35→20 and 41→9 parts, and the four intersects go 118→112,
     108→104, 68→65 and 25→19 ms — 319 → 300 ms, inside a 1,483 ms
     `finalize()`. The parts a bounding box can prove innocent are the SMALL
     ones, and the clipper is priced in vertices; what this buys is the
     doctrine, not the millisecond.

     IDENTICAL RESULTS, CHECKED AGAINST THE ARCHIVE. 179 adjacent-class pairs
     over 47 weeks sampled across 2000-2026 (the two residue weeks named above
     among them: 2011-01-11 reports 6,429,988 m² at 21.1 m either way,
     2020-10-20 69,546 m² at 0.5 m) agree on the verdict, on the area, on the
     mean width, and on `JSON.stringify(both)` — zero mismatches. The bytes
     matter as much as the verdict, because `both` is the geometry a failure
     hands the UI to zoom to. Over those 179 pairs the prefilter took 6,998 ms
     against the naked 7,466: 6.3% less. */
  for (let n = 0; n < 4; n++) {
    const a = asMulti(bands['D' + n]), b = asMulti(bands['D' + (n + 1)]);
    if (!a || !b) continue;
    const bNear = partsNear(b, a);
    const both = bNear ? intersectNear(a, bNear) : null;
    const m2 = both ? areaKm2(both) * 1e6 : 0;
    const width = both ? meanWidthM(both) : 0;
    results.push(withClass(m2 > toleranceM2 && width > RESIDUE_WIDTH_M
      ? fail('band-overlap', `Derived D${n} and D${n + 1} bands overlap by ` +
          `${fmtMi2Fine(m2 / 1e6)} ${MI2} (mean width ${fmtFt(width)} ft). Bands must partition, not stack.`, both)
      : pass('band-overlap'), `D${n}`));
  }
  return {
    scope: 'derived-bands',
    passed: results.every((r) => r.ok),
    failures: results.filter((r) => !r.ok),
    rules: results,
    ranAt: new Date().toISOString(),
  };
}

/* ══ Self-intersection is checked on AUTHORED features only ══════════════════
   Never over inherited geometry, for three measured reasons:
     · `turf.kinks` is quadratic per part: D0's national contour costs 37 s,
       and 40 s even bbox-scoped (one part carries the vertices);
     · the archive itself ships pinched rings — sf validates on the SPHERE, and
       USDM_2012-07-24 D3 and 2019-05-07 D0 each kink when read planar — so an
       aggregate gate would refuse weeks the editor cannot fix;
     · rectangle clips false-positive along their own cut line (Montana extent:
       4 D3 "kinks", all exactly on y = 44.36, none in the national band).
   A ring a person just dragged has few vertices and no clip boundary, so the
   cost and the artifacts both vanish. This is what Terra Draw's `validation`
   hook calls, on `provisional`, `finish` and `commit`. ═══════════════════════ */

/**
 * Validate ONE feature an author is drawing or reshaping.
 *
 * Shaped for Terra Draw: it takes a GeoJSON Feature and returns
 * `{ valid, reason }`, which is exactly what a Terra Draw `validation` function
 * must return. `reason` is shown to the author, so it says what to do, not what
 * failed.
 *
 * @param {object} feature a Terra Draw store Feature (Polygon)
 * @param {object} [opts]
 * @param {number} [opts.minAreaM2]  degeneracy floor
 * @param {object} [opts.mustFitInside]  the parent contour, when editing D1–D4
 * @param {object} [opts.mustFitInsideAOI]  the working area's own boundary,
 *                 when it is a jurisdiction rather than a rectangle
 * @param {string} [opts.aoiLabel]   what that area is called, e.g. 'Montana'
 * @param {string} [opts.label]      class name for the message, e.g. 'D2'
 * @returns {{valid: boolean, reason?: string}}
 */
export function validateEditedFeature(feature, {
  minAreaM2 = MIN_PART_AREA_M2, mustFitInside = null, label = 'This area',
  parentLabel = 'the milder class', mustFitInsideAOI = null, aoiLabel = '',
} = {}) {
  const geom = feature?.geometry;
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
    return { valid: true };            // points and lines are not ours to judge
  }
  const rings = ruleValidRings(geom, label);
  if (!rings.ok) return { valid: false, reason: rings.message };

  const kinks = ruleNoSelfIntersection(geom, label);
  if (!kinks.ok) {
    return { valid: false, reason: `${label} crosses itself. Untangle the outline before committing.` };
  }
  const degen = ruleNoDegenerateParts(geom, { minAreaM2, label });
  if (!degen.ok) return { valid: false, reason: degen.message };

  /* The AOI check runs BEFORE the parent-contour check, and the order matters
     for what the author is told. When the working area is a jurisdiction, every
     contour in the changeset was clipped to it, so a ring dragged out of the
     AOI has necessarily also left its parent contour — both rules fire, and
     only one of them names the thing the author actually did. "You have left
     Montana" is actionable; "D2 falls outside D1" sends them looking for a
     containment bug that is not there. */
  if (mustFitInsideAOI) {
    const outerLabel = aoiLabel ? `the working area (${aoiLabel})` : 'the working area';
    const inside = ruleContainedIn(geom, mustFitInsideAOI, {
      innerLabel: label, outerLabel,
    });
    if (!inside.ok) {
      /* The rule's own message reports how many km² escaped, which is the right
         sentence in a review panel and the wrong one under a cursor mid-drag.
         Here it is replaced with the instruction. */
      return { valid: false,
        reason: `${label} must stay inside ${outerLabel}. ` +
                `Move the vertex back inside the outlined boundary.` };
    }
  }

  if (mustFitInside) {
    const contained = ruleContainedIn(geom, mustFitInside, {
      innerLabel: label, outerLabel: parentLabel,
    });
    if (!contained.ok) return { valid: false, reason: contained.message };
  }
  return { valid: true };
}
