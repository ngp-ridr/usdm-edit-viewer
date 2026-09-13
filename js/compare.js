/* ══ USDM Edit Viewer · js/compare.js ═════════════════════════════════════════
   Where two proposals answer the same ground differently — as exact polygons,
   ranked, with ids that survive a reload.

   DOM-free (docs/contracts.md § 4; tools/compare.test.mjs § 0 greps for it).
   Imports js/proposal.js and the vendored topology; never dom.js, never the
   network.

   ── THE ARITHMETIC ────────────────────────────────────────────────────────
   Three partitions of the same ground into the six states a place can be in
   (none = −1, D0 = 0 … D4 = 4): A's result, B's result, and the published week
   both were drawn against. For every ordered pair of levels i ≠ j, the ground
   where A says `i` and B says `j` is `A_i ∩ B_j`, and those pieces are DISJOINT
   BY CONSTRUCTION — a partition's levels do not overlap — so no ground is
   counted twice and no union is needed to add them up. Each piece is then cut
   by the published level under it, which is the third fact a reviewer needs:
   not just that the two disagree, but which of them moved.

     p ∉ {a, b}   → CONFLICT: both moved this ground, and to different places
     b === p      → ONE-SIDED, changed by A: B left it as published
     a === p      → ONE-SIDED, changed by B

   EXACT POLYGONS, never a sampled grid — js/delta.js's argument, unchanged:
   the pieces are ribbons thinner than any fast grid, the output is zoomed to,
   the areas are quoted in a brief somebody argues from, and both sides are
   already exact bands so it costs nothing extra. (The ONE place this app
   samples is a border LINE, where there is no area to intersect at all; the
   justification is in js/seams.js.)

   ── COSTS, and why the pruning is not optional ─────────────────────────────
   Measured with the vendored turf under Node over the twelve demo packages: a
   full within-state pair is 30 level-pair intersections plus the published
   labelling, 230–700 ms, on top of the partitions each proposal builds once
   and memoizes (388 ms for all twelve result partitions, 382 ms for the
   published ones). Nine within-AOI pairs over the demo set is ~4 s, which is
   why js/app.js ticks between AOIs rather than holding the main thread for the
   whole sweep, and why every intersect here is bbox-pruned on BOTH sides
   before the clipper sees a coordinate: a naked `turf.intersect` of two
   state-sized levels is 171–1,758 ms on its own (CLAUDE.md).
   ========================================================================== */

import {
  T, asMulti, asFeature, indexParts, envelopeOf, bboxOverlaps, ringBBox,
  despike, areaKm2,
} from '../vendor/usdm-editor/js/topology.js';
import { MIN_PATCH_AREA_M2 } from '../vendor/usdm-editor/js/changes.js';
import {
  LEVELS, ord, clipPartition, patchesTouching, findingId, bboxKey,
} from './proposal.js';

/**
 * Below this a piece is clipper residue, not a disagreement.
 *
 * The SAME floor the editor applies to a patch, imported rather than restated:
 * a needle the editor refuses to demand a rationale for is a needle this app
 * must not open a discussion brief about. 0.01 km²; the measurements behind
 * the number are at `MIN_PATCH_AREA_M2` in the vendored js/changes.js.
 */
export const MIN_REGION_AREA_M2 = MIN_PATCH_AREA_M2;

/* ── one pair ─────────────────────────────────────────────────────────────── */

/**
 * Compare two proposals over the ground they share.
 *
 * @param {object} A  a Proposal — the earlier-loaded one, by convention
 * @param {object} B  a Proposal
 * @param {object} [opts]
 * @param {object} [opts.ground]  MultiPolygon the pair shares; defaults to A's
 *        working area, which is the whole of it when both name the same one
 * @param {number} [opts.minAreaM2]
 * @returns {{pair: string[], ground: object|null, regions: object[],
 *            totals: object, sameAuthor: boolean, ms: number}}
 */
export function compareProposals(A, B, { ground = null, minAreaM2 = MIN_REGION_AREA_M2 } = {}) {
  const t0 = now();
  const sameAoi = A.aoi.id === B.aoi.id && A.aoi.id != null;
  const groundGeometry = ground ?? (sameAoi ? A.aoi.geometry : null);

  /* THE GROUND NEEDS NO CLIP, and that is worth saying because it looks like
     an omission. Every piece below is `A_level ∩ B_level`; A's levels lie
     inside A's working area and B's inside B's, so the intersection is inside
     both by construction — which IS the shared ground. The `ground` argument
     is therefore only ever a bbox PRUNE (cheap, and it keeps a cross-AOI pair
     from handing the clipper a whole state it cannot reach) plus a fact to
     report; it can never remove an answer. */
  const groundParts = groundGeometry && !sameAoi ? indexParts(groundGeometry) : null;
  const PA = groundParts ? clipPartition(A.partition, groundParts) : A.partition;
  const PB = groundParts ? clipPartition(B.partition, groundParts) : B.partition;
  const PP = groundParts ? clipPartition(A.publishedPartition, groundParts) : A.publishedPartition;

  /* The two changed regions, indexed once. A piece that touches NEITHER is
     ground both proposals left alone and the two reconstructions of the
     published week still disagree about — baseline residue, reported as a
     total and never as a finding (docs/contracts.md § 4 step 3). */
  const changedA = indexParts(A.changedRegion);
  const changedB = indexParts(B.changedRegion);

  const totals = { conflictKm2: 0, oneSidedKm2: { A: 0, B: 0 }, publishedMismatchKm2: 0 };
  /* `${a}|${b}|${p}` → { a, b, p, sources[] }. One source per key in practice
     — a and b fix the level pair, p fixes the published level, so every part
     in a bucket came out of the same clipper call and is already dissolved.
     The list is kept because a bucket that ever collected two sources would
     otherwise report two halves of one region as two findings. */
  const buckets = new Map();

  for (let i = 0; i < LEVELS.length; i++) {
    if (!PA[i]) continue;
    for (let j = 0; j < LEVELS.length; j++) {
      if (i === j || !PB[j]) continue;
      const both = intersectLevels(PA[i], PB[j]);
      if (!both) continue;
      /* DESPIKE, every time. The archive's nested product draws each class's
         contour independently, so a boolean op over two of them that share
         thousands of vertices emits out-and-back zero-width needles along the
         shared edges — measured 31 km long with a bounding box twice the
         edit's, and nothing boolean removes them (the vendored `despike`'s
         header carries the whole measurement). A needle survives into a
         region's bbox, and the bbox is part of its id. */
      const cleaned = keepLargeParts(despike(both), minAreaM2);
      if (!cleaned) continue;
      const piece = prepareLevel(cleaned);
      if (!piece) continue;

      for (let k = 0; k < LEVELS.length; k++) {
        if (!PP[k]) continue;
        const labelled = keepLargeParts(intersectLevels(piece, PP[k]), minAreaM2);
        if (!labelled) continue;
        const key = `${LEVELS[i]}|${LEVELS[j]}|${LEVELS[k]}`;
        if (!buckets.has(key)) {
          buckets.set(key, { a: LEVELS[i], b: LEVELS[j], p: LEVELS[k], sources: [] });
        }
        buckets.get(key).sources.push(labelled);
      }
    }
  }

  const regions = [];
  for (const { a, b, p, sources } of buckets.values()) {
    const dissolved = dissolve(sources);
    if (!dissolved) continue;
    for (const rings of dissolved.coordinates) {
      const geometry = { type: 'MultiPolygon', coordinates: [rings] };
      const bbox = ringBBox(rings);
      const km2 = areaKm2(geometry);
      if (km2 * 1e6 < minAreaM2) continue;

      if (!touches(geometry, bbox, changedA) && !touches(geometry, bbox, changedB)) {
        totals.publishedMismatchKm2 += km2;
        continue;
      }

      const kind = (p !== a && p !== b) ? 'conflict' : 'one-sided';
      const changedBy = kind === 'conflict' ? 'both' : (b === p ? 'A' : 'B');
      if (kind === 'conflict') totals.conflictKm2 += km2;
      else totals.oneSidedKm2[changedBy] += km2;

      regions.push(makeRegion({
        A, B, a, b, p, kind, changedBy, geometry, bbox, km2,
        aoiId: sameAoi ? A.aoi.id : crossAoiId(A, B),
      }));
    }
  }

  return Object.freeze({
    pair: Object.freeze([A.id, B.id]),
    /* THE TWO PROPOSALS THEMSELVES, beside their ids. A brief needs both
       authors, both justifications and every touching rationale, and threading
       a lookup table through `ctx.brief` → `export.js` → `brief.js` is the kind
       of plumbing that arrives holding the wrong end. `pair` stays the ids,
       because that is what the map sources and the URL carry. */
    A, B,
    ground: groundGeometry,
    regions: Object.freeze(rankRegions(regions)),
    totals: Object.freeze(totals),
    /* Two files by the same person are two DRAFTS, not two opinions, and the
       brief's questions switch on it (js/brief.js). Recorded here because this
       is where the pair is formed. */
    sameAuthor: sameAuthorAs(A, B),
    ms: Math.round(now() - t0),
  });
}

/**
 * Every C(n,2) pair of a group, in load order.
 *
 * `crossAoi` skips the pairs whose two proposals name the SAME working area.
 * A cross-AOI group (a tribal area lying inside a state) carries both sets of
 * proposals, and each set already has a group of its own over the whole of its
 * own working area; comparing a pair twice — once properly and once over the
 * sliver they share — mints a second set of findings, with second ids and
 * second briefs, for one disagreement.
 */
export function compareGroup(proposals, {
  ground = null, minAreaM2 = MIN_REGION_AREA_M2, crossAoi = false,
} = {}) {
  return groupPairs(proposals, { crossAoi })
    .map(([A, B]) => compareProposals(A, B, { ground, minAreaM2 }));
}

/**
 * The pairs `compareGroup` would compare, in load order, WITHOUT comparing them.
 *
 * THE SKIP RULE HAS ONE COPY and this is it — `compareGroup` reads the same
 * list. It exists because a pair costs 230–700 ms of synchronous clipper work
 * and js/app.js has to yield to the browser BETWEEN pairs, not between groups:
 * a group of five proposals is ten pairs and held the main thread for seconds
 * at a time, which is a map that ignores clicks while it works. The caller
 * walks these and calls `compareProposals` itself with a tick in between; the
 * alternative — an async `onPair` hook in here — would make this module's one
 * synchronous, DOM-free, Node-testable entry point a promise.
 */
export function groupPairs(proposals, { crossAoi = false } = {}) {
  const out = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      if (crossAoi && proposals[i].aoi.id === proposals[j].aoi.id) continue;
      out.push([proposals[i], proposals[j]]);
    }
  }
  return out;
}

/**
 * The `aoiId` a cross-AOI region carries: the two ids, SORTED and joined with
 * `×`. Sorted for the same reason the class pair is — argument order must not
 * reach the id — and `×` because an AOI id already contains a colon
 * (docs/contracts.md § 16 decision 1) and a second separator that was also a
 * colon could not be read back out.
 */
function crossAoiId(A, B) {
  return [A.aoi.id, B.aoi.id].sort().join('×');
}

/* ── one region ───────────────────────────────────────────────────────────── */

function makeRegion({ A, B, a, b, p, kind, changedBy, geometry, bbox, km2, aoiId }) {
  /* THE KEY NAMES THE PAIR, and it SORTS both of its asymmetric halves.
     Sorting is what makes `compareProposals(A, B)` and `compareProposals(B, A)`
     mint the same id — everything else in the string is symmetric already (the
     kind, the ground, the published level) — and it is the same property that
     makes the id survive a different LOAD ORDER, since load order is only ever
     which proposal arrives as A.

     THE PAIR IS IN THE KEY BECAUSE WITHOUT IT AN ID IS NOT AN IDENTITY. Three
     proposals over one working area answer a great deal of ground the same way
     as each other, so `(kind, aoi, classes, published, bbox)` names a polygon
     that two or three different PAIRS each produce: one id for three findings,
     three briefs behind one `?focus=` link, and a session left to break the tie
     by rank — which is not stable across load order, the one property `?focus=`
     exists for. With the two `shortId`s in the string the three are three ids
     and nothing downstream has to suffix anything (docs/contracts.md § 8). */
  const [lo, hi] = [a, b].slice().sort();
  const [propLo, propHi] = [A.shortId, B.shortId].slice().sort();
  const key = `disc|${kind}|${aoiId}|${propLo}|${propHi}|${lo}|${hi}|${p}|${bboxKey(bbox)}`;
  return Object.freeze({
    id: findingId('disc', key),
    key,
    kind,
    changedBy,
    proposalA: A.id,
    proposalB: B.id,
    classA: a,
    classB: b,
    published: p,
    magnitude: Math.abs(ord(a) - ord(b)),
    directionA: directionOf(a, p),
    directionB: directionOf(b, p),
    geometry,
    bbox,
    areaKm2: km2,
    /* An INTERIOR point, never a centroid: a USDM region is wildly concave and
       its centroid is often outside it altogether (CLAUDE.md).
       `pointOnFeature` is the fleet's answer and is what the editor anchors a
       patch with. */
    anchor: anchorOf(geometry),
    patchesA: Object.freeze(patchesTouching(A, geometry, bbox).map((x) => x.key)),
    patchesB: Object.freeze(patchesTouching(B, geometry, bbox).map((x) => x.key)),
    aoiId,
  });
}

/** Which way this side moved the drought, against the published week. */
function directionOf(level, published) {
  const d = ord(level) - ord(published);
  return d > 0 ? 'grew' : d < 0 ? 'shrank' : 'unchanged';
}

function anchorOf(geometry) {
  const [lng, lat] = T().pointOnFeature(asFeature(geometry)).geometry.coordinates;
  return [lng, lat];
}

/**
 * Rank, and the last term is what makes the order TOTAL.
 *
 * Conflicts first, always — a conflict is what a reconciliation meeting exists
 * to settle, and a one-sided difference is usually two people working
 * different parts of a state. Then the size of the disagreement in classes,
 * then in ground, and finally the id, so two runs over the same input produce
 * the same list and `<n>` in a seam key means something.
 */
export function rankRegions(regions) {
  return [...regions].sort((x, y) =>
    (x.kind === y.kind ? 0 : x.kind === 'conflict' ? -1 : 1)
    || y.magnitude - x.magnitude
    || y.areaKm2 - x.areaKm2
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/* ── the pruned boolean ops ───────────────────────────────────────────────── */

/**
 * `level_a ∩ level_b`, with the clipper handed only the parts that can
 * possibly contribute.
 *
 * A copy of the vendored `js/delta.js`'s `intersectLevels` — a copy rather
 * than an import because that function is not exported and the vendored tree
 * is byte-identical BY RULE (CLAUDE.md): this app must not edit the copy to
 * add an export, and a wrapper cannot reach a module-private function. The
 * argument is the editor's, unchanged: neither operand is privileged here — a
 * 40-part `none` band meets a 12-part D1 band and both sides have parts the
 * other cannot reach — so each is pruned by the other. A part whose bounding
 * box misses every box on the far side cannot intersect anything over there,
 * so dropping it removes no area from the answer.
 */
function intersectLevels(a, b) {
  if (!a || !b) return null;
  if (!bboxOverlaps(a.bbox, b.bbox)) return null;
  const nearA = a.parts.filter((p) => b.parts.some((q) => bboxOverlaps(p.bbox, q.bbox)));
  if (!nearA.length) return null;
  const nearB = b.parts.filter((q) => nearA.some((p) => bboxOverlaps(p.bbox, q.bbox)));
  if (!nearB.length) return null;
  const turf = T();
  return asMulti(turf.intersect(turf.featureCollection([
    asFeature({ type: 'MultiPolygon', coordinates: nearA.map((p) => p.rings) }),
    asFeature({ type: 'MultiPolygon', coordinates: nearB.map((p) => p.rings) }),
  ])));
}

/** A MultiPolygon, indexed for `intersectLevels`. */
function prepareLevel(geometry) {
  const m = asMulti(geometry);
  if (!m) return null;
  const parts = indexParts(m);
  const bbox = envelopeOf(parts);
  return bbox ? { level: null, parts, bbox } : null;
}

/** Drop parts under the floor. One `turf.area` per part — no boolean op. */
function keepLargeParts(geometry, minAreaM2) {
  const m = asMulti(geometry);
  if (!m) return null;
  const turf = T();
  const kept = m.coordinates.filter((rings) => turf.area({
    type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings },
  }) >= minAreaM2);
  return kept.length ? { type: 'MultiPolygon', coordinates: kept } : null;
}

/**
 * One label's pieces → its connected components.
 *
 * A bucket almost always holds ONE clipper result, whose parts are already
 * dissolved and already disjoint — so the common path is the geometry as it
 * stands and not a boolean op, which is the difference between a sub-second
 * pair and a slow one. The union is kept for the case a bucket ever collects
 * two sources: the alternative is reporting two halves of one region as two
 * findings, with two ids and two briefs.
 */
function dissolve(sources) {
  if (!sources.length) return null;
  if (sources.length === 1) return asMulti(sources[0]);
  const turf = T();
  return asMulti(turf.union(turf.featureCollection(sources.map((s) => asFeature(s)))));
}

/** Does this piece touch an indexed region at all? bbox scan, then one boolean. */
function touches(geometry, bbox, parts) {
  if (!parts.length) return false;
  const near = parts.filter((p) => bboxOverlaps(p.bbox, bbox));
  if (!near.length) return false;
  return T().booleanIntersects(asFeature(geometry),
    asFeature({ type: 'MultiPolygon', coordinates: near.map((p) => p.rings) }));
}

/** Two files by one person. Email first — a name is not an identity. */
function sameAuthorAs(A, B) {
  const a = A.author ?? {}, b = B.author ?? {};
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return !!(a.name && b.name && a.name === b.name);
}

/* `performance.now` is in Node and in every browser this app supports, and it
   is the clock the editor's budgets are quoted on; this is the number
   js/app.js reports as `__viewer.lastCompareMs`. */
function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
