/* ============================================================================
   USDM Editor · js/changes.js
   The change list: what an author changed, cut into the pieces a person would
   point at, and the rationale each piece carries.

   DOM-free, like js/topology.js, js/heuristic.js and js/changeset.js — it runs
   in the browser beside the editor and under Node in tools/topology.test.mjs,
   and it is part of the deferred server-side submission gate. No `window`, no
   `document`, no `fetch`. Turf comes from `globalThis.turf`.

   A CHANGE is one contiguous patch of ground where the proposal differs from
   the baseline — a place, not an edit. That falls out of construction:
   `mergedDiffRegion` unions the per-class diffs, so every part of the result
   is a connected component. A patch may span several classes (one boundary
   moved, one reason written), may carry holes, and two edits that meet become
   ONE patch — which is why annotations are MATCHED, never owned.

   The list is derived from scratch on every commit (incremental bookkeeping
   over boolean geometry drifts), so identity is re-established by the ANCHOR —
   one point inside the patch. Where the anchor lands decides the outcome:
   `merged` (two anchors, one patch: older survives, rationales concatenate
   oldest-first, `reviewed` is the AND), `new` (nobody's anchor; overlapping an
   anchored annotation's old ground makes it a SPLIT sibling, and a split
   resets `reviewed` on every child), `orphaned` (KEPT, never deleted — undo
   must never destroy prose, and redo re-anchors the same rationale with its
   original number), `reattached`.

   Annotations may be GROUPED — one rationale over several patches, because a
   week's rain falls on a watershed, not a connected component. One text
   stamped on every member (`setGroupRationale`), so nothing downstream needs
   to know groups exist. A group of one is not a group (integrity pass clears
   it), and a group whose texts drift — merging does this — is DISSOLVED, every
   text kept: there is no correct repair that does not discard or rewrite prose.

   `seq` numbers are minted once and never reused or renumbered: authors write
   "see Change 3" in prose. Gaps mean that change is gone.
   ============================================================================

   ── The two records ────────────────────────────────────────────────────────

     Patch      = { key, seq, geometry, bbox, anchor, areaKm2,
                    classes: [{ class, label, direction, category, phrase }] }

       geometry   one Polygon, possibly with interior rings
       bbox       [w, s, e, n] of its exterior ring
       anchor     [lng, lat] inside it — the identity token described above
       direction  'grew' | 'shrank' | 'reshaped'
       category   which of the six named kinds of change this is — 'new',
                  'cleared', 'split', 'merged', 'hole-opened', 'hole-closed',
                  'edge-advanced', 'edge-retreated' or 'edge-revised'. See
                  `categorize` and `categoryPhrase`, below `changeName`.

     Annotation = { key, seq, rationale, reviewed, groupId, anchor, bbox,
                    areaKm2, classes, status, createdAt, updatedAt, mergedFrom? }

       rationale  markdown, the author's words, '' until they write some
       groupId    null, or the id of the group whose single text this carries
       status     'attached' | 'orphaned'
       mergedFrom keys this annotation absorbed, kept as provenance

   The geometric fields on an Annotation are a COPY of its patch's, refreshed on
   every match. They are not a second source of truth — the patch is — they are
   what an orphan has left to be found by, and what `hydrate` restores from a
   saved session before any geometry has been computed.
   ========================================================================== */

import {
  T, CLASSES, asMulti, asFeature, indexParts, bboxOverlaps, intersectNear,
} from './topology.js';
import { normalizeAOI, perClassDiffs, mergedDiffRegion } from './changeset.js';
import { USDM_LABELS } from './color.js';
import { fmtMi } from './units.js';

/**
 * Area below which a part of the changed region is clipper residue rather than
 * something an author did.
 *
 * 0.01 km², the same bar § 10b of tools/topology.test.mjs uses to tell a real
 * interior ring from a hairline: a boolean clipper cutting along a shared
 * boundary and re-joining leaves 4-point needles up to ~3,900 m² — measured,
 * over six archive weeks — and a needle is not a change. This sits 2.6× above
 * the largest of those, which is the only end of the range that needs a margin;
 * the other end is a 100 m square, on a product whose inputs are gridded in
 * kilometres. Demanding a rationale for a needle nobody can see, and blocking
 * submission until one arrives, is the failure this prevents.
 *
 * Pass `minAreaM2: 0` to `derivePatches` to keep everything.
 */
export const MIN_PATCH_AREA_M2 = 10000;

/** How close a patch edge must run to the AOI boundary to count as ON it. */
const EDGE_TOLERANCE_KM = 0.05;

/** How far either side of a shared border a neighbour is looked for. */
const NEIGHBOR_BUFFER_KM = 0.5;

/** What each direction is called in a sentence. */
const DIRECTION_WORDS = Object.freeze({
  grew: 'an expansion',
  shrank: 'a reduction',
  reshaped: 'a revision',
});

/** The name an author refers to a change by. `seq` is never renumbered. */
export function changeName(seq) {
  return `Change ${seq}`;
}

/* ── naming the kind of change, per (patch, class) ────────────────────────── */

/**
 * The sentence fragment for one class's `category` under one patch — "a new
 * D3 area appeared", "D1's edge advanced" — as a function of the class code.
 * The one wording js/changes-panel.js and js/geojson.js both use, so a
 * category never reads two different ways depending on which screen or file
 * names it.
 */
const CATEGORY_PHRASE = Object.freeze({
  new: (c) => `a new ${c} area appeared`,
  cleared: (c) => `a ${c} area was cleared`,
  split: (c) => `a ${c} area split in two`,
  merged: (c) => `two ${c} areas merged`,
  'hole-opened': (c) => `a hole opened in ${c}`,
  'hole-closed': (c) => `a hole closed in ${c}`,
  'edge-advanced': (c) => `${c}'s edge advanced`,
  'edge-retreated': (c) => `${c}'s edge retreated`,
  'edge-revised': (c) => `${c}'s edge was revised`,
});

/** `categoryPhrase('new', 'D3')` → `'a new D3 area appeared'`. Falls back to a
 *  plain statement for a category this table does not know, which is only
 *  ever reached from a hand-edited or pre-this-change session file. */
export function categoryPhrase(category, cls) {
  const fn = CATEGORY_PHRASE[category];
  return fn ? fn(cls) : `${cls} changed`;
}

/**
 * How many of a class's contour parts have a bbox overlapping this patch's.
 * Bbox only — no boolean op. Split and merge are both "the count of nearby
 * parts moved", and a count is arithmetic on numbers `indexParts` already
 * computed; running `booleanIntersects` per part per class per patch would put
 * a turf call where a comparison suffices, inside a budget this function
 * shares with the rest of `derivePatches`.
 */
function partsNearBBox(patchBBox, parts) {
  let n = 0;
  for (const p of parts) if (bboxOverlaps(p.bbox, patchBBox)) n++;
  return n;
}

/** Interior rings among the parts whose bbox overlaps this patch's. Same bbox-
 *  only shape as `partsNearBBox`, one field over: `rings.length - 1` per part
 *  is free once `indexParts` has already split the rings out. */
function holesNearBBox(patchBBox, parts) {
  let n = 0;
  for (const p of parts) if (bboxOverlaps(p.bbox, patchBBox)) n += p.rings.length - 1;
  return n;
}

/**
 * Which of the six named kinds of change one class's move under one patch is.
 *
 * ── Priority, and why this order ───────────────────────────────────────────
 * More than one test below can be true of the same (patch, class) at once, and
 * the order picks the MORE SPECIFIC statement over the less specific one:
 * "the edge advanced" is true of nearly every changed patch — it is the
 * fallback everything else falls through to — and so is the least informative
 * thing this function could say. Two collisions are real rather than
 * hypothetical, and both are asserted in § 20 of tools/topology.test.mjs:
 *
 *   · A class that goes from NOTHING to SOMETHING (or the reverse) also reads,
 *     by raw part count, as the count rising from 0 to 1 (or falling from 1 to
 *     0) — which is exactly what "split" and "merged" test for. Checking
 *     cleared/new-island FIRST is what keeps a brand-new island from being
 *     reported as a split of a part that never existed, and a fully-cleared
 *     area from being reported as a merge into nothing.
 *   · A part that gains or loses a hole leaves its OWN part count unchanged —
 *     the shape is still one part — so hole and split/merge never collide on
 *     the same part by construction. Split/merge is still checked first
 *     because it is a fact about the PATCH's shape (how many pieces of ground
 *     are here), which a reviewer reaches for before "this piece grew a hole".
 *
 * Every count is a BBOX scan (`partsNearBBox` / `holesNearBBox`), and the
 * cleared/new-island test is the one `touchesAny` this file already runs
 * `grew`/`shrank` through — so classifying a class's move costs one further
 * `touchesAny` call per class per patch, not a second geometry pass. Measured
 * on a real week in § 20e: comfortably inside the 500 ms `derivePatches`
 * already shares with `deriveChangeMap` (§§ 11g, 15g).
 *
 *   1. cleared / new-island
 *   2. split / merged
 *   3. hole opened / closed
 *   4. edge advanced / retreated / revised — the fallback, and ~85% of real
 *      changed ground by area. That figure is ONE measurement, not a survey:
 *      2026-08-04 → 2026-08-11 over Montana, splitting each class's weekly
 *      change into pieces and asking of each whether it touched the baseline
 *      contour. Worth re-running over more weeks before anything leans harder
 *      on it than "the fallback is the common case".
 */
function categorize({ grew, shrank, direction, feature, bbox, baselineParts, workingParts }) {
  if (grew && !touchesAny(feature, bbox, baselineParts)) return 'new';
  if (shrank && !touchesAny(feature, bbox, workingParts)) return 'cleared';

  const partsBefore = partsNearBBox(bbox, baselineParts);
  const partsAfter = partsNearBBox(bbox, workingParts);
  if (partsAfter > partsBefore) return 'split';
  if (partsAfter < partsBefore) return 'merged';

  const holesBefore = holesNearBBox(bbox, baselineParts);
  const holesAfter = holesNearBBox(bbox, workingParts);
  if (holesAfter > holesBefore) return 'hole-opened';
  if (holesAfter < holesBefore) return 'hole-closed';

  if (direction === 'reshaped') return 'edge-revised';
  return direction === 'grew' ? 'edge-advanced' : 'edge-retreated';
}

/* ── deriving the patches ─────────────────────────────────────────────────── */

/**
 * Split the changed region into patches, and tag each with the classes that
 * moved under it and which way.
 *
 * @param {object} opts
 * @param {object} opts.baseline  {D0..D4} contours as the archive published them
 * @param {object} opts.working   {D0..D4} contours as the author has them
 * @param {object|number[]} [opts.aoi]  the working area — anything `normalizeAOI`
 *                 takes. Null means "do not clip", which is only ever right for
 *                 geometry that was never clipped in the first place.
 * @param {number} [opts.minAreaM2]  see MIN_PATCH_AREA_M2
 * @returns {{patches: object[], region: object|null}} patches WITHOUT `key` or
 *          `seq` — those come from `matchPatches` — and the merged region,
 *          which is exactly what `changedExtentRegion` returns for the same
 *          arguments, computed here from the same diffs rather than twice.
 */
export function derivePatches({ baseline, working, aoi = null, minAreaM2 = MIN_PATCH_AREA_M2, diffs = null } = {}) {
  const turf = T();
  /* `diffs` may be handed in — the changeset memoizes `perClassDiffs` per
     version (js/changeset.js `diffs`) and `deriveThreads` starts from the same
     ten pieces, so a commit computes them once instead of twice. Same inputs,
     same output; the tests pin the equivalence. */
  diffs = diffs ?? perClassDiffs(baseline, working, aoi);
  const region = mergedDiffRegion(diffs);
  if (!region) return { patches: [], region: null };

  /* Index each class's two diffs once. Every class test below is then a bbox
     scan over a handful of parts before any boolean op runs — the same shape as
     js/heuristic.js's hit tester, and for the same reason: the alternative is a
     full `booleanIntersects` against a whole class per patch per class. */
  const moved = CLASSES.map((c) => ({
    usdmClass: c,
    added: indexParts(diffs[c]?.added),
    removed: indexParts(diffs[c]?.removed),
    /* The class's FULL contour, before and after — not the diff. `categorize`
       asks "does this patch touch any baseline/working ground of this class at
       all" and "how many parts/holes of it sit near this patch", and both
       questions are about the whole class, not about what moved. Indexed once
       per class here rather than once per patch: derivePatches already pays
       this cost per class, never per patch. */
    baseline: indexParts(baseline?.[c]),
    working: indexParts(working?.[c]),
  }));

  const patches = [];
  for (const part of indexParts(region)) {
    const geometry = { type: 'Polygon', coordinates: part.rings };
    const feature = asFeature(geometry);
    const km2 = turf.area(feature) / 1e6;
    if (km2 * 1e6 < minAreaM2) continue;

    const classes = [];
    for (const m of moved) {
      const grew = touchesAny(feature, part.bbox, m.added);
      const shrank = touchesAny(feature, part.bbox, m.removed);
      if (!grew && !shrank) continue;
      const direction = grew && shrank ? 'reshaped' : (grew ? 'grew' : 'shrank');
      const category = categorize({
        grew, shrank, direction, feature, bbox: part.bbox,
        baselineParts: m.baseline, workingParts: m.working,
      });
      classes.push({
        class: m.usdmClass,
        label: USDM_LABELS[m.usdmClass],
        direction,
        category,
        /* THE PHRASE TRAVELS WITH THE CATEGORY, and that is what keeps
           js/geojson.js a pure projection. It needs this sentence, but its
           charter is to reshape what the package already computed and never to
           compute — and importing `categoryPhrase` from here would have pulled
           the whole rules engine (changes → changeset → topology) into a module
           whose entire claim is that it runs with no globals and looks inside no
           ring. Stamping the string is one field; the alternative was either a
           second copy of the table, which drifts, or a second dependency, which
           is the one this module is documented not to have. */
        phrase: categoryPhrase(category, m.usdmClass),
      });
    }

    patches.push({ geometry, bbox: part.bbox, anchor: anchorOf(feature), areaKm2: km2, classes });
  }

  /* `region` is returned WHOLE, needles included. It is the region the national
     gate scopes to and the region the §3b heuristic samples, and narrowing
     either of those to "the parts worth annotating" would be answering a
     different question with the same variable. */
  return { patches, region };
}

/**
 * A point inside a patch, to carry its identity across recomputations.
 *
 * `turf.pointOnFeature` is guaranteed to land ON the feature but NOT strictly
 * inside it: where the centroid falls outside a concave ring it returns the
 * ring vertex nearest the centroid, which is a point on the boundary. CLAUDE.md
 * records what that costs elsewhere in this app — a synthetic click at such a
 * point misses, because Terra Draw's hit test does not count a vertex-exact
 * point as inside.
 *
 * That was once argued to be harmless here, on the grounds that patches are the
 * parts of one dissolved MultiPolygon and so no two of them share a point. The
 * grounds are wrong, and the failure they let through is `patchContaining`'s to
 * explain: a boolean clipper working on real archive geometry emits parts that
 * run along each other for a whole stretch of ring — a hairline hanging off the
 * outline of the patch beside it — and an anchor that is a VERTEX of the
 * hairline is then a point of the big patch's ring too. Both contain it, and
 * `patchContaining` has to say which one means it.
 *
 * So the anchor is still allowed to land on a boundary; what changed is that
 * matching no longer assumes only one patch can answer to it.
 */
function anchorOf(feature) {
  const p = T().pointOnFeature(feature);
  const [lng, lat] = p.geometry.coordinates;
  return [lng, lat];
}

/** Does this patch touch any part of a class diff? Bbox scan, then one boolean. */
function touchesAny(patchFeature, patchBBox, parts) {
  if (!parts.length) return false;
  const near = parts.filter((p) => bboxOverlaps(p.bbox, patchBBox));
  if (!near.length) return false;
  return T().booleanIntersects(patchFeature,
    asFeature({ type: 'MultiPolygon', coordinates: near.map((p) => p.rings) }));
}

/* ── matching a new patch list against the annotations already written ────── */

/**
 * Reconcile the annotations from the last recompute with a freshly derived
 * patch list.
 *
 * PURE, in the sense that matters: it holds no module state, reads nothing but
 * its arguments, and mutates neither `previous` nor `raw`. The two things it
 * cannot get from its arguments — a key for a patch nobody has seen before, and
 * the moment it first appeared — come from `newKey` and `now`, which default to
 * `crypto.randomUUID` and `Date.now` and can be passed in to make a run
 * bit-for-bit reproducible.
 *
 * Every tie is broken deterministically, and the tiebreaks are load-bearing
 * rather than decorative: `Date.now()` has millisecond resolution and two
 * recomputes can land in the same millisecond, so "oldest wins" falls back to
 * "lowest seq wins", which is a total order because seq is never reused.
 *
 * The passes, in order — later passes only ever see what earlier ones left:
 *
 *   1. ANCHOR CONTAINMENT. Every previous annotation, oldest seq first, looks
 *      for the patch containing its anchor. This is the pass that resolves the
 *      overwhelming majority of real recomputes on its own, and `patchContaining`
 *      is where the "containing" is arbitrated when two patches both are.
 *   2. ADOPTION. A patch with one claimant inherits its identity. A patch with
 *      several is a MERGE.
 *   3. BBOX FALLBACK, for annotations whose anchor landed nowhere — an author
 *      dragged the boundary past their own anchor. Candidates are the still
 *      unclaimed patches whose bounding box overlaps the annotation's remembered
 *      one; a single candidate is taken as-is, and only when there are several
 *      is the ambiguity resolved by which one covers more of the remembered box.
 *   4. NEW PATCHES, and split detection. An unclaimed patch that overlaps where
 *      an adopted annotation used to be is a fragment of it.
 *   5. ORPHANS. Everything still unmatched is kept with `status: 'orphaned'`.
 *
 * @param {object} opts
 * @param {object[]} opts.previous  the annotation pool, attached and orphaned
 * @param {object[]} opts.raw       `derivePatches().patches`
 * @param {number} opts.nextSeq     the next unused change number
 * @returns {{patches, annotations, nextSeq, events}} `annotations` is the whole
 *          pool in seq order — the caller filters by `status`.
 */
export function matchPatches({
  previous = [], raw = [], nextSeq = 1, now = Date.now, newKey = randomKey,
} = {}) {
  /* One clock read for the whole pass, so everything minted by a single
     recompute shares a timestamp and sorts stably against it. */
  const stamp = now();
  let seq = nextSeq;

  const slots = raw.map((p) => ({ patch: p, claims: [] }));
  const adopted = new Array(slots.length).fill(null);   // the Annotation now on this patch
  const inherited = new Array(slots.length).fill(null); // what it looked like BEFORE
  const events = [];

  /* ── 1. anchor containment ─────────────────────────────────────────────── */
  const pool = [...previous].sort(bySeq);
  const homeless = [];
  for (const ann of pool) {
    const i = patchContaining(ann.anchor, slots);
    if (i < 0) homeless.push(ann); else slots[i].claims.push(ann);
  }

  /* ── 2. adoption, and merges ───────────────────────────────────────────── */
  for (let i = 0; i < slots.length; i++) {
    const claims = slots[i].claims;
    if (!claims.length) continue;

    if (claims.length === 1) {
      inherited[i] = claims[0];
      adopted[i] = adopt(claims[0], slots[i].patch);
      if (claims[0].status === 'orphaned') events.push(event('reattached', adopted[i]));
      continue;
    }

    /* A merge. The survivor is the oldest, because the oldest rationale is the
       one the author has had longest to get right and the one a reviewer is
       most likely to have already read. Everything else about the merged
       annotation is conservative: the prose is kept in full and in order rather
       than picked between, and `reviewed` is an AND — a change is only reviewed
       when every change folded into it was. */
    const order = [...claims].sort(byAge);
    const survivor = order[0];
    const absorbed = order.slice(1);
    const merged = adopt(survivor, slots[i].patch);
    merged.rationale = order
      .map((a) => (typeof a.rationale === 'string' ? a.rationale.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
    merged.reviewed = order.every((a) => a.reviewed === true);
    merged.mergedFrom = unique([...(survivor.mergedFrom ?? []), ...absorbed.map((a) => a.key)]);
    inherited[i] = survivor;
    adopted[i] = merged;
    events.push({ ...event('merged', merged), keys: absorbed.map((a) => a.key) });
  }

  /* ── 3. bbox fallback for annotations whose anchor landed nowhere ──────── */
  const unmatched = [];
  for (const ann of homeless) {
    if (!Array.isArray(ann.bbox)) { unmatched.push(ann); continue; }
    const candidates = [];
    for (let i = 0; i < slots.length; i++) {
      if (adopted[i]) continue;
      if (bboxOverlaps(ann.bbox, slots[i].patch.bbox)) candidates.push(i);
    }
    if (!candidates.length) { unmatched.push(ann); continue; }
    /* One candidate needs no arbitration, and arbitrating anyway would mean
       running a boolean op on every recompute for an answer already known. */
    const i = candidates.length === 1 ? candidates[0] : bestCover(ann.bbox, candidates, slots);
    inherited[i] = ann;
    adopted[i] = adopt(ann, slots[i].patch);
    if (ann.status === 'orphaned') events.push(event('reattached', adopted[i]));
  }

  /* ── 4. new patches, and the splits among them ─────────────────────────── */
  for (let i = 0; i < slots.length; i++) {
    if (adopted[i]) continue;
    const parent = splitParent(slots[i].patch, inherited, adopted);
    const fresh = newAnnotation(slots[i].patch, seq++, stamp, newKey);
    adopted[i] = fresh;
    if (parent) {
      /* A split resets `reviewed` on EVERY child, the anchor-holder included.
         The holder keeps its number and its prose, because that is still the
         author's account of what happened there — but what a reviewer approved
         was one patch, and this is no longer one patch. Leaving the holder
         approved would carry a sign-off across a change to the thing signed
         off, silently. `updatedAt` does not move: nobody typed anything. */
      parent.reviewed = false;
      events.push({ ...event('new', fresh), splitFrom: parent.key });
    } else {
      events.push(event('new', fresh));
    }
  }

  /* ── 5. orphans, kept ──────────────────────────────────────────────────── */
  const orphans = [];
  for (const ann of unmatched) {
    const kept = copyAnnotation(ann);
    if (kept.status !== 'orphaned') events.push(event('orphaned', kept));
    kept.status = 'orphaned';
    orphans.push(kept);
  }

  const patches = slots.map((s, i) => ({ key: adopted[i].key, seq: adopted[i].seq, ...s.patch }));
  const annotations = [...adopted, ...orphans].sort(bySeq);
  return { patches, annotations, nextSeq: seq, events };
}

/* Declarations, not `const` arrows, all the way down this file — see the note
   on `createChangeTracker`, and the two outages CLAUDE.md records. */
function bySeq(a, b) { return a.seq - b.seq; }
function byAge(a, b) { return (a.createdAt - b.createdAt) || (a.seq - b.seq); }
function unique(xs) { return [...new Set(xs)]; }
function event(type, a) { return { type, key: a.key, seq: a.seq, name: changeName(a.seq) }; }

function randomKey() {
  const c = globalThis.crypto;
  if (!c || typeof c.randomUUID !== 'function') {
    throw new Error('[usdm/changes] crypto.randomUUID() is unavailable — pass newKey to matchPatches.');
  }
  return c.randomUUID();
}

/**
 * Index of the patch an anchor belongs to, or -1. Bbox scan, then a ray cast.
 *
 * Containment is tested boundary-INCLUSIVE, because `anchorOf` is allowed to
 * return a point on the ring and an anchor that matched nothing would be an
 * orphaned rationale. That inclusiveness is also what makes a tiebreak
 * necessary: where a hairline patch runs along the outline of the patch beside
 * it, a vertex of the hairline lies on BOTH rings, and taking the first match in
 * region order hands the hairline's rationale to whichever of the two the
 * clipper happened to emit first.
 *
 * When that first match is the big neighbour the whole list churns. The
 * neighbour's own annotation is claimed by it too, so pass 2 sees two claims and
 * MERGES them; the hairline is then unclaimed and pass 4 mints a fresh
 * annotation for it — on every recompute, forever. Seq numbers march upward, a
 * group loses a member every autosave, and nothing on screen says why.
 *
 * Three tiebreaks, in this order, and only ever reached when two patches
 * genuinely both contain the point:
 *
 *   1. IDENTITY. A patch whose OWN anchor is exactly this point. `anchorOf` is
 *      deterministic, so a patch whose geometry did not move re-derives the
 *      anchor its annotation is carrying, bit for bit. This is what makes a
 *      recompute over unchanged geometry a fixed point regardless of clipper
 *      order or relative size, which is the property the churn violated.
 *   2. STRICTLY INSIDE beats on-the-line: a patch whose interior holds the
 *      point outranks one that merely has it on its ring.
 *   3. The SMALLEST of whatever is left. A hairline is the more specific claim
 *      to a point on its own edge than the 52,000-vertex neighbour is, and area
 *      is already on the patch, so this costs no geometry. Ties fall back to
 *      region order, which is stable within a recompute.
 */
function patchContaining(anchor, slots) {
  if (!Array.isArray(anchor) || anchor.length < 2) return -1;
  const turf = T();
  const box = [anchor[0], anchor[1], anchor[0], anchor[1]];
  const candidates = [];
  for (let i = 0; i < slots.length; i++) {
    if (!bboxOverlaps(slots[i].patch.bbox, box)) continue;
    if (turf.booleanPointInPolygon(anchor, slots[i].patch.geometry)) candidates.push(i);
  }
  if (candidates.length < 2) return candidates.length ? candidates[0] : -1;

  for (const i of candidates) {
    const own = slots[i].patch.anchor;
    if (Array.isArray(own) && own[0] === anchor[0] && own[1] === anchor[1]) return i;
  }

  const strict = candidates.filter((i) => turf.booleanPointInPolygon(
    anchor, slots[i].patch.geometry, { ignoreBoundary: true }));
  const pool = strict.length ? strict : candidates;
  if (pool.length === 1) return pool[0];

  const areaOf = (i) => (Number.isFinite(slots[i].patch.areaKm2) ? slots[i].patch.areaKm2 : Infinity);
  let best = pool[0];
  for (const i of pool) if (areaOf(i) < areaOf(best)) best = i;
  return best;
}

/**
 * Of several candidate patches, the one covering most of a remembered bounding
 * box. Only reached when the fallback is genuinely ambiguous — see pass 3.
 */
function bestCover(bbox, candidates, slots) {
  const turf = T();
  const box = turf.bboxPolygon(bbox);
  let best = candidates[0], bestArea = -1;
  for (const i of candidates) {
    const both = asMulti(turf.intersect(turf.featureCollection([box, asFeature(slots[i].patch.geometry)])));
    const a = both ? turf.area(asFeature(both)) : 0;
    if (a > bestArea) { bestArea = a; best = i; }
  }
  return best;
}

/**
 * The annotation this unclaimed patch is a fragment of, if any: one that WAS
 * somewhere overlapping this patch and has been re-anchored elsewhere.
 *
 * Bounding boxes, not geometry, because a fragment's parent no longer exists —
 * the remembered box is all there is to compare against. It is generous by
 * design; the cost of a false positive is one `reviewed` flag cleared, and the
 * cost of a false negative is a reviewer's sign-off surviving a split.
 */
function splitParent(patch, inherited, adopted) {
  let best = null, bestOverlap = 0;
  for (let j = 0; j < inherited.length; j++) {
    const was = inherited[j];
    if (!was || !Array.isArray(was.bbox)) continue;
    if (!bboxOverlaps(was.bbox, patch.bbox)) continue;
    const w = Math.min(was.bbox[2], patch.bbox[2]) - Math.max(was.bbox[0], patch.bbox[0]);
    const h = Math.min(was.bbox[3], patch.bbox[3]) - Math.max(was.bbox[1], patch.bbox[1]);
    const overlap = Math.max(w, 0) * Math.max(h, 0);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = adopted[j]; }
  }
  return best;
}

/**
 * An existing annotation, moved onto the patch that now carries it.
 *
 * The author's fields — key, seq, rationale, reviewed, createdAt — are carried
 * verbatim; the geometric ones are refreshed from the patch, which is what lets
 * an anchor follow a boundary as it is dragged. `updatedAt` is NOT touched:
 * matching is the machine re-deriving what it already knew, and an "edited"
 * timestamp that moved every time geometry was recomputed would stop meaning
 * "when a person last wrote here".
 */
function adopt(ann, patch) {
  const a = {
    key: ann.key,
    seq: ann.seq,
    rationale: typeof ann.rationale === 'string' ? ann.rationale : '',
    reviewed: ann.reviewed === true,
    groupId: groupIdOf(ann),
    anchor: [...patch.anchor],
    bbox: [...patch.bbox],
    areaKm2: patch.areaKm2,
    classes: patch.classes.map((c) => ({ ...c })),
    status: 'attached',
    createdAt: ann.createdAt,
    updatedAt: ann.updatedAt,
  };
  if (Array.isArray(ann.mergedFrom) && ann.mergedFrom.length) a.mergedFrom = [...ann.mergedFrom];
  return a;
}

/**
 * An annotation's group, normalized. Anything that is not a non-empty string —
 * `undefined` from a record written before groups existed, `null`, a number a
 * hand-edited session file supplied — reads as UNGROUPED, and the field is
 * always present so that the shape does not depend on how it arrived.
 */
function groupIdOf(a) {
  return typeof a?.groupId === 'string' && a.groupId ? a.groupId : null;
}

function newAnnotation(patch, seq, stamp, newKey) {
  return {
    key: newKey(),
    seq,
    rationale: '',
    reviewed: false,
    /* A fresh change explains itself or nothing; it joins a group only when an
       author puts it in one. */
    groupId: null,
    anchor: [...patch.anchor],
    bbox: [...patch.bbox],
    areaKm2: patch.areaKm2,
    classes: patch.classes.map((c) => ({ ...c })),
    status: 'attached',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function copyAnnotation(a) {
  const out = {
    key: a.key,
    seq: a.seq,
    rationale: typeof a.rationale === 'string' ? a.rationale : '',
    reviewed: a.reviewed === true,
    groupId: groupIdOf(a),
    anchor: Array.isArray(a.anchor) ? [...a.anchor] : null,
    bbox: Array.isArray(a.bbox) ? [...a.bbox] : null,
    areaKm2: a.areaKm2,
    classes: Array.isArray(a.classes) ? a.classes.map((c) => ({ ...c })) : [],
    status: a.status === 'orphaned' ? 'orphaned' : 'attached',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (Array.isArray(a.mergedFrom) && a.mergedFrom.length) out.mergedFrom = [...a.mergedFrom];
  return out;
}

/* ── the live tracker ─────────────────────────────────────────────────────── */

/**
 * A change list bound to one working area, recomputed on demand.
 *
 * This is the object the editor holds. `recompute` is the only thing that
 * touches geometry; everything else is bookkeeping over the annotation pool,
 * so a keystroke in a rationale field costs nothing.
 *
 * A `function` declaration, and every helper it reaches is one too — this
 * module is exactly the shape that has already taken two files down in this
 * repo through the temporal dead zone (see CLAUDE.md).
 *
 * @param {object} opts
 * @param {object|number[]} opts.aoi  the working area, normalized once here so
 *        that a recompute never re-parses it
 */
export function createChangeTracker({ aoi = null, now = Date.now, newKey = randomKey } = {}) {
  const area = aoi ? normalizeAOI(aoi) : null;
  let pool = [];
  let patches = [];
  let nextSeq = 1;
  let epoch = 0;

  function find(key) {
    const a = pool.find((x) => x.key === key);
    if (!a) throw new Error(`[usdm/changes] no annotation with key ${key}`);
    return a;
  }

  /** The ATTACHED members of a group, in seq order. Empty for a bare id. */
  function membersOf(groupId) {
    return groupId
      ? pool.filter((a) => a.status === 'attached' && a.groupId === groupId).sort(bySeq)
      : [];
  }

  /**
   * Everything one write to `a` has to land on: `a` itself, plus every attached
   * member of its group. `a` is unioned in rather than assumed present, because
   * an ORPHAN can still carry a groupId — its group dissolved under it while it
   * was detached — and a write to an orphan must still reach the orphan.
   */
  function writeTargets(a) {
    const group = membersOf(a.groupId);
    return group.includes(a) ? group : [a, ...group];
  }

  /** A group of one is not a group — clear it. Idempotent, and cheap. */
  function dissolveIfSingleton(groupId) {
    const left = membersOf(groupId);
    if (left.length < 2) for (const m of left) m.groupId = null;
  }

  /**
   * Dissolve every group that recomputation has stopped making sense of.
   *
   * Two conditions, one outcome — the groupIds are cleared and every rationale
   * is left exactly as it stands:
   *
   *   · fewer than two attached members. A group of one is a rationale, and
   *     `groupOf` would report a group nobody else is in. Membership falls this
   *     way whenever a member is orphaned, deleted, or absorbed by a merge.
   *   · members whose rationales are not byte-identical. One groupId means one
   *     text by construction, so drift is proof that something outside this
   *     module's control rewrote one of them — a merge concatenating two
   *     rationales into the survivor, or a hand-edited session file. See the
   *     header for why dissolving beats reconciling.
   */
  function reconcileGroups() {
    const groups = new Map();
    for (const a of pool) {
      if (a.status !== 'attached' || !a.groupId) continue;
      if (!groups.has(a.groupId)) groups.set(a.groupId, []);
      groups.get(a.groupId).push(a);
    }
    for (const members of groups.values()) {
      const agreed = members.every((m) => m.rationale === members[0].rationale);
      if (members.length >= 2 && agreed) continue;
      for (const m of members) m.groupId = null;
    }
  }

  const api = {
    /**
     * Re-derive the patches and reconcile them with what is already written.
     * @returns {object[]} the events — merges, splits, orphanings, re-attachments
     */
    recompute(baseline, working, { diffs = null } = {}) {
      const { patches: derived } = derivePatches({ baseline, working, aoi: area, diffs });
      const r = matchPatches({ previous: pool, raw: derived, nextSeq, now, newKey });
      patches = r.patches;
      pool = r.annotations;
      nextSeq = r.nextSeq;
      /* AFTER the match, never inside it: `matchPatches` is pure and knows
         nothing about groups, and the states a group can be left in are all
         states matching PRODUCES — a merge, an orphaning, a split. */
      reconcileGroups();
      return r.events;
    },

    /** The current patches, in region order, LIVE — do not mutate the geometry. */
    get patches() { return patches; },

    /** Attached annotations, in seq order. Copies: `setRationale` is the way in. */
    get annotations() { return pool.filter((a) => a.status === 'attached').map(copyAnnotation); },

    /** Annotations whose patch is currently gone. Kept so undo costs nothing. */
    get orphans() { return pool.filter((a) => a.status === 'orphaned').map(copyAnnotation); },

    /**
     * The author writing. An unknown key is a caller bug, so it throws.
     *
     * A GROUPED annotation writes to its whole group, in one clock read, so
     * every member's text and `updatedAt` stay identical. That is not a
     * broadcast: one groupId means one text by construction, and this is the
     * single place that keeps it so. A caller that means to write to one member
     * alone calls `detachFromGroup` first — which is what "this valley is
     * different after all" actually means.
     */
    setRationale(key, text) {
      const a = find(key);
      const value = text == null ? '' : String(text);
      const stamp = now();
      for (const t of writeTargets(a)) { t.rationale = value; t.updatedAt = stamp; }
      return api;
    },

    /**
     * Give several changes ONE rationale, written once.
     *
     * Mints a fresh group id and stamps it on every named annotation,
     * overwriting whatever group they were in — regrouping is a move, not a
     * merge of two groups, and an annotation belongs to exactly one. Every
     * member then gets the same markdown and the same `updatedAt`.
     *
     * Two members minimum, and every one of them ATTACHED: a group of one is a
     * rationale, and a group including an orphan would be a claim about a patch
     * that is not in the proposal. Both are caller bugs rather than author
     * mistakes — the UI can only offer keys it is showing — so both throw.
     *
     * @param {string[]} keys  at least two attached annotation keys; duplicates
     *                  are collapsed, so the same key twice is still one member
     * @param {string} md      the markdown all of them will carry
     */
    setGroupRationale(keys, md) {
      const list = [...new Set(Array.isArray(keys) ? keys : [])];
      const members = list.map(find);
      const loose = members.filter((a) => a.status !== 'attached');
      if (loose.length) {
        throw new Error('[usdm/changes] cannot group an orphaned annotation: ' +
          loose.map((a) => a.key).join(', '));
      }
      if (members.length < 2) {
        throw new Error('[usdm/changes] setGroupRationale needs at least two distinct ' +
          `attached annotation keys, got ${members.length}`);
      }
      const groupId = newKey();
      const stamp = now();
      const value = md == null ? '' : String(md);
      /* What the members are being taken OUT of, so a group left with one
         member behind does not linger as a group nobody else is in. */
      const vacated = new Set(members.map((a) => a.groupId).filter(Boolean));
      for (const a of members) { a.groupId = groupId; a.rationale = value; a.updatedAt = stamp; }
      for (const old of vacated) if (old !== groupId) dissolveIfSingleton(old);
      return api;
    },

    /**
     * Take one change back out of its group, KEEPING the text it was carrying.
     *
     * Keeping it is the point: the author's next act is almost always to edit
     * that copy into something specific to this patch, and clearing the field
     * would make them retype the shared half first. Idempotent, and a no-op on
     * an ungrouped annotation.
     *
     * Dropping a group to one member dissolves it — see the header. `updatedAt`
     * does not move on either side: no prose changed, and a timestamp that said
     * otherwise would tell a reviewer this rationale had been rewritten.
     */
    detachFromGroup(key) {
      const a = find(key);
      const groupId = a.groupId;
      if (!groupId) return api;
      a.groupId = null;
      dissolveIfSingleton(groupId);
      return api;
    },

    /**
     * The attached keys sharing this annotation's group, INCLUDING its own, in
     * seq order. `[]` when it is ungrouped — or when it is an orphan, which is
     * the same answer for the same reason: a group is a statement about the
     * change list, and an orphan is not in the change list.
     */
    groupOf(key) {
      const a = find(key);
      if (a.status !== 'attached') return [];
      return membersOf(a.groupId).map((m) => m.key);
    },

    setReviewed(key, flag) {
      const a = find(key);
      a.reviewed = flag === true;
      a.updatedAt = now();
      return api;
    },

    /**
     * Drop an annotation entirely. Idempotent.
     *
     * The patch stays — it is geometry, and geometry is not this module's to
     * delete — so the next recompute finds it unclaimed and mints a fresh
     * annotation with a NEW number. That is the honest reading of "delete this
     * rationale": the change is still there, and nobody has explained it yet.
     */
    deleteAnnotation(key) {
      const n = pool.length;
      pool = pool.filter((a) => a.key !== key);
      if (pool.length !== n) epoch++;
      return pool.length !== n;
    },

    /**
     * Bumped when the POOL moves under the patches without the geometry moving
     * — `hydrate` (a restore brings everything back orphaned and needs the
     * re-anchoring recompute) and `deleteAnnotation` (the next recompute mints
     * the fresh number). js/app.js keys "is the change list current?" on
     * `(changeset.version, tracker.epoch)`; without this a restore at an
     * unchanged version would be served the stale list.
     */
    get epoch() { return epoch; },

    /**
     * Is every change explained?
     *
     * Asked of the PATCHES, not of the annotation pool, and the difference is
     * only ever visible for one move: `deleteAnnotation` leaves a patch with no
     * annotation at all, and a pool-driven answer would call that complete
     * because there is nothing left in the pool to be incomplete. The patch is
     * still in the proposal, so it is still owed a reason.
     *
     * Orphans are ignored, and must be: an orphan explains something the
     * proposal no longer contains, so holding a submission open for one would
     * make an undone edit un-submittable. Vacuously true when nothing changed.
     */
    annotationsComplete() {
      const attached = new Map(pool.filter((a) => a.status === 'attached').map((a) => [a.key, a]));
      return patches.every((p) => (attached.get(p.key)?.rationale.trim().length ?? 0) > 0);
    },

    /**
     * Reinstate a saved pool, replacing whatever is here.
     *
     * Everything comes back ORPHANED, whatever it was saved as, because no
     * geometry has been derived yet and an annotation's status is a claim about
     * geometry. The first `recompute` re-anchors them all — which is the same
     * path a redo takes, and is why restoring a session does not need a second
     * mechanism.
     */
    hydrate(saved) {
      const list = (Array.isArray(saved) ? saved : []).filter((s) => s && typeof s.key === 'string' && s.key);
      let max = 0;
      for (const s of list) if (Number.isInteger(s.seq) && s.seq > max) max = s.seq;
      pool = list.map((s) => {
        const a = copyAnnotation(s);
        if (!Number.isInteger(a.seq) || a.seq < 1) a.seq = ++max;
        if (!Number.isFinite(a.areaKm2)) a.areaKm2 = 0;
        if (!Number.isFinite(a.createdAt)) a.createdAt = now();
        if (!Number.isFinite(a.updatedAt)) a.updatedAt = a.createdAt;
        a.status = 'orphaned';
        return a;
      }).sort(bySeq);
      patches = [];
      /* Above the highest number ever seen, not above the count: a saved
         session with Changes 2 and 5 must not mint a second Change 5. */
      nextSeq = max + 1;
      epoch++;
      return api;
    },

    /** The pool as a plain array, deep-copied, in seq order. */
    serialize() {
      return [...pool].sort(bySeq).map(copyAnnotation);
    },
  };
  return api;
}

/* ── edge effects ─────────────────────────────────────────────────────────── */

/**
 * The sentences an author owes a neighbour.
 *
 * A working area is a jurisdiction, and drought does not stop at its line. When
 * a patch runs along the border, the proposal is implicitly saying something
 * about the ground on the other side — where a different author, in a different
 * state, is drawing the same week. This produces one plain statement per such
 * patch, for the coordination note that rides along with the proposal.
 *
 * Where a patch reaches the border its own outline IS the AOI boundary (the
 * clipper emitted the AOI's vertices), so the shared stretch is the overlap of
 * two nearly-coincident lines — `turf.lineOverlap` at 50 m tolerance, which
 * absorbs coincident-edge float noise and stays under any boundary vertex
 * spacing. The PATCH's outline goes FIRST, and the order is load-bearing:
 * lineOverlap keeps first-line segments whose endpoints lie near a second-line
 * segment, so a short patch fragment against a long AOI segment passes where
 * the other order measures zero. (intersect/lineIntersect/lineSplit were each
 * tried and cannot see a coincident run.)
 *
 * Exactness is not required — the sentence rounds to whole kilometres — but
 * attribution is not approximated: a neighbour is named only if its geometry
 * reaches within NEIGHBOR_BUFFER_KM of the stretch, buffered as one union
 * (same set, one boolean op).
 *
 * @param {object} opts
 * @param {object[]} opts.patches  MATCHED patches (they need `key` and `seq`)
 * @param {object} opts.aoi        the working area; must have a `geometry` and a
 *                 `name`. A bare bounding box gets an empty result: a rectangle
 *                 has no neighbours, only an envelope.
 * @param {object[]} opts.neighbors  `[{ id, name, geometry }]`, already
 *                 resolved — deciding WHICH jurisdictions are adjacent, and
 *                 fetching their boundaries, is the app layer's job.
 * @returns {object[]} one entry per patch that touches the border AND has a
 *                 named neighbour across it
 */
export function deriveEdgeEffects({ patches = [], aoi = null, neighbors = [] } = {}) {
  const turf = T();
  if (!aoi || !patches.length || !neighbors.length) return [];
  const area = normalizeAOI(aoi);
  if (!area.geometry) return [];

  const aoiLine = boundaryOf(area.geometry);
  if (!aoiLine) return [];
  const aoiLineFeature = asLineFeature(aoiLine);
  const named = neighbors
    .filter((n) => n && n.geometry)
    .map((n) => {
      const feature = asFeature(n.geometry);
      return { id: n.id ?? null, name: n.name ?? String(n.id ?? ''), feature, bbox: turf.bbox(feature) };
    })
    .filter((n) => n.feature);

  const out = [];
  for (const patch of patches) {
    if (!bboxOverlaps(patch.bbox, area.bbox)) continue;
    const patchFeature = asFeature(patch.geometry);
    if (!turf.booleanIntersects(patchFeature, aoiLineFeature)) continue;

    const patchLine = boundaryOf(patch.geometry);
    if (!patchLine) continue;
    const overlap = turf.lineOverlap(asLineFeature(patchLine), aoiLineFeature,
      { tolerance: EDGE_TOLERANCE_KM });
    const strings = [];
    for (const f of overlap.features) {
      const g = f.geometry;
      if (g.type === 'LineString') strings.push(g.coordinates);
      else if (g.type === 'MultiLineString') strings.push(...g.coordinates);
    }
    /* Touching the boundary at a single point is not running along it. */
    if (!strings.length) continue;

    /* ONE EFFECT PER (PATCH, NEIGHBOUR), each carrying only the run of
       boundary it actually shares with THAT neighbour. Each overlap string is
       buffered on its own and assigned to every neighbour its buffer reaches;
       a patch on a tripoint therefore yields two effects with disjoint
       segments, two lengths and two one-border sentences — where one effect
       naming both borders, with the combined length, used to be filed under
       each neighbour in turn, so North Dakota's section of the brief read about
       South Dakota's line. The effect shape is unchanged (`neighborIds` and
       `neighborNames` are arrays, now of length one), so every reader that
       groups by neighbour works as it did. */
    const runFeature = asLineFeature({ type: 'MultiLineString', coordinates: strings });
    const buffered = turf.buffer(runFeature, NEIGHBOR_BUFFER_KM, { units: 'kilometers' });
    if (!buffered) continue;
    const bufferBBox = turf.bbox(buffered);
    const across = named.filter((n) =>
      bboxOverlaps(n.bbox, bufferBBox) && turf.booleanIntersects(buffered, n.feature));
    /* A coastline, an international border, or simply a neighbour the caller
       did not supply. There is a shared edge but nobody to address. */
    if (!across.length) continue;

    /* Which part of the run is THIS neighbour's: the overlap of the run with
       the neighbour's own outline — the two coincide along a shared state
       line, and nowhere else. The neighbour is first cut to the run's box
       (`bboxClip`, linear) so `polygonToLine` and `lineOverlap` never see the
       whole unsimplified state. One long string across a tripoint is split
       here exactly where one neighbour hands over to the next. If the overlap
       comes back empty for a neighbour the buffer reached (a corner touch, a
       tolerance miss), the whole run stands in for it rather than nothing. */
    const perNeighbor = across.map((n) => {
      let mine = strings;
      try {
        const clipped = turf.bboxClip(n.feature, bufferBBox);
        const outline = boundaryOf(clipped?.geometry);
        const ov = outline ? turf.lineOverlap(runFeature, asLineFeature(outline), { tolerance: EDGE_TOLERANCE_KM }) : null;
        const parts = [];
        for (const f of ov?.features ?? []) {
          const g = f.geometry;
          if (g.type === 'LineString') parts.push(g.coordinates);
          else if (g.type === 'MultiLineString') parts.push(...g.coordinates);
        }
        if (parts.length) mine = parts;
      } catch (err) {
        console.warn('[usdm/changes] could not split the shared run by neighbour', err);
      }
      return { n, strings: mine };
    });

    for (const { n, strings: mine } of perNeighbor) {
      const segments = { type: 'MultiLineString', coordinates: mine };
      const lengthKm = turf.length(asLineFeature(segments), { units: 'kilometers' });
      out.push({
        patchKey: patch.key,
        seq: patch.seq,
        name: changeName(patch.seq),
        classes: patch.classes.map((c) => c.class),
        directions: patch.classes.map((c) => c.direction),
        categories: patch.classes.map((c) => c.category),
        /* The rendered sentence travels too, so js/geojson.js can read it instead
           of importing the table — see the note beside `phrase` in
           `derivePatches`. */
        phrases: patch.classes.map((c) => c.phrase),
        neighborIds: [n.id],
        neighborNames: [n.name],
        segments,
        lengthKm,
        statement: statementFor(patch, area, [n], lengthKm),
      });
    }
  }
  return out;
}

/**
 * `Suggesting an expansion of D1 and a reduction of D2 and D3 along the
 *  Montana / North Dakota border (48 mi).`
 *
 * Classes are grouped by DIRECTION rather than listed one by one, because a
 * patch where two classes moved the same way moved once. Each border is named
 * as a full pair — "Montana / North Dakota and Montana / South Dakota" rather
 * than "Montana / North Dakota and South Dakota" — so that every pair in the
 * sentence reads as a pair, whichever end of it the reader is standing at.
 * (`deriveEdgeEffects` now emits one effect per neighbour, so the app itself
 * never produces a plural; the branch stays for a hand-built effect list.)
 */
function statementFor(patch, area, across, lengthKm) {
  const groups = new Map();
  for (const c of patch.classes) {
    if (!groups.has(c.direction)) groups.set(c.direction, []);
    groups.get(c.direction).push(c.class);
  }
  const clauses = [...groups].map(([dir, ids]) =>
    `${DIRECTION_WORDS[dir] ?? 'a change'} of ${prose(ids)}`);
  const borders = across.map((n) => `${area.name} / ${n.name}`);
  const what = clauses.length ? prose(clauses) : 'a change';
  return `Suggesting ${what} along the ${prose(borders)} border` +
    `${borders.length > 1 ? 's' : ''} (${fmtMi(lengthKm)} mi).`;
}

/** ['a', 'b', 'c'] → 'a, b and c'. */
export function prose(list) {
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * A (Multi)Polygon's rings as one MultiLineString.
 *
 * `turf.polygonToLine` returns a LineString for a simple polygon, a
 * MultiLineString when there are holes, and a FeatureCollection of either for a
 * MultiPolygon — the same read-it-at-the-wrong-depth hazard js/topology.js's
 * `asMulti` exists to close, one geometry type over. This is that function for
 * lines, and it is the only place the distinction is allowed to exist here.
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

function asLineFeature(geometry) {
  return { type: 'Feature', properties: {}, geometry };
}

/* ── threads: class geometry left standing in the gap between two edits ──────
   Adjacent edits JOIN correctly (one union dissolves a shared seam); what fails
   is the HAND-DRAWN NEAR-MISS — a ~300 m gap leaving a ~5.9 km² ribbon of the
   old class, 87× SLIVER_ADVICE_M2, reported nowhere.

   Two detectors were tried and are recorded because each looked right. WIDTH
   (a negative buffer) fires on the archive itself: published band widths run
   median ~467–600 m with p05 down at 63–257 m and minima of single metres, so
   the ~300 m ribbon is NARROWER than the median band and any radius that
   catches it erases real geometry. Surviving PARTS reports nothing: a thread
   is a NECK of a large part, still joined to its class beyond the edits — and
   gaps between parts of the MERGED region also find nothing, because the two
   improvements come back as one connected region part.

   WHAT WORKS is one class, one side at a time: that class's removed (or added)
   pieces ARE separate, separated by the ribbon. Grow each by THREAD_GAP_KM,
   intersect pairs, subtract the edit; whatever still stands is a thread.
   Sides never mix — a gap between removals closes by improving, between
   additions by degrading, and the space between an improvement and a
   degradation is not a failed join at all. ═══════════════════════════════════ */

/**
 * Half the widest gap between two edits that still counts as a near-miss.
 *
 * 0.5 km, so gaps up to about a kilometre are noticed. This is a number about
 * DRAWING, not about drought: it is the scale at which two shapes an author
 * meant to join fail to. The measured failure was a 300 m gap; a kilometre gives
 * that room without reaching across ground somebody deliberately left between
 * two separate edits — verified, two improvements 55 km apart report nothing.
 *
 * Deliberately NOT derived from the band-width distribution above. Those numbers
 * rule out asking whether a band is thin; they say nothing about how close two
 * hand-drawn edges have to be before the gap between them was a mistake.
 */
const THREAD_GAP_KM = 0.5;

/**
 * Class geometry left standing in a gap between two edits of the same kind.
 *
 * DOM-free like the rest of this module. Runs inside `recomputeChanges`, the one
 * pass every commit makes, so it catches a thread whatever produced it
 * — one op, a reshape, or two ops a week apart. Measured at 76 ms on a real
 * Montana week with two edits, inside the 500 ms budget `derivePatches` already
 * shares with `deriveChangeMap` (§§ 11g, 15g).
 *
 * @param {object} opts
 * @param {object} opts.baseline  {D0..D4} contours as published
 * @param {object} opts.working   {D0..D4} contours as the author has them
 * @param {object|number[]} [opts.aoi]  the working area
 * @param {number} [opts.minAreaM2]  floor; defaults to `MIN_PATCH_AREA_M2`, so a
 *                 thread too small for the change list to annotate is too small
 *                 to mention here either
 * @returns {object[]} `{ usdmClass, label, verb, geometry, bbox, areaKm2 }`,
 *          largest first — a thread's SIZE is what makes it worth closing.
 */
export function deriveThreads({ baseline, working, aoi = null, minAreaM2 = MIN_PATCH_AREA_M2,
                                diffs = null, bands = null } = {}) {
  const turf = T();
  if (!working) return [];
  const area = aoi ? normalizeAOI(aoi) : null;
  /* Both may be handed in from the changeset's per-version memos (`diffs`,
     `bands`); computed here otherwise. `deriveBands` drops only parts under
     MIN_PART_AREA_M2 (0.01 m²) and a thread is floored at `minAreaM2`, so a
     handed-in band and the difference below give the same threads. */
  diffs = diffs ?? perClassDiffs(baseline, working, aoi ?? null);
  /* The WHOLE changed region comes out of the neck below, not one side of one
     class's diff: a thread is ground whose class DID NOT CHANGE, and ground
     that changed can never be one. The one-sided operand (`movedAll`) false-
     positived structurally — every improvement that removes D2 necessarily
     ADDS D2 wherever D3 was, right between the removed pieces — and § 18a-2
     pins the invariant (no thread on ground whose class moved). It cannot
     suppress a real thread, whose class is unchanged by definition. */
  const changed = mergedDiffRegion(diffs);
  const out = [];

  for (const c of CLASSES) {
    const contour = asMulti(working[c]);
    if (!contour) continue;
    /* THE BAND, not the contour. `working[c]` is cumulative — "c or worse" — so
       intersecting it would count every severer class inside the gap as
       surviving c, which after an improvement it legitimately is. What is left
       standing has to be ground that is still EXACTLY this class. */
    const inner = CLASSES[CLASSES.indexOf(c) + 1];
    const band = bands
      ? asMulti(bands[c])
      : inner && working[inner]
        ? asMulti(turf.difference(turf.featureCollection([
          asFeature(contour), asFeature(asMulti(working[inner]))]))?.geometry)
        : contour;
    if (!band) continue;

    for (const side of ['removed', 'added']) {
      const g = asMulti(diffs?.[c]?.[side]);
      if (!g) continue;
      const moved = indexParts(g);
      if (moved.length < 2) continue;              // a gap needs two sides

      /* Grow each piece ONCE. Pairwise buffering would repeat the expensive
         half O(n²) times over the same n shapes. */
      const grown = moved.map((p) => {
        const b = turf.buffer(asFeature({ type: 'Polygon', coordinates: p.rings }),
          THREAD_GAP_KM, { units: 'kilometers' });
        return b ? { geometry: b.geometry, bbox: turf.bbox(b) } : null;
      });

      const necks = [];
      for (let i = 0; i < grown.length; i++) {
        for (let j = i + 1; j < grown.length; j++) {
          const a = grown[i]; const b = grown[j];
          if (!a || !b || !bboxOverlaps(a.bbox, b.bbox)) continue;
          const both = turf.intersect(turf.featureCollection([
            asFeature(a.geometry), asFeature(b.geometry)]));
          if (both) necks.push(both.geometry);
        }
      }
      if (!necks.length) continue;

      let zone = necks.length === 1 ? asMulti(necks[0])
        : asMulti(turf.union(turf.featureCollection(necks.map(asFeature)))?.geometry);
      if (!zone) continue;
      /* Nothing the proposal touched is a thread — see `changed` above. */
      const cleared = changed
        ? turf.difference(turf.featureCollection([asFeature(zone), asFeature(changed)]))
        : { geometry: zone };
      if (!cleared) continue;
      zone = asMulti(cleared.geometry);
      if (area?.geometry) {
        const inside = intersectNear(zone, asMulti(area.geometry));
        if (!inside) continue;
        zone = asMulti(inside);
      }

      const left = intersectNear(band, zone);
      if (!left) continue;
      for (const part of indexParts(left)) {
        const geometry = { type: 'Polygon', coordinates: part.rings };
        const m2 = turf.area(asFeature(geometry));
        if (m2 < minAreaM2) continue;
        out.push({
          usdmClass: c,
          label: USDM_LABELS[c],
          /* Which way it closes. See the header: never mixed. */
          verb: side === 'removed' ? 'improve' : 'degrade',
          geometry,
          bbox: part.bbox,
          areaKm2: m2 / 1e6,
        });
      }
    }
  }
  out.sort((a, b) => b.areaKm2 - a.areaKm2);
  return out;
}
