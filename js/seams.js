/* ══ USDM Edit Viewer · js/seams.js ═══════════════════════════════════════════
   A step along a shared working-area border that the published map did not
   have — the finding kind a reconciliation meeting cannot see any other way,
   because each author only ever drew inside their own jurisdiction.

   DOM-free (docs/contracts.md § 5; tools/compare.test.mjs § 0 greps for it).
   The published far side of a seam is the one thing here that can need the
   network, and it arrives as resolved BANDS from js/published.js — this module
   never fetches.

   ── WHY THIS ONE SAMPLES, when js/compare.js insists on exact polygons ─────
   A seam has no area. The question is "what class does each side put against
   this stretch of line", and the exact answer would be a buffer intersected
   with two class sets — two boolean ops per class per side, over geometry that
   runs along a thousand-vertex boundary, to produce ribbons nobody looks at.
   Walking the line every 2 km and asking each side one point query 1 km inland
   answers the same question in whole miles, with no boolean op at all.
   Measured over the SD/NE line: 341 samples, 0 indeterminate. The 1 km offset
   is what makes that zero — it clears both the FSA boundary's ~40 m zigzag and
   the editor's 0.5 km `NEIGHBOR_BUFFER_KM`, so a sample never lands in the
   noise between two renderings of the same border.

   ── THE SHARED LINE IS NOT `turf.lineOverlap`, AND THAT IS MEASURED ────────
   docs/contracts.md § 5 specifies bbox-clipping both rings and running
   `lineOverlap` at 50 m. Both halves of that fail on this corpus:

     · THE CLIP INVENTS SHARED LINE. Clipping two AOIs to their envelope
       overlap closes each one along the SAME four rectangle edges, and the
       clipper's artificial edge then coincides with the neighbour's real
       boundary. Montana clipped to the MT∩WY envelope gains a vertical edge
       at −111.07°, which IS Wyoming's western state line for 72 km: the two
       "share" a border along Idaho. Measured on the demo AOIs, clipping
       turned the MT/WY line into 279.0 km (the true figure is 608.6) and the
       NE/SD line into 681.5 km against 109.9 km for the same call unclipped.

     · `lineOverlap` IS ARGUMENT-ORDER DEPENDENT and non-monotonic in its
       tolerance. It walks the SECOND line's segments against an index of the
       first, so a coarse ring against a fine one answers differently each way
       round: the NE/SD line came back 572.1 km with South Dakota first and
       109.9 km with Nebraska first, both at 50 m, and 681.5 km at a tolerance
       of ZERO. (The vendored js/changes.js knows this — its edge-effect note
       says the patch outline must go first — but there the two operands are a
       short fragment and a long line, and here neither is.)

   So `sharedLine` keeps the segments of A's boundary that RUN WITHIN THE
   TOLERANCE OF B's, which is what "shared" means, and is symmetric by
   construction: measured A-side against B-side on all ten AOI pairs, the two
   agree to 0.1 km. Cost 1–10 ms per pair with the segment grid below.
   ========================================================================== */

import {
  T, asFeature, indexParts, envelopeOf, bboxOverlaps, clipToExtent,
} from '../vendor/usdm-editor/js/topology.js';
import {
  ord, levelIndex, classAtIndex, pointInParts, findingId,
} from './proposal.js';

/** Sample every 2 km along the line — a number about reading a map in miles. */
export const SEAM_SPACING_KM = 2;
/** …asking each side 1 km inland. See the header for why 1 km and not less. */
export const SEAM_OFFSET_KM = 1;
/** How close two rings must run to count as the same border. The editor's
 *  `EDGE_TOLERANCE_KM`, so a seam and an edge effect agree about where a
 *  boundary is. */
export const SEAM_TOLERANCE_KM = 0.05;

/** Degrees of latitude in a kilometre — the corridor pad, not a measurement. */
const DEG_PER_KM = 1 / 111.32;

/* ── the shared line ──────────────────────────────────────────────────────── */

/**
 * The stretch of boundary two working areas have in common, or null.
 *
 * @param {object} aoiA  `{ geometry, ... }` — a Proposal's `aoi`
 * @param {object} aoiB
 * @param {number} [toleranceKm]
 * @returns {object|null} MultiLineString in A's own vertices
 */
export function sharedLine(aoiA, aoiB, { toleranceKm = SEAM_TOLERANCE_KM } = {}) {
  const partsA = indexParts(aoiA.geometry);
  const partsB = indexParts(aoiB.geometry);
  /* `envelopeOf(indexParts(...))`, never the shipped `aoi.bbox` — the Alaska
     rule (CLAUDE.md): a composite boundary file can ship a rectangle that does
     not contain its own rings, and this test would then reject a real pair. */
  const ea = envelopeOf(partsA), eb = envelopeOf(partsB);
  if (!ea || !eb || !bboxOverlaps(ea, eb)) return null;

  const lineA = boundaryOf(aoiA.geometry);
  const lineB = boundaryOf(aoiB.geometry);
  if (!lineA || !lineB) return null;

  const grid = segmentGrid(lineB, toleranceKm);
  const kept = [];
  for (const string of lineA.coordinates) {
    let run = null;
    for (let i = 0; i < string.length - 1; i++) {
      const a = string[i], b = string[i + 1];
      if (grid.nearBoth(a, b)) {
        if (run) run.push(b);
        else run = [a, b];
      } else {
        if (run && run.length > 1) kept.push(run);
        run = null;
      }
    }
    if (run && run.length > 1) kept.push(run);
  }
  return kept.length ? { type: 'MultiLineString', coordinates: kept } : null;
}

/**
 * A cell index over one boundary's segments, with a planar point-to-segment
 * distance.
 *
 * EQUIRECTANGULAR, deliberately: the question is whether two renderings of the
 * same jurisdiction line run within 50 m of each other, over segments a few
 * hundred metres long, at 40–49°N. Scaling longitude by cos(lat) makes the
 * error in that answer millimetres, and it replaces a `turf.pointToLineDistance`
 * per candidate — which is what took the NE/SD line from 102 ms to 2 ms.
 */
function segmentGrid(line, toleranceKm) {
  const tolDeg = toleranceKm * DEG_PER_KM;
  const cell = 0.05;
  const cells = new Map();
  const segs = [];
  for (const string of line.coordinates) {
    for (let i = 0; i < string.length - 1; i++) segs.push([string[i], string[i + 1]]);
  }
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    const x0 = Math.floor((Math.min(a[0], b[0]) - tolDeg) / cell);
    const x1 = Math.floor((Math.max(a[0], b[0]) + tolDeg) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - tolDeg) / cell);
    const y1 = Math.floor((Math.max(a[1], b[1]) + tolDeg) / cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x}:${y}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  }
  function near(point) {
    const k = `${Math.floor(point[0] / cell)}:${Math.floor(point[1] / cell)}`;
    const candidates = cells.get(k);
    if (!candidates) return false;
    for (const i of candidates) {
      if (distToSegmentKm(point, segs[i][0], segs[i][1]) <= toleranceKm) return true;
    }
    return false;
  }
  /* BOTH ENDPOINTS AND THE MIDPOINT. Endpoints alone would keep a segment
     that leaps across a bay between two coincident vertices; the midpoint
     alone would keep one whose ends wander off. Three tests is still
     arithmetic. */
  return {
    nearBoth(a, b) {
      return near(a) && near(b) && near([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    },
  };
}

function distToSegmentKm(p, a, b) {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110.57;
  const px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  const dx = px - t * bx, dy = py - t * by;
  return Math.hypot(dx, dy);
}

/**
 * A (Multi)Polygon's rings as one MultiLineString.
 *
 * The vendored `js/changes.js`'s `boundaryOf`, which is module-private there
 * and cannot be imported without editing a copy this app is forbidden to edit
 * (CLAUDE.md). `turf.polygonToLine` returns a LineString for a simple polygon,
 * a MultiLineString when there are holes, and a FeatureCollection of either
 * for a MultiPolygon — the read-it-at-the-wrong-depth hazard, one geometry
 * type over from `asMulti`'s.
 */
function boundaryOf(geometry) {
  const f = asFeature(geometry);
  if (!f) return null;
  const line = T().polygonToLine(f);
  const coordinates = [];
  const take = (g) => {
    if (!g) return;
    if (g.type === 'LineString') coordinates.push(g.coordinates);
    else if (g.type === 'MultiLineString') coordinates.push(...g.coordinates);
  };
  if (line.type === 'FeatureCollection') for (const feat of line.features) take(feat.geometry);
  else take(line.geometry);
  return coordinates.length ? { type: 'MultiLineString', coordinates } : null;
}

/* ── sides ────────────────────────────────────────────────────────────────── */

/**
 * One side of a seam: who answers for the ground there, and with what.
 *
 * The indexes are CLIPPED TO THE SEAM'S OWN CORRIDOR, and that is the whole
 * reason sampling is cheap. A side only ever answers about points within
 * `SEAM_OFFSET_KM` of one line, so handing the point query a state's entire D0
 * band — a ring with thousands of vertices — would make every one of 341
 * samples walk it. `clipToExtent` over the padded line envelope is a bbox scan
 * plus a `bboxClip` on the few parts that straddle it, paid once per (side,
 * line) and cached by the caller.
 */
export function proposalSide(proposal, corridor) {
  return Object.freeze({
    kind: 'proposal',
    proposal,
    aoi: proposal.aoi,
    aoiParts: clipParts(proposal.aoiParts, corridor),
    bandIndex: clipIndex(proposal.bandIndex, corridor),
    publishedBandIndex: clipIndex(proposal.publishedBandIndex, corridor),
  });
}

/** The far side of a seam where nobody loaded a proposal: the published week. */
export function publishedSide(aoi, bands, corridor) {
  const index = clipIndex(levelIndex(bands), corridor);
  return Object.freeze({
    kind: 'published',
    proposal: null,
    aoi,
    /* No rings for a jurisdiction nobody loaded — which is why the sampler
       decides sides by A's working area alone (docs/contracts.md § 5). */
    aoiParts: null,
    bandIndex: index,
    publishedBandIndex: index,
  });
}

/** The far side of a seam the published week could not be read for. */
export function unknownSide(aoi) {
  return Object.freeze({
    kind: 'unknown', proposal: null, aoi,
    aoiParts: null, bandIndex: [], publishedBandIndex: [],
  });
}

function clipParts(parts, corridor) {
  if (!parts?.length) return [];
  const g = clipToExtent(parts, corridor);
  return g ? indexParts(g) : [];
}

function clipIndex(index, corridor) {
  const out = [];
  for (const lvl of index) {
    const g = clipToExtent(lvl.parts, corridor);
    if (g) out.push({ level: lvl.level, parts: indexParts(g) });
  }
  return out;
}

/** The line's envelope, padded so every offset point falls inside it. */
export function corridorOf(line, padKm = SEAM_OFFSET_KM * 3) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const string of line.coordinates) {
    for (const [x, y] of string) {
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
  }
  /* Longitude degrees shrink with latitude, so the pad is computed at the
     corridor's own worst case rather than at the equator. */
  const latPad = padKm * DEG_PER_KM;
  const lngPad = latPad / Math.max(0.2, Math.cos((Math.max(Math.abs(y0), Math.abs(y1)) * Math.PI) / 180));
  return [x0 - lngPad, y0 - latPad, x1 + lngPad, y1 + latPad];
}

/* ── sampling ─────────────────────────────────────────────────────────────── */

/**
 * Walk the line and ask both sides what they put against it.
 *
 * The point inside A's working area is side A. If BOTH offsets land inside it
 * or NEITHER does — a hairpin in the border, a corner, a tripoint — the sample
 * is retried at half the offset and then marked `indeterminate`. An
 * indeterminate sample SPLITS A RUN AND IS NEVER BRIDGED: a run is a claim
 * about a continuous stretch of border, and bridging a gap nobody could
 * resolve would put a class boundary where the evidence stops.
 *
 * A sample whose class comes back `null` on either side is indeterminate for
 * the same reason: `null` means "outside that side's working area", which is
 * not an answer about this border.
 */
export function sampleSeam(line, sideA, sideB, {
  spacingKm = SEAM_SPACING_KM, offsetKm = SEAM_OFFSET_KM,
} = {}) {
  const turf = T();
  const samples = [];
  for (let s = 0; s < line.coordinates.length; s++) {
    const string = line.coordinates[s];
    const firstOfString = samples.length;
    let acc = 0;
    /* Half a step in, so the first sample sits in the middle of the ground it
       speaks for — and never further in than the middle of a SHORT string: an
       edge effect's segments can be a few hundred metres each, and a fixed
       1 km start would sample none of them at all. */
    const stringKm = lengthOf(turf, string);
    let target = Math.min(spacingKm / 2, stringKm / 2);
    for (let i = 0; i < string.length - 1; i++) {
      const a = string[i], b = string[i + 1];
      const segKm = turf.distance(a, b, { units: 'kilometers' });
      if (!(segKm > 0)) continue;
      const bearing = turf.bearing(a, b);
      while (target <= acc + segKm) {
        const t = (target - acc) / segKm;
        /* Planar interpolation inside one boundary segment — those are
           hundreds of metres long here, and the sample only has to land on the
           line, not at an exact chainage. */
        const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        samples.push(sampleAt(turf, point, bearing, s, target, sideA, sideB, offsetKm));
        target += spacingKm;
      }
      acc += segKm;
    }
    /* EVERY SAMPLE OWNS AN EQUAL SHARE OF ITS OWN STRING, so the runs of a
       line add up to the line: 341 samples over the 681.5 km SD/NE border are
       1.998 km each. A flat `spacing` per sample would be close enough on a
       long string and badly wrong on an edge effect's segments, where eleven
       fragments totalling 5.4 km would each claim 2 km and report 22. */
    const n = samples.length - firstOfString;
    if (n > 0) {
      const share = lengthOf(turf, string) / n;
      for (let k = firstOfString; k < samples.length; k++) samples[k].weightKm = share;
    }
  }
  return samples;
}

function lengthOf(turf, string) {
  let km = 0;
  for (let i = 0; i < string.length - 1; i++) {
    km += turf.distance(string[i], string[i + 1], { units: 'kilometers' });
  }
  return km;
}

function sampleAt(turf, point, bearing, stringIndex, at, sideA, sideB, offsetKm) {
  const base = { point, at, string: stringIndex };
  for (const dist of [offsetKm, offsetKm / 2]) {
    const left = turf.destination(point, dist, bearing + 90, { units: 'kilometers' }).geometry.coordinates;
    const right = turf.destination(point, dist, bearing - 90, { units: 'kilometers' }).geometry.coordinates;
    const leftIsA = pointInParts(sideA.aoiParts, left);
    const rightIsA = pointInParts(sideA.aoiParts, right);
    if (leftIsA === rightIsA) continue;               // both or neither: retry, then give up
    const pa = leftIsA ? left : right;
    const pb = leftIsA ? right : left;
    const classA = classOn(sideA, pa);
    const classB = classOn(sideB, pb);
    const publishedA = publishedOn(sideA, pa);
    const publishedB = publishedOn(sideB, pb);
    if (sideB.kind === 'unknown') {
      /* The far side could not be read. A is still worth recording — the line,
         its length and what this author put against it are the whole of what
         the app can honestly say — so the sample stands with nulls on B. */
      return { ...base, pointA: pa, pointB: pb, classA, classB: null, publishedA, publishedB: null,
        indeterminate: classA == null || publishedA == null };
    }
    if (classA == null || classB == null || publishedA == null || publishedB == null) continue;
    return { ...base, pointA: pa, pointB: pb, classA, classB, publishedA, publishedB, indeterminate: false };
  }
  return { ...base, pointA: null, pointB: null, classA: null, classB: null,
    publishedA: null, publishedB: null, indeterminate: true };
}

/** A side's proposed class at a point: `'none'` inside, null outside. */
function classOn(side, point) {
  if (side.kind === 'unknown') return null;
  if (side.aoiParts && !pointInParts(side.aoiParts, point)) return null;
  return classAtIndex(side.bandIndex, point) ?? 'none';
}

function publishedOn(side, point) {
  if (side.kind === 'unknown') return null;
  if (side.aoiParts && !pointInParts(side.aoiParts, point)) return null;
  return classAtIndex(side.publishedBandIndex, point) ?? 'none';
}

/* ── runs ─────────────────────────────────────────────────────────────────── */

/**
 * Consecutive samples that say the same four things → one run.
 *
 * `lengthKm` is the sum of its samples' shares of their own string, so the
 * runs of a line add up to the line exactly — see `sampleSeam`.
 *
 *   step === 0 with a change on either side → `agree` — both moved and they
 *     still line up, which is the good outcome and not a finding;
 *   step === publishedStep                  → `pre-existing` — the published
 *     map already had this step and neither side widened it;
 *   publishedStep === 0                     → `new` — THE ONE THIS APP EXISTS
 *     FOR: a class boundary that appears at a jurisdiction line because two
 *     people drew two states;
 *   |step| > |publishedStep|                → `widened`;
 *   otherwise                                → `narrowed`.
 *
 * The `pre-existing` test is checked before `new`, which differs from the
 * order docs/contracts.md § 5 lists them in and changes exactly one case: a
 * run where NOTHING changed and there was no published step has step 0 and
 * publishedStep 0, and the § 5 order would call that `new`. It is the opposite
 * of new — it is a stretch of border where nobody proposed anything and
 * nothing was ever wrong. Every other combination classifies identically
 * either way round.
 */
export function seamRuns(samples, { line = null } = {}) {
  const runs = [];
  let current = null;
  const flush = () => {
    if (current) runs.push(finishRun(current, line));
    current = null;
  };
  for (const s of samples) {
    if (s.indeterminate) { flush(); continue; }
    const signature = `${s.string}|${s.classA}|${s.classB}|${s.publishedA}|${s.publishedB}`;
    if (current && current.signature === signature) current.samples.push(s);
    else { flush(); current = { signature, samples: [s] }; }
  }
  flush();
  return runs;
}

function finishRun({ samples }, line) {
  const first = samples[0], last = samples[samples.length - 1];
  const { classA, classB, publishedA, publishedB } = first;
  const unknown = classB == null || publishedB == null;
  const step = unknown ? null : ord(classB) - ord(classA);
  const publishedStep = unknown ? null : ord(publishedB) - ord(publishedA);
  const changedA = classA !== publishedA;
  const changedB = !unknown && classB !== publishedB;
  const changedBy = changedA && changedB ? 'both' : changedA ? 'A' : changedB ? 'B' : 'neither';
  return Object.freeze({
    classA, classB, publishedA, publishedB,
    step, publishedStep,
    kind: runKind({ unknown, step, publishedStep, changed: changedBy !== 'neither' }),
    lengthKm: samples.reduce((a, s) => a + (s.weightKm ?? SEAM_SPACING_KM), 0),
    from: first.point, to: last.point,
    midpoint: samples[Math.floor(samples.length / 2)].point,
    /* THE RUN'S OWN STRETCH OF LINE, with every vertex of the border between
       its ends — not the `from`→`to` chord. A jurisdiction line is not
       straight (the Missouri carries the SD/NE border for 200 km), and the map
       draws a new seam with a 5 px white casing under it: on a chord that
       casing lies in the wrong state. Extended half a sample's share past each
       end so consecutive runs meet rather than leaving a 2 km gap at every
       class change. */
    geometry: line ? sliceString(line.coordinates[first.string], first, last) : null,
    changedBy,
    samples: samples.length,
  });
}

/**
 * The stretch of one line string between two samples, vertices and all.
 *
 * Walks the string once, accumulating segment lengths, and interpolates the
 * two ends planar-wise inside whichever segment they fall in — the same
 * arithmetic `sampleSeam` used to place them, so the ends land back exactly
 * where the samples were taken.
 */
function sliceString(string, first, last) {
  if (!string) return null;
  const turf = T();
  const half = (first.weightKm ?? SEAM_SPACING_KM) / 2;
  const from = Math.max(0, first.at - half);
  const to = last.at + half;
  const out = [];
  let acc = 0;
  for (let i = 0; i < string.length - 1; i++) {
    const a = string[i], b = string[i + 1];
    const segKm = turf.distance(a, b, { units: 'kilometers' });
    if (!(segKm > 0)) continue;
    const end = acc + segKm;
    if (end >= from && acc <= to) {
      if (!out.length) out.push(at(a, b, segKm, Math.max(0, from - acc)));
      if (end <= to) out.push(b);
      else { out.push(at(a, b, segKm, to - acc)); break; }
    }
    acc = end;
  }
  if (out.length < 2) out.push(last.point);
  return { type: 'LineString', coordinates: out };
}

function at(a, b, segKm, km) {
  const t = Math.max(0, Math.min(1, km / segKm));
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function runKind({ unknown, step, publishedStep, changed }) {
  /* `'unknown'` is this module's own sixth kind, for the far side the
     published week could not be read for (docs/contracts.md § 6 says the seam
     is still emitted). A reader switching on the five in § 5 is already in its
     "could not be loaded" branch by the time it reaches a run. */
  if (unknown) return 'unknown';
  if (step === 0 && changed) return 'agree';
  if (step === publishedStep) return 'pre-existing';
  if (publishedStep === 0) return 'new';
  return Math.abs(step) > Math.abs(publishedStep) ? 'widened' : 'narrowed';
}

/** The run kinds a seam is REPORTED for. `agree` and `pre-existing` are kept
 *  in `runs` and excluded from findings: neither is a disjuncture this week's
 *  proposals created. */
const REPORTABLE = new Set(['new', 'widened', 'narrowed']);

/* ── one seam ─────────────────────────────────────────────────────────────── */

/**
 * One line, two sides → a Seam, or null when the two sides line up.
 *
 * `provider` is accepted and unused: resolving the published far side is
 * asynchronous and this function is not, so `findSeams` does that and hands
 * the resolved side in. Keeping the parameter means the signature in
 * docs/contracts.md § 5 still describes the call.
 */
export function analyseSeam(sideA, sideB, line, { provider = null, index = 0 } = {}) {
  void provider;
  const turf = T();
  const samples = sampleSeam(line, sideA, sideB);
  const runs = seamRuns(samples, { line });
  const reportable = runs.filter((r) => REPORTABLE.has(r.kind));
  const unknownRuns = runs.filter((r) => r.kind === 'unknown' && r.changedBy !== 'neither');
  /* NOTHING NEW AT THE LINE IS NOT A SEAM. Two authors who both left the
     border alone, or who moved it the same way on both sides, have produced no
     disjuncture — and an unloaded neighbour is not by itself one either. */
  if (!reportable.length && !unknownRuns.length) return null;

  const lengthKm = turf.length(asLineFeature(line), { units: 'kilometers' });
  const newStepKm = runs.filter((r) => r.kind === 'new').reduce((a, r) => a + r.lengthKm, 0);
  const maxStep = reportable.reduce((m, r) => Math.max(m, Math.abs(r.step ?? 0)), 0);
  const longest = [...(reportable.length ? reportable : unknownRuns)]
    .sort((a, b) => b.lengthKm - a.lengthKm)[0] ?? runs[0];

  const seam = {
    kind: 'seam',
    sideA, sideB,
    neighbourId: sideB.aoi?.id ?? null,
    runs: Object.freeze(runs),
    lengthKm,
    newStepKm,
    maxStep,
    /* RECIPROCAL means both sides carry a PROPOSAL (docs/contracts.md § 5) —
       not that both sides changed something. A reciprocal seam where only one
       side moved is still the more useful card, because there is somebody to
       address on the other side of it. `runs[].changedBy` is where "who
       actually moved" is recorded. */
    reciprocal: sideA.kind === 'proposal' && sideB.kind === 'proposal',
    isNew: runs.some((r) => r.kind === 'new'),
    edgeEffects: Object.freeze(matchingEdgeEffects(sideA, sideB)),
    borderNotes: Object.freeze({
      A: noteFor(sideA, sideB),
      B: noteFor(sideB, sideA),
    }),
    anchor: longest?.midpoint ?? null,
    aoiIds: Object.freeze([sideA.aoi?.id ?? null, sideB.aoi?.id ?? null]),
    /* THE LINE ITSELF, so the map draws the seam rather than a box around it:
       `sharedLine`'s result where both sides are loaded, the loaded side's
       `edgeEffects[].segments` where the neighbour is not. `line` is kept as
       an alias because this module's own functions read it under that name. */
    geometry: line,
    line,
    indeterminate: samples.filter((s) => s.indeterminate).length,
    samples: samples.length,
  };
  return Object.freeze(stampSeam(seam, index));
}

/**
 * The seam's readable key and its id — docs/contracts.md § 8.
 *
 * `<n>` is the seam's index among that pair's seams IN RANK ORDER, so it is
 * stamped after ranking rather than when the seam is built; a pair that
 * produces one seam (which is all of them on this corpus) gets 0 either way.
 */
export function stampSeam(seam, index) {
  const [aoiLo, aoiHi] = [seam.aoiIds[0] ?? 'unk', seam.aoiIds[1] ?? 'unk'].slice().sort();
  const [propLo, propHi] = [sideToken(seam.sideA), sideToken(seam.sideB)].slice().sort();
  const key = `seam|${aoiLo}|${aoiHi}|${propLo}|${propHi}|${index}`;
  return Object.freeze({ ...seam, key, id: findingId('seam', key) });
}

function sideToken(side) {
  if (side.kind === 'proposal') return side.proposal.shortId;
  return side.kind === 'published' ? 'pub' : 'unk';
}

function matchingEdgeEffects(sideA, sideB) {
  const out = [];
  for (const [here, there] of [[sideA, sideB], [sideB, sideA]]) {
    if (here.kind !== 'proposal') continue;
    for (const e of here.proposal.edgeEffects) {
      if ((e.neighborIds ?? []).includes(there.aoi?.id)) {
        out.push({ ...e, proposalId: here.proposal.id, side: here === sideA ? 'A' : 'B' });
      }
    }
  }
  return out;
}

function noteFor(here, there) {
  if (here.kind !== 'proposal') return null;
  const note = here.proposal.justification?.borderNotes?.[there.aoi?.id];
  return typeof note === 'string' && note.trim() ? note : null;
}

function asLineFeature(geometry) {
  return { type: 'Feature', properties: {}, geometry };
}

/**
 * Rank, and the last term makes the order total.
 *
 * A RECIPROCAL SEAM WHERE THE TWO SIDES STILL DISAGREE comes first: both
 * authors looked at this border, both said something, and they do not line up
 * — there is a conversation to have and two people to have it with. Then the
 * size of the step in classes, then how much of the line is newly stepped.
 */
export function rankSeams(seams) {
  const tier = (s) => (s.reciprocal && s.runs.some((r) => r.changedBy === 'both' && REPORTABLE.has(r.kind)) ? 0 : 1);
  return [...seams].sort((x, y) =>
    tier(x) - tier(y)
    || y.maxStep - x.maxStep
    || y.newStepKm - x.newStepKm
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/* ── the whole session ────────────────────────────────────────────────────── */

/**
 * Every seam in a session.
 *
 * Candidates come from two places, and both are needed: `neighbors.json`
 * (fetched at boot by js/app.js, `optional` — losing it costs neighbour
 * enumeration, not the app) names who is next to whom, and every loaded
 * proposal's `edgeEffects[].neighborIds` names a jurisdiction the AUTHOR
 * already said something to, which is a candidate whether or not the index
 * loaded.
 *
 *   · BOTH SIDES LOADED → one analysis per proposal pair across the line, over
 *     `sharedLine`. Three Montana proposals against two North Dakota ones is
 *     six analyses of one line, and the corridor-clipped side indexes are
 *     cached across them.
 *   · NEIGHBOUR NOT LOADED → the line is the loaded side's own
 *     `edgeEffects[].segments` toward that neighbour. Nothing at the line
 *     without an edge effect means no seam, which is the rule that keeps every
 *     state in the union from producing a candidate. The far side is the
 *     published week through the provider, or `unknown` when there is none.
 *
 * `aiannh:` neighbours are handled identically; a cross-kind seam exists only
 * where the tribal ring is also a state line, which is exactly what
 * `neighbors.json`'s `cross` records.
 *
 * @param {object} session  a Session (js/session.js)
 * @param {object} [opts]
 * @param {object} [opts.provider]   from js/published.js; null → far sides are
 *                 `published` only where a proposal supplies them, else unknown
 * @param {object} [opts.neighbors]  the parsed vendor/aoi/neighbors.json
 * @returns {Promise<object[]>} ranked Seams
 */
export async function findSeams(session, { provider = null, neighbors = null } = {}) {
  const proposals = session.list();
  if (!proposals.length) return [];
  const week = session.week();
  const byAoi = session.byAOI();
  const aoiOf = new Map();
  for (const p of proposals) if (!aoiOf.has(p.aoi.id)) aoiOf.set(p.aoi.id, p.aoi);

  const sideCache = new Map();
  const sideFor = (proposal, corridor, corridorKey) => {
    const k = `${proposal.id}|${corridorKey}`;
    if (!sideCache.has(k)) sideCache.set(k, proposalSide(proposal, corridor));
    return sideCache.get(k);
  };

  const seams = [];

  /* ── both sides loaded ─────────────────────────────────────────────────── */
  const ids = [...aoiOf.keys()].sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const aoiA = aoiOf.get(ids[i]), aoiB = aoiOf.get(ids[j]);
      if (!adjacent(ids[i], ids[j], neighbors, byAoi)) continue;
      const line = sharedLine(aoiA, aoiB);
      if (!line) continue;
      const corridor = corridorOf(line);
      const corridorKey = corridor.map((n) => n.toFixed(2)).join(',');
      for (const a of byAoi.get(ids[i]) ?? []) {
        for (const b of byAoi.get(ids[j]) ?? []) {
          const seam = analyseSeam(
            sideFor(a, corridor, corridorKey), sideFor(b, corridor, corridorKey), line);
          if (seam) seams.push(seam);
        }
      }
    }
  }

  /* ── a neighbour nobody loaded ─────────────────────────────────────────── */
  for (const p of proposals) {
    const byNeighbour = new Map();
    for (const e of p.edgeEffects) {
      for (const id of e.neighborIds ?? []) {
        if (aoiOf.has(id)) continue;                     // handled above
        if (!byNeighbour.has(id)) {
          byNeighbour.set(id, { id, name: e.neighborNames?.[0] ?? id, strings: [] });
        }
        const g = e.segments;
        if (g?.type === 'MultiLineString') byNeighbour.get(id).strings.push(...g.coordinates);
        else if (g?.type === 'LineString') byNeighbour.get(id).strings.push(g.coordinates);
      }
    }
    for (const { id, name, strings } of byNeighbour.values()) {
      if (!strings.length) continue;
      const line = { type: 'MultiLineString', coordinates: strings };
      const corridor = corridorOf(line);
      const corridorKey = corridor.map((n) => n.toFixed(2)).join(',');
      const aoi = { kind: id.split(':')[0], id, name, geometry: null, bbox: corridor };
      let far = unknownSide(aoi);
      if (provider) {
        try {
          far = publishedSide(aoi, await provider.bandsNear(week, corridor), corridor);
        } catch {
          /* A rejection is never fatal (docs/contracts.md § 6): the seam is
             emitted with the side marked unknown and js/app.js says so once. */
          far = unknownSide(aoi);
        }
      }
      const seam = analyseSeam(sideFor(p, corridor, corridorKey), far, line);
      if (seam) seams.push(seam);
    }
  }

  /* Rank, THEN stamp: `<n>` in a seam key is the index among that pair's seams
     in rank order, so the two steps cannot be swapped. */
  const ranked = rankSeams(seams);
  const seen = new Map();
  return ranked.map((s) => {
    const pairKey = [s.aoiIds[0] ?? 'unk', s.aoiIds[1] ?? 'unk'].slice().sort().join('|')
      + '|' + [sideToken(s.sideA), sideToken(s.sideB)].slice().sort().join('|');
    const n = seen.get(pairKey) ?? 0;
    seen.set(pairKey, n + 1);
    return n === 0 ? s : stampSeam(s, n);
  });
}

/**
 * Are these two working areas next to each other?
 *
 * `neighbors.json` when it loaded, and an author's own `edgeEffects` when it
 * did not — an author who wrote a sentence to North Dakota has said the two
 * are adjacent more directly than an index can. With neither, every pair is a
 * candidate and `sharedLine` decides, which costs a few milliseconds per pair
 * and never misses one.
 */
function adjacent(idA, idB, neighbors, byAoi) {
  if (neighbors) {
    const [kindA, keyA] = splitId(idA);
    const listed = neighbors[kindA]?.[keyA] ?? null;
    if (listed) {
      const [kindB, keyB] = splitId(idB);
      if (kindA === kindB && listed.includes(keyB)) return true;
    }
    if ((neighbors.cross?.[idA] ?? []).includes(idB)) return true;
    if ((neighbors.cross?.[idB] ?? []).includes(idA)) return true;
  }
  for (const [id, other] of [[idA, idB], [idB, idA]]) {
    for (const p of byAoi.get(id) ?? []) {
      for (const e of p.edgeEffects) if ((e.neighborIds ?? []).includes(other)) return true;
    }
  }
  return !neighbors;
}

function splitId(id) {
  const cut = String(id).indexOf(':');
  return cut < 0 ? [id, id] : [id.slice(0, cut), id.slice(cut + 1)];
}
