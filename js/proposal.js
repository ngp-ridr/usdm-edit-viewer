/* ══ USDM Edit Viewer · js/proposal.js ═══════════════════════════════════════
   One `usdm-edit-proposal/2` package, parsed into the object every other
   engine module reads: identity, the working area, the author, the bands, the
   patches — and, lazily, the four derived things a comparison needs.

   DOM-FREE, like the rest of the engine (docs/contracts.md § 2). No `window`,
   no `document`, no `fetch`; turf arrives through `topology.js`'s `T()` shim,
   which is `globalThis.turf` in the browser and an assignment before the first
   import under Node. `tools/compare.test.mjs` § 0 greps this file's source text
   for all three.

   ── THE PUBLISHED WEEK IS RECONSTRUCTABLE FROM A PACKAGE ALONE ─────────────
   and that is the single fact this whole app rests on, because it is what
   makes a within-AOI comparison need no network at all:

       contours[c] = changes.find(c)?.before ?? deriveContours(derivedBands)[c]
       published.bands = deriveBands(contours)

   Sound because `changes[]` names EVERY class a verb or the cascade touched
   (js/submit.js `buildPackageCore`), so a class absent from it is a class
   whose contour the proposal did not move — and for such a class the
   proposal's own contour, which `deriveContours(derivedBands)` hands back, IS
   the baseline's. The assembled set is therefore the editor's healed baseline
   contour set, class for class, and needs no second heal: every class comes
   either from the baseline directly (`before`) or from geometry identical to
   it. Measured during planning: the two packages of every state agree to
   0.0000 km² per class, which is two independent reconstructions of the same
   week from different authors' files.

   The test that a package is INTERNALLY consistent is `checkIntegrity` below,
   and it is where a hand-edited file is caught — not here.

   ── What is kept, and what is dropped ──────────────────────────────────────
   The ten original example packages are 11 MiB of JSON and `changes[].before`
   / `changes[].after` dominate. Painting needs only `bands`, `patches`,
   `aoi.geometry` and `edgeEffects[].segments` (< 100 KB per proposal), so the
   contours are held only until `published` and `integrity` have both been
   built and are then released. `changes[].before/after` are enumerable GETTERS
   over that one store: the row objects stay frozen, the store goes to null,
   and a late reader gets `null` rather than a stale 900 KB ring.
   ========================================================================== */

import {
  T, CLASSES, asMulti, asFeature, indexParts, envelopeOf, bboxOverlaps,
  deriveContours, deriveBands,
} from '../vendor/usdm-editor/js/topology.js';
import { deriveChangeMap, worstDeltaWithin } from '../vendor/usdm-editor/js/delta.js';
/* The magnitude bar and the re-check sentence live in ONE place; see
   `checkIntegrity` for why that place is js/recheck.js and not this file.
   Both are DOM-free, so the import keeps the engine runnable under Node. */
import { recheckPackage } from './recheck.js';

const PACKAGE_SCHEMA = 'usdm-edit-proposal/2';
const LEGACY_SCHEMA = 'usdm-edit-proposal/1';

/**
 * The six states a place can be in, mildest first — the ONE ordinal scale in
 * this app (docs/contracts.md § 1).
 *
 * It is `js/delta.js`'s scale, deliberately: `deriveChangeMap` labels the same
 * six states none = −1 … D4 = 4, so a signed step computed here and a
 * `USDM_CHANGE_LABELS` lookup in the vendored copy agree by construction
 * rather than by a table somebody has to keep in sync.
 */
export const LEVELS = Object.freeze(['none', ...CLASSES]);

/** A level STRING → its ordinal NUMBER. `'none'` is −1, `'D0'` is 0. */
export function ord(level) {
  return LEVELS.indexOf(level) - 1;
}

/* ── the refusals ─────────────────────────────────────────────────────────── */

/**
 * A package this app will not open, with a machine-readable `reason` and the
 * sentence a person is shown (docs/contracts.md § 15). One class rather than
 * five, because every caller handles them the same way — it names the file and
 * moves on to the next one.
 */
export class ProposalError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ProposalError';
    this.reason = reason;
  }
}

const REFUSALS = Object.freeze({
  schemaV1: 'That is a version 1 proposal. Version 1 cannot be compared — open it in ' +
    'the editor and save it again.',
  missingGeometry: 'That proposal carries no working-area geometry, so there is nothing ' +
    'to place it on.',
  missingBands: 'That proposal carries no derived bands, so its classes cannot be drawn.',
  missingWeek: 'That proposal does not say which week it was drawn against.',
});

function refuse(reason, message) {
  throw new ProposalError(reason, message ?? REFUSALS[reason] ?? reason);
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

/**
 * A package → the frozen `Proposal` of docs/contracts.md § 2.
 *
 * Nothing geometric happens here. Every derived thing below is a lazy getter,
 * because intake loads twelve files in a row and a reader who only wants the
 * proposal LIST must not pay for twelve partitions to get it.
 *
 * @param {object} pkg  a parsed `usdm-edit-proposal/2` package
 * @param {object} [opts]
 * @param {string|null} [opts.fileName]  as loaded, or null for ?load= / ?demo
 * @param {string|null} [opts.sha256]    of the file's bytes, when known
 * @param {string|null} [opts.source]    the url it came from
 * @returns {object} frozen Proposal
 */
export function parseProposal(pkg, { fileName = null, sha256 = null, source = null } = {}) {
  if (!pkg || typeof pkg !== 'object') {
    refuse('notAProposal', 'That is not a USDM proposal file — it says nothing at all.');
  }
  if (pkg.schema === LEGACY_SCHEMA) refuse('schemaV1');
  if (pkg.schema !== PACKAGE_SCHEMA) {
    refuse('notAProposal',
      `That is not a USDM proposal file — it says \`${pkg.schema ?? 'no schema'}\`.`);
  }
  const week = pkg.baseline?.week;
  if (typeof week !== 'string' || !week) refuse('missingWeek');
  if (!pkg.aoi?.geometry) refuse('missingGeometry');
  /* PRESENT but all-null is legal and is loaded: a working area with no
     drought in it after the edit has five null bands and is a perfectly good
     proposal. ABSENT is the refusal — there is then no way to know which of
     the two it was. */
  if (!pkg.derivedBands || typeof pkg.derivedBands !== 'object') refuse('missingBands');

  const id = typeof pkg.id === 'string' && pkg.id ? pkg.id : `anon-${hashOf(JSON.stringify(pkg.aoi.bbox ?? []) + week)}`;
  const aoiGeometry = asMulti(pkg.aoi.geometry);
  const aoiParts = indexParts(aoiGeometry);
  const aoi = Object.freeze({
    kind: pkg.aoi.kind ?? null,
    id: pkg.aoi.id ?? null,
    name: pkg.aoi.name ?? pkg.aoi.id ?? 'the working area',
    /* The AOI's OWN envelope, never the shipped `bbox`, wherever geometry is
       clipped to it — the Alaska rule (CLAUDE.md): a composite boundary file
       can ship a rectangle that does not contain its own rings. The shipped
       bbox is kept beside it because it is what the package pins. */
    bbox: pkg.aoi.bbox ?? envelopeOf(aoiParts),
    envelope: envelopeOf(aoiParts),
    geometry: aoiGeometry,
  });

  const bands = Object.freeze(Object.fromEntries(
    CLASSES.map((c) => [c, asMulti(pkg.derivedBands[c] ?? null)])));

  /* The one mutable corner of this module, and it is a closure rather than a
     property: `published` and `integrity` both need the raw package, and both
     are lazy, so it is held until the second of them has run and is then
     released. Nothing outside this function can reach it. */
  let store = pkg;
  let builtPublished = false;
  let builtIntegrity = false;
  function releaseWhenDone() {
    if (builtPublished && builtIntegrity) store = null;
  }

  const changes = Object.freeze((Array.isArray(pkg.changes) ? pkg.changes : [])
    .filter((ch) => CLASSES.includes(ch?.class))
    .map((ch) => {
      const row = { class: ch.class, label: ch.label ?? null, areaKm2: ch.areaKm2 ?? null, parts: ch.parts ?? null };
      /* Enumerable so the row still stringifies; a getter so the release is a
         single assignment rather than a walk over five rings. */
      for (const side of ['before', 'after']) {
        Object.defineProperty(row, side, {
          enumerable: true,
          get: () => (store ? asMulti(rowOf(store, ch.class)?.[side] ?? null) : null),
        });
      }
      return Object.freeze(row);
    }));

  const patches = Object.freeze((Array.isArray(pkg.proposedChanges) ? pkg.proposedChanges : [])
    .map((c) => Object.freeze({
      key: c.id, id: c.id, seq: c.seq, name: c.name,
      geometry: c.geometry ?? null,
      anchor: c.anchor ?? null,
      bbox: c.bbox ?? (c.geometry ? envelopeOf(indexParts(c.geometry)) : null),
      areaKm2: c.areaKm2 ?? 0,
      classes: Object.freeze(Array.isArray(c.classes) ? c.classes.map((x) => Object.freeze({ ...x })) : []),
      rationale: c.rationale ?? null,
      groupId: c.groupId ?? null,
      reviewed: c.reviewed === true,
      annotated: c.annotated === true,
    })));

  const shortId = id.slice(0, 8);
  const p = {
    id,
    shortId,
    key: `${aoi.id}@${week}#${shortId}`,
    created: pkg.created ?? null,
    fileName,
    /* THE URL THE FILE CAME FROM, and null for one a person picked or dropped.
       Never `pkg.baseline.source`, which is the archive parquet the proposal
       was drawn against and stays under `baseline` — the session line says "a
       link will open empty" off exactly this field, and a baseline url here
       would make every local file look shareable. */
    source: source ?? null,
    sha256,
    week,
    nesting: pkg.baseline?.nesting ?? null,
    baselineSha256: pkg.baseline?.sha256 ?? null,
    aoi,
    author: Object.freeze({
      name: pkg.author?.name ?? null,
      email: pkg.author?.email ?? null,
      affiliation: pkg.author?.affiliation ?? null,
      role: pkg.author?.role ?? null,
      onBehalfOf: pkg.author?.onBehalfOf ?? null,
    }),
    bands,
    changedRegion: asMulti(pkg.changedRegion ?? null),
    patches,
    edgeEffects: Object.freeze(Array.isArray(pkg.edgeEffects) ? pkg.edgeEffects : []),
    justification: Object.freeze({
      format: pkg.justification?.format ?? 'markdown',
      rationale: pkg.justification?.rationale ?? '',
      impacts: pkg.justification?.impacts ?? '',
      evidence: Object.freeze(Array.isArray(pkg.justification?.evidence) ? pkg.justification.evidence : []),
      borderNotes: Object.freeze({ ...(pkg.justification?.borderNotes ?? {}) }),
    }),
    edgeBrief: pkg.edgeBrief ?? null,
    /* The magnitude heuristic's VERDICT, without its sample grid. The card
       renders the sentence and can zoom to the `geometry`; the samples are a
       lattice of points over a whole state that nothing here reads, and they
       are the only part of the block worth dropping (docs/contracts.md § 2). */
    heuristic: pkg.heuristic
      ? Object.freeze({ ...pkg.heuristic, samples: undefined })
      : null,
    changes,
    validationPassed: pkg.validation?.passed === true,
    warningCount: Array.isArray(pkg.warnings) ? pkg.warnings.length : 0,
  };

  /* ── the four lazy memos ───────────────────────────────────────────────────
     Every one of them is geometry, every one costs hundreds of milliseconds
     over a state, and the drawer needs none of them to list a proposal. */
  const memo = new Map();
  const lazy = (name, build) => Object.defineProperty(p, name, {
    enumerable: false,
    get() {
      if (!memo.has(name)) memo.set(name, build());
      return memo.get(name);
    },
  });

  /* The proposal's own cumulative contours, from the bands it ships. ONE
     `deriveContours` per proposal, shared by `published` (which needs it for
     the classes `changes[]` does not name), by `partition` (whose `none` band
     is the working area minus the D0 contour) and by `checkIntegrity` (whose
     whole job is comparing it against `changes[].after`). */
  lazy('contours', () => deriveContours(bands));

  lazy('published', () => {
    const byClass = new Map(changes.map((ch) => [ch.class, ch]));
    const contours = {};
    for (const c of CLASSES) {
      const row = byClass.get(c);
      /* The ROW's existence is the test, never `before != null`: a class that
         did not exist in the published week ships `before: null`, and `??`
         would quietly substitute the proposal's own contour for it — turning
         "this class is new" into "this class was always here". */
      contours[c] = row ? asMulti(row.before) : p.contours[c];
    }
    const out = Object.freeze({ contours: Object.freeze(contours), bands: Object.freeze(deriveBands(contours)) });
    builtPublished = true;
    releaseWhenDone();
    return out;
  });

  lazy('partition', () => partitionOf(p.contours, bands, aoi.geometry));
  lazy('publishedPartition', () => partitionOf(p.published.contours, p.published.bands, aoi.geometry));
  lazy('bandIndex', () => levelIndex(bands));
  lazy('publishedBandIndex', () => levelIndex(p.published.bands));
  lazy('aoiParts', () => aoiParts);
  /* The change map this proposal makes against the week it was drawn on —
     NDMC's own ordinal arithmetic, from the vendored js/delta.js, so "a
     2-class degradation" on a card is the same sentence the editor wrote.
     `p.contours` is the working side: it is `deriveContours` over the shipped
     bands, which is what `changes[].after` carries for an edited class and
     what the published contour is for an untouched one, computed one way
     instead of stitched from two. Lazily memoized — it is two partitions and
     thirty intersections, and no card needs it until one is opened. */
  lazy('changeMap', () => deriveChangeMap({
    baseline: p.published.contours, working: p.contours, aoi: p.aoi,
  }));
  lazy('integrity', () => {
    const out = gradeIntegrity(store ?? {});
    builtIntegrity = true;
    releaseWhenDone();
    return out;
  });

  return Object.freeze(p);
}

/** The `changes[]` row for one class, from the raw package. */
function rowOf(pkg, cls) {
  return (Array.isArray(pkg.changes) ? pkg.changes : []).find((ch) => ch?.class === cls) ?? null;
}

/**
 * A proposal with a WIDER `shortId`, for the session's collision rule
 * (docs/contracts.md § 8, decision 3). The Proposal is frozen, so this is a
 * new frozen object over the same memo-carrying getters — the copy keeps every
 * accessor, so a partition already built on the original is not rebuilt.
 */
export function withShortId(proposal, shortId) {
  if (proposal.shortId === shortId) return proposal;
  const copy = Object.create(Object.getPrototypeOf(proposal));
  /* The two replaced keys are SKIPPED rather than copied and overwritten: a
     descriptor taken off a frozen object is non-configurable, so copying it
     first makes the overwrite throw. */
  for (const name of Object.getOwnPropertyNames(proposal)) {
    if (name === 'shortId' || name === 'key') continue;
    Object.defineProperty(copy, name, Object.getOwnPropertyDescriptor(proposal, name));
  }
  Object.defineProperty(copy, 'shortId', { value: shortId, enumerable: true });
  Object.defineProperty(copy, 'key', {
    value: `${proposal.aoi.id}@${proposal.week}#${shortId}`, enumerable: true,
  });
  return Object.freeze(copy);
}

/** `state:MT@2026-09-08#06e8fb67` — one proposal, said in one string. */
export function proposalKey(p) {
  return `${p.aoi?.id ?? 'unknown'}@${p.week}#${p.shortId}`;
}

/* ── partitions ───────────────────────────────────────────────────────────── */

/**
 * One side's classes → a partition of the working area into six PREPARED
 * levels, mildest first, any of which may be null.
 *
 * The `partitionOf`/`prepare` pattern of the vendored `js/delta.js`
 * (lines 163–234), with one change: the level LABELS are kept, because this
 * app compares two proposals rather than one proposal against itself, and the
 * answer it needs is "which class does each side say", not "how many classes
 * did it move".
 *
 * The `none` band is the one whole-area boolean op here: the working area
 * minus the D0 CONTOUR, which is the drought footprint. Handed the contours
 * that are already memoized on the proposal rather than re-deriving them —
 * `deriveContours` over a state's five bands is four unions, and this module
 * pays for it once.
 */
function partitionOf(contours, bands, aoiGeometry) {
  const turf = T();
  const ground = asMulti(aoiGeometry);
  const d0 = asMulti(contours?.D0 ?? null);
  const none = d0
    ? asMulti(turf.difference(turf.featureCollection([asFeature(ground), asFeature(d0)])))
    : ground;
  return [none, ...CLASSES.map((c) => bands[c])]
    .map((g, i) => prepare(LEVELS[i], g));
}

/** A level, indexed once: its label, its parts by bbox, and its envelope. */
function prepare(level, geometry) {
  const m = asMulti(geometry);
  if (!m) return null;
  const parts = indexParts(m);
  const bbox = envelopeOf(parts);
  return bbox ? { level, parts, bbox } : null;
}

/**
 * Re-prepare a partition inside `ground` — for a CROSS-AOI pair, where the two
 * proposals answer only the ground their working areas share.
 *
 * `clipToExtent` on the ground's own rectangles rather than a naked intersect
 * with its rings: the rectangles are a superset of the ground, so the clip
 * never removes an answer, and the ground itself is applied once as the
 * comparison's operand rather than six times here.
 */
export function clipPartition(partition, groundParts) {
  const boxes = groundParts.map((g) => g.bbox);
  return partition.map((lvl) => {
    if (!lvl) return null;
    const kept = lvl.parts.filter((part) => boxes.some((b) => bboxOverlaps(part.bbox, b)));
    if (!kept.length) return null;
    const bbox = envelopeOf(kept);
    return bbox ? { level: lvl.level, parts: kept, bbox } : null;
  });
}

/* ── point queries ────────────────────────────────────────────────────────── */

/**
 * The bands as a SEVEREST-FIRST list of indexed levels.
 *
 * Severest first because the severest class at a point is the smallest ring
 * (the editor's `partUnder` rule): the bands are disjoint, so any order gives
 * the same answer, but this one finds it after the fewest point-in-polygon
 * tests and is the order every other module in the fleet walks classes in.
 */
export function levelIndex(bands) {
  const out = [];
  for (let i = CLASSES.length - 1; i >= 0; i--) {
    const parts = indexParts(bands?.[CLASSES[i]] ?? null);
    if (parts.length) out.push({ level: CLASSES[i], parts });
  }
  return out;
}

/** Is the point inside any of these indexed parts? bbox first, then PIP. */
export function pointInParts(parts, point) {
  const turf = T();
  for (const part of parts) {
    if (!bboxHit(part.bbox, point)) continue;
    if (turf.booleanPointInPolygon(point, { type: 'Polygon', coordinates: part.rings })) return true;
  }
  return false;
}

function bboxHit(bb, [x, y]) {
  return x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3];
}

/** The severest level covering the point in a `levelIndex`, or null. */
export function classAtIndex(index, point) {
  for (const lvl of index) {
    if (pointInParts(lvl.parts, point)) return lvl.level;
  }
  return null;
}

/**
 * What class does this proposal say is at this point?
 *
 * `'none'` means INSIDE the working area with no band over it; `null` means
 * OUTSIDE the working area, which is a different answer and callers must not
 * collapse the two — the seam sampler decides which side of a border a sample
 * fell on with exactly this distinction.
 */
export function classAt(p, point) {
  if (!pointInParts(p.aoiParts, point)) return null;
  return classAtIndex(p.bandIndex, point) ?? 'none';
}

/** The same question of the week this proposal was drawn against. */
export function publishedClassAt(p, point) {
  if (!pointInParts(p.aoiParts, point)) return null;
  return classAtIndex(p.publishedBandIndex, point) ?? 'none';
}

/**
 * Which of this proposal's patches produced a piece of ground.
 *
 * Anchor-in-piece first — cheap, and usually right, because an anchor is an
 * interior point of the patch and a region inside that patch contains it —
 * then bbox overlap plus one `booleanIntersects` for the patches the anchor
 * test missed (a region along a patch's edge, or a patch whose anchor sits in
 * a different piece of the same change).
 */
export function patchesTouching(p, geometry, bbox = null) {
  const turf = T();
  const g = asMulti(geometry);
  if (!g || !p.patches.length) return [];
  const box = bbox ?? envelopeOf(indexParts(g));
  const feature = asFeature(g);
  const parts = indexParts(g);
  const out = [];
  for (const patch of p.patches) {
    if (patch.bbox && box && !bboxOverlaps(patch.bbox, box)) continue;
    if (patch.anchor && pointInParts(parts, patch.anchor)) { out.push(patch); continue; }
    if (!patch.geometry) continue;
    if (turf.booleanIntersects(feature, asFeature(patch.geometry))) out.push(patch);
  }
  return out;
}

/* ── the change map ───────────────────────────────────────────────────────── */

/**
 * How many classes each piece of this proposal's ground moved, as polygons.
 *
 * NDMC's own published arithmetic, through the vendored `js/delta.js`: a
 * `deltas` record keyed by the ten signed steps `js/color.js` paints, and
 * `nonzero` worst-first. Memoized on the proposal — it is two partitions and
 * thirty intersections, so a card that opens twice pays once.
 */
export function changeMap(p) {
  return p.changeMap;
}

/**
 * The worst thing the change map says about ONE patch — "2-class degradation".
 *
 * The seam a change card reads through: `pkg.proposedChanges[].classes` already
 * says WHICH classes moved under a patch and which way, and this says how far.
 * Ties go to degradation, and the answer comes from the first diagonal that
 * intersects the patch, walked worst-first — all of that is the vendored
 * `worstDeltaWithin`'s, not restated here.
 *
 * @returns {{delta:number, step:string, label:string}|null} null when the patch
 *          meets no nonzero diagonal, which is what an edit that reshapes a
 *          boundary without moving a class across it looks like.
 */
export function worstDeltaFor(p, patch) {
  if (!patch?.geometry) return null;
  return worstDeltaWithin(patch.geometry, p.changeMap.deltas);
}

/* ── integrity ────────────────────────────────────────────────────────────── */

/**
 * Does a package agree with itself — and IF NOT, by how much?
 *
 * The question is the mutual-containment loop of the vendored `verifyPackage`
 * (js/submit.js): for every edited class, the contour rebuilt from
 * `derivedBands` and the contour shipped in `changes[].after` must contain
 * each other. The ANSWER is graded by magnitude, with the two-channel test
 * `validateDerivedBands` already uses for band overlap:
 *
 *   escaped ≤ 100 m² (CONTAINMENT_TOLERANCE_M2) → not a problem at all
 *   escaped ≤ 1 km² AND mean width ≤ 50 m       → 'residue'
 *   anything else                                → 'defect'
 *
 * THE GRADING IS NOT A NICETY. Measured over the ten original example
 * packages: eight fail the flat rule, every failure under 1 km² and under 10 m
 * wide — clipper residue that `deriveBands` drops below `MIN_PART_AREA_M2` and
 * that the `deriveContours` round trip cannot put back. Worst measured here:
 * 0.9840 km² at 1.7 m (SD-f3f094e2) and 0.9493 km² at 9.1 m (MT-853adab3);
 * over all twelve, two pass and ten are residue. A tool that told a reviewer
 * eight of ten reference proposals were "hand-edited or produced by a
 * different version" would be worse than no tool.
 *
 * ── WHERE THE BAR LIVES, and why it is not here ────────────────────────────
 * docs/contracts.md § 2 puts this function in this module and § 11 makes
 * `js/recheck.js` "a thin wrapper over checkIntegrity". It is written the
 * other way round, deliberately and with WP-D: `recheckPackage` holds the one
 * copy of the magnitude bar, the residue/defect split and the sentence, and
 * this is the § 2 façade over it. Two copies of a measured threshold drift,
 * and the one that drifts is always the one nobody is looking at. The § 2
 * SHAPE is unchanged — `grade`, `problems`, `largestKm2`, `escapedKm2` are all
 * here — with `recheckPackage`'s richer fields carried alongside rather than
 * thrown away.
 *
 * Measured cost, twelve example packages: 123–663 ms each, dominated by
 * `verifyPackage`'s own two gates. It is LAZY for that reason — the drawer
 * lists a proposal without it.
 *
 * @returns {{grade: 'pass'|'residue'|'defect', problems: object[],
 *            residue: object[], largestKm2: number, escapedKm2: number,
 *            residueKm2: number, residueWidestM: number, ok: boolean,
 *            sentence: string, gates: object|null}}
 */
export function checkIntegrity(p) {
  return p.integrity;
}

function gradeIntegrity(pkg) {
  let r;
  try {
    r = recheckPackage(pkg);
  } catch (err) {
    /* A package this app parsed but the re-check threw on is a defect, and it
       says so with the throw's own words. Returning `pass` on an exception is
       the one answer that would be a lie. */
    return Object.freeze({
      grade: 'defect', ok: false,
      problems: Object.freeze([Object.freeze({
        message: `The package could not be re-checked: ${err.message}`,
        class: null, areaKm2: null, widthM: null, geometry: null,
      })]),
      residue: Object.freeze([]),
      largestKm2: 0, escapedKm2: 0, residueKm2: 0, residueWidestM: 0,
      sentence: `Re-check: the package could not be read — ${err.message}`,
      gates: null,
    });
  }
  /* `escapedKm2` is § 2's name for the TOTAL that left its contour: the
     residue sum plus whatever the problems carry. On a residue-graded package
     it equals `residueKm2`, which is the number the sentence quotes, and
     tools/recheck.test.mjs pins the two readings against each other. */
  const problemKm2 = r.problems.reduce((a, x) => a + (x.areaKm2 ?? 0), 0);
  return Object.freeze({
    grade: r.grade,
    ok: r.ok,
    problems: Object.freeze(r.problems),
    residue: Object.freeze(r.residue),
    largestKm2: r.largestKm2,
    escapedKm2: r.residueKm2 + problemKm2,
    residueKm2: r.residueKm2,
    residueWidestM: r.residueWidestM,
    sentence: r.sentence,
    gates: r.gates ?? null,
  });
}

/* ── the id grammar's hash ────────────────────────────────────────────────── */

/**
 * FNV-1a (32-bit), lowercase hex, eight digits — docs/contracts.md § 8.
 *
 * It lives here because it is the one thing a region and a seam share and both
 * of those modules already import this one; putting it in either would make
 * the other import a sibling and turn the engine's one-way import direction
 * into a diamond.
 *
 * Not collision-proof, deliberately: a finding id travels in a URL and eight
 * hex is short enough to paste into a chat window. The session resolves the
 * collisions it can actually see, by rank (`resolveFindingIds` in
 * js/session.js).
 */
export function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** `disc:1a2b3c4d` / `seam:1a2b3c4d` from the readable key that was hashed. */
export function findingId(prefix, key) {
  return `${prefix}:${hashOf(key)}`;
}

/** The four bbox numbers at a thousandth of a degree — ~100 m, far below the
 *  smallest region kept and far above float noise. Part of every region key. */
export function bboxKey(bbox) {
  return bbox.map((n) => n.toFixed(3)).join(',');
}
