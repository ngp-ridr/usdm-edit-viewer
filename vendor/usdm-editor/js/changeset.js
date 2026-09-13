/* ============================================================================
   USDM Editor · js/changeset.js
   The edit model: a working area, the contours inside it, what the author has
   changed, and how that folds back into the national geometry.

   DOM-free, like js/topology.js and js/heuristic.js — persistence is injected,
   not imported, so the same model runs under Node in a test.

   The editor never works on the nation (union/difference there is ~6.0/7.5 s;
   see js/topology.js's header): it clips to a working area in milliseconds,
   edits and validates there, and folds back once at package time.

   A working area is an AOI record `{ geometry?, bbox, kind?, id?, name? }`
   (`normalizeAOI` accepts a bare bbox, bit-identical to the old extents; a
   missing `geometry` MEANS "this area is its rectangle" — the clip, the fold
   and the escape guard all branch on that one field).

   THE FOLD: `applyToNational()` rebuilds each class as (far parts) ∪ (near
   parts ∖ the working area) ∪ (edited geometry), one union, which dissolves
   the clip's own cut-line kinks as it joins. Two measured traps live in the
   middle term: discarding near parts instead of subtracting costs real
   geometry outside the area (52,000 D0 vertices, every containment pair
   broken), and subtracting the AOI's BBOX instead of its polygon deletes
   drought the author was never shown (Montana's envelope reaches three other
   states). The fold is topologically exact, not bit-exact: same parts always
   (worst area drift 0.19–0.22 km² on a 2.3M-km² contour for a bbox cut,
   0.0001–0.0055 km² for the state polygon), and a polygon cut can leave
   hairline interior rings (≤3,867 m², vs 0.4 km² for the smallest real hole —
   separable by area, which is how § 10b asserts every real hole survived and
   § 7c holds the rectangle to holes exactly).
   ========================================================================== */

import {
  CLASSES, asMulti, asFeature, areaKm2, tally, indexParts, ringBBox, bboxOverlaps, envelopeOf,
  clipToAOI, healContours, deriveBands, despike, validateContours, validateDerivedBands,
  T, ruleContainedIn, CONTAINMENT_TOLERANCE_M2, partsNear,
  unionNear, differenceNear, intersectNear, changedBBoxRegion, cascadeContainment,
} from './topology.js';

const clone = (x) => (x == null ? null : JSON.parse(JSON.stringify(x)));

/* Below this, a residual diff is clipper noise and a reset may snap the class
   to the baseline object verbatim (see `resetShape`). One square metre: the
   measured hairline residue this exists for was ~16,000 m², the smallest
   reportable patch is 10,000 m², and a real sub-1 m² edit cannot be drawn. */
const RESET_EXACT_M2 = 1;

/**
 * Open a working area over a week's archive contours.
 *
 * @param {object} contours  {D0..D4} national archive geometries — NESTED
 *        cumulative contours as the archive publishes them (js/archive.js
 *        heals them, but this function heals again: the engine is the deferred
 *        server-side gate and does not trust its caller to have nested them)
 * @param {object|number[]} [aoi]  the working area:
 *        `{ geometry?, bbox, kind?, id?, name? }`, or a bare `[w,s,e,n]`
 * @param {number[]} [bbox] the ORIGINAL call shape, still supported verbatim —
 *        equivalent to `aoi: { bbox }`, i.e. a rectangular working area
 * @param {object} [meta] free-form provenance carried into the package
 */
export function createChangeset({ contours, aoi, bbox, meta = {} } = {}) {
  if (!contours) throw new Error('[usdm/changeset] no contours');

  /* One record from here on. `aoi` wins when both are given, because a caller
     that passes both is a caller mid-migration handing over the AOI's envelope
     alongside the AOI itself. */
  const area = normalizeAOI(aoi ?? bbox);

  /* What gets SUBTRACTED at fold time and what an edit must stay inside. For a
     polygon AOI that is the AOI; for a rectangle it is the rectangle, built
     here once so that neither `applyToNational` nor the escape guard has to ask
     which kind of working area this is. */
  const aoiPolygon = area.geometry ? asFeature(area.geometry) : extentPolygon(area.bbox);

  /* Index once. 2,068 parts (the masked product) cost ~25 ms here and turn
     every later working-area question into a bounding-box scan. */
  const index = Object.fromEntries(CLASSES.map((c) => [c, contours[c] ? indexParts(contours[c]) : []]));

  const clippedContours = Object.fromEntries(
    CLASSES.map((c) => [c, index[c].length ? clipToAOI(index[c], area.geometry, area.bbox) : null]));

  /* ── Nesting, then AOI-boundary hygiene, applied ONCE, at the one point the
     whole set is built. `healContours` is the suffix union — a no-op on rows
     already nested, the repair when a caller hands in the archive's raw leaky
     ones. Its union re-emits the AOI's own boundary slightly OUTSIDE it
     (measured: D0 by 3,227 m², D1 3,148, D2 373 on Montana) — noise on a line
     no author can reach, but enough to make `assertInsideAOI` refuse an
     unmodified baseline, and cleaning one class while leaving another breaks
     containment because the hairlines are nested (§ 12c). Re-clipping the
     healed contours costs 20 ms once and moves ~0.0024 km² on a 358,609 km²
     contour, all outside the claimed jurisdiction. SKIPPED for a rectangle:
     `clipToExtent` is exact there, and every bbox caller must keep the bytes
     it shipped with. */
  const derivedBaseline = healContours(clippedContours);
  const baseline = area.geometry
    ? Object.fromEntries(CLASSES.map((c) => [c, derivedBaseline[c]
        ? clipToAOI(indexParts(derivedBaseline[c]), area.geometry, area.bbox) : null]))
    : derivedBaseline;
  let working = clone(baseline);
  let baselineBandsMemo = null;

  /* ── The version counter and the memos it guards ─────────────────────────
     `working` is written at exactly five sites — `applyEntry` (undo/redo),
     `setContour`, `finishCascade` (the tail every cascading op shares),
     `revert` and `restoreSnapshot` — and every one of them calls `touch()`,
     which bumps `version` and drops the four memos below. Nothing else may
     assign `working`; a write that forgets `touch()` serves a stale check
     over moved geometry, which is the one failure this design cannot see.

     WHY: one committed vertex drag used to run the whole rule sweep three or
     four times and `deriveBands` as often (the Checks panel, the wizard's
     step-4 gate from two `refresh()` calls, the band mask, the fills) — on the
     unsimplified FSA boundary that was most of a second of duplicated boolean
     work per commit. The readers all want the same answer for the same
     `working`, so the answer is computed once per version and handed out.
     Readers never mutate what they are handed. `stats` records how long each
     memo took to build, for `__usdm.lastCommitBreakdown`. */
  let version = 0;
  let validateMemo = null, bandsMemo = null, diffsMemo = null, regionMemo = null;
  const stats = { validateMs: 0, bandsMs: 0, diffsMs: 0 };
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  function touch() {
    version++;
    validateMemo = bandsMemo = diffsMemo = regionMemo = null;
  }

  /* ── The undo model ───────────────────────────────────────────────────────
     Entries are TAGGED, and the tag decides how much geometry gets copied.
     Almost every edit touches exactly one class, so `kind:'class'` records that
     one class's prior geometry and nothing else. The alternative — the shape
     this shipped with — deep-cloned all five contours on every keystroke-sized
     nudge; Montana's D0 alone is 59,802 vertices, so a session's worth of
     vertex drags carried the whole working extent per step. Only genuinely
     multi-class operations (`revert`, `restoreSnapshot`) pay for `kind:'full'`.

     `wasDirty` is recorded at PUSH time and replayed verbatim. Dirty means "the
     author touched this class", not "this class differs from its baseline" —
     an author who drags a vertex and drags it back has still edited D2, and the
     review screen must keep saying so. Recomputing it on restore would quietly
     redefine it.

     Both stacks are bounded. `undoStack` is capped at UNDO_CAP; `redoStack`
     needs no cap of its own because it is cleared by every new edit and can
     only ever grow one entry per undo. */
  const UNDO_CAP = 50;
  const undoStack = [];
  const redoStack = [];
  let dirty = new Set();

  /* After the cap evicts the oldest entries, exhausting undo no longer lands
     on a pristine extent — `isDirty` can still be true with nothing left to
     undo. That is correct and unavoidable: the evicted steps are gone. It is
     also not a trap, because `baseline` is never mutated, so `revert()` always
     returns the extent to the archive no matter how deep the history went. */
  function pushUndo(entry) {
    undoStack.push(entry);
    if (undoStack.length > UNDO_CAP) undoStack.shift();
  }

  /** One class's current geometry and dirty membership, for the stack. */
  function classEntry(label, usdmClass) {
    return {
      kind: 'class', label, cls: usdmClass,
      geometry: clone(working[usdmClass]),
      wasDirty: dirty.has(usdmClass),
    };
  }

  /** The whole working extent, for operations that move more than one class. */
  function fullEntry(label) {
    return { kind: 'full', label, working: clone(working), dirty: new Set(dirty) };
  }

  /** The entry that would undo the state an entry is about to overwrite. */
  function mirrorEntry(e) {
    return e.kind === 'class' ? classEntry(e.label, e.cls) : fullEntry(e.label);
  }

  /* Clone on the way OUT of the stack, not just in. The `contours` getter hands
     callers the live `working` object — js/editor.js reads it straight into
     Terra Draw's store, js/app.js writes it into a draft — so an entry restored
     by reference would leave stack and live state sharing structure, and every
     later restore of the same class would then be one mutation away from the
     history it is supposed to be independent of. Cheap insurance: a restore
     happens on a keypress, not in a loop. */
  function applyEntry(e) {
    if (e.kind === 'class') {
      working[e.cls] = clone(e.geometry);
      if (e.wasDirty) dirty.add(e.cls); else dirty.delete(e.cls);
      touch();
      return;
    }
    working = clone(e.working);
    dirty = new Set(e.dirty);
    touch();
  }

  /* ── The AOI escape guard: a THROW, not a clip. The baseline was already cut
     to the AOI, so anything outside it arrived by author action — and clipping
     it away discards work silently while keeping it writes drought into a
     jurisdiction nobody reviewed. SKIPPED for a rectangle (every bbox caller
     pushes geometry to the box edge and keeps that contract). Tolerance is the
     containment rule's 100 m², for the clipper's coincident-edge hairlines. */
  function assertInsideAOI(usdmClass, geometry) {
    if (!area.geometry || !geometry) return;
    const r = ruleContainedIn(geometry, aoiPolygon.geometry, {
      toleranceM2: CONTAINMENT_TOLERANCE_M2,
      innerLabel: usdmClass,
      outerLabel: 'the working area' + (area.name ? ` (${area.name})` : ''),
    });
    if (!r.ok) throw new Error(`[usdm/changeset] ${r.message}`);
  }

  /* ── AOI-boundary hygiene for geometry the TOOLS produce ──────────────────
     Every boolean op re-emits the AOI boundary a little way outside it (see the
     baseline block above), so everything an op PRODUCES is clipped back. Not
     the forbidden "silently moving the author's vertices": the excess is
     clipper noise on a line the author cannot reach, the drawn shape is clipped
     visibly by `clipShape` first (or the op refuses), and committed VERTICES
     never pass through here — `setContourCascading` holds them to
     `assertInsideAOI` unclipped. Same class of normalization as `asMulti()`.
     5–20 ms on near-parts geometry; a no-op for a bbox working area. */
  function tidy(geometry) {
    if (!area.geometry || !geometry) return geometry;
    return clipToAOI(indexParts(geometry), area.geometry, area.bbox);
  }

  /** G5: an author's drawn shape, cut to the working area. Null = all outside. */
  function clipShape(shape) {
    const m = asMulti(shape);
    if (!m) return null;
    return clipToAOI(indexParts(m), area.geometry, area.bbox);
  }

  /** What an op returns when the drawn shape misses the working area entirely. */
  function outsideWorkingArea(label) {
    return {
      applied: false, healed: [], label,
      reason: `That area is outside the working area${area.name ? ` (${area.name})` : ''}.`,
    };
  }

  /**
   * The tail every cascading op shares: run the cascade, fold the healed
   * classes into `dirty`, write the final label into the entry that was already
   * pushed, and report.
   *
   * The label is written AFTER the fact because the entry has to be pushed
   * before any geometry moves — an op that throws halfway must leave the state
   * it can be undone to — and the healed classes are not known until the
   * cascade has run.
   */
  function finishCascade(entry, touched, cascadeOpts, label) {
    /* FIRST, before the cascade: every caller has already written `working`,
       and a throw inside `cascadeContainment` must not leave a memo standing
       over geometry that moved. */
    touch();
    const r = cascadeContainment(working, { clean: tidy, ...cascadeOpts });
    working = r.contours;
    for (const c of touched) dirty.add(c);
    for (const h of r.healed) dirty.add(h.usdmClass);
    const finalLabel = r.healed.length
      ? `${label} (+ ${[...new Set(r.healed.map((h) => h.usdmClass))].join(', ')} adjusted)`
      : label;
    entry.label = finalLabel;
    return { applied: true, healed: r.healed, label: finalLabel };
  }

  const api = {
    bbox: area.bbox, meta,

    /** The normalized working area: `{ kind, id, name, geometry, bbox }`. */
    get aoi() { return area; },

    /**
     * The working area as a turf Feature — the AOI polygon when there is one,
     * the extent rectangle when there is not. This is what gets subtracted at
     * fold time, and what an edit is held inside.
     */
    get aoiPolygon() { return aoiPolygon; },

    get baselineContours() { return baseline; },
    get contours() { return working; },
    get editedClasses() { return [...dirty]; },
    get isDirty() { return dirty.size > 0; },

    /**
     * The working area's baseline as DISJOINT BANDS — `deriveBands` over the
     * baseline contours, memoized (~15 ms per state). The published view paints
     * from this (js/app.js `renderEditBands`), and paint needs one class per
     * pixel; the archive's rows are nested and would not give it that.
     */
    get baselineBands() { return (baselineBandsMemo ??= deriveBands(baseline)); },

    /** Bumped by every write to `working`; the key every memo below is good for. */
    get version() { return version; },
    /** Build times of the memos, ms — read by js/app.js for `__usdm`. */
    get stats() { return { ...stats }; },

    /**
     * The WORKING extent as disjoint bands — `deriveBands(contours)`, memoized
     * per version. The edited fills paint from this (js/app.js
     * `renderEditBands`), the band mask reads its one reachable band, the
     * thread detector compares bands, and `summary()` measures them; before
     * the memo each of those derived its own copy on every commit.
     */
    get bands() {
      if (!bandsMemo) {
        const t0 = now();
        bandsMemo = deriveBands(working);
        stats.bandsMs = Math.round(now() - t0);
      }
      return bandsMemo;
    },

    /**
     * `perClassDiffs(baseline, working, area)` — the ten added/removed pieces,
     * memoized per version. `derivePatches` and `deriveThreads` (js/changes.js)
     * both start from exactly this and used to compute it twice.
     */
    get diffs() {
      if (!diffsMemo) {
        const t0 = now();
        diffsMemo = perClassDiffs(baseline, working, area);
        stats.diffsMs = Math.round(now() - t0);
      }
      return diffsMemo;
    },

    /** `mergedDiffRegion(diffs)`: everything that changed, dissolved; null when nothing did. */
    get changedRegion() {
      if (regionMemo === null) regionMemo = { value: mergedDiffRegion(api.diffs) };
      return regionMemo.value;
    },

    /**
     * Replace one class's contour with edited geometry.
     *
     * Pushes an undo entry and marks the class dirty. Validation is mostly the
     * caller's business — Terra Draw validates the feature being dragged
     * (topology.validateEditedFeature) and this model validates the whole
     * working area afterwards (`validate()`), which are different questions.
     *
     * The ONE thing checked here is escape from a polygon AOI, because it is
     * the one thing this model can neither represent nor undo: see
     * `assertInsideAOI`. It throws before touching the undo stack, so a
     * rejected edit leaves no history behind.
     */
    setContour(usdmClass, geometry, { label = 'edit' } = {}) {
      if (!CLASSES.includes(usdmClass)) throw new Error(`[usdm/changeset] unknown class ${usdmClass}`);
      const next = asMulti(geometry);
      assertInsideAOI(usdmClass, next);
      pushUndo(classEntry(label, usdmClass));
      redoStack.length = 0;
      working[usdmClass] = next;
      dirty.add(usdmClass);
      touch();
      return api;
    },

    /* ══ The cascading editing ops ═══════════════════════════════════════════
       Operations that may move MORE THAN ONE class (contours are cumulative:
       widening D2 widens D1 with it). Each is ONE `kind:'full'` undo entry and
       returns `{ applied, healed, label, reason? }`. `stepDownShape` /
       `stepUpShape` are the pair the editor's two verbs are built from (a
       scoped verb is the same primitive over a `bandClip`ped operand); the
       absolute ops survive as the honest primitives for the draft restore and
       the tests, and are reachable from nothing in the UI.

       Dirty bookkeeping splits on purpose: the whole-set ops compute which
       classes actually MOVED before marking, the single-class ops mark their
       named class unconditionally — different questions, do not unify. And
       they stay SEPARATE METHODS from `setContour`, whose one-entry/one-class/
       caller-validates contract the draft restore, verify and the session
       hydrate all depend on. `validate()` is NOT relaxed: § 13e holds that
       line on the same square verify § 3 asserts the rejection of.
       ═══════════════════════════════════════════════════════════════════════ */

    /**
     * Replace one class's contour with edited geometry, then repair the
     * containment invariant by moving its neighbours.
     *
     * @param {string} usdmClass
     * @param {object} geometry the author's (Multi)Polygon
     * @param {object} [opts]
     * @param {string} [opts.label] undo label; healed classes are appended to it
     * @returns {{applied: boolean, healed: object[], label: string}}
     */
    setContourCascading(usdmClass, geometry, { label = 'edit' } = {}) {
      if (!CLASSES.includes(usdmClass)) throw new Error(`[usdm/changeset] unknown class ${usdmClass}`);
      const next = asMulti(geometry);

      /* A commit that changed nothing is a plain `setContour`, and delegating
         keeps undo granularity honest: a no-op does not deserve a full-extent
         entry, and there is nothing for a cascade to find. */
      const region = changedBBoxRegion(working[usdmClass], next);
      if (!region) {
        api.setContour(usdmClass, geometry, { label });
        return { applied: true, healed: [], label };
      }

      /* The author's own vertices, held to the same boundary `setContour` holds
         them to, and thrown before the undo stack moves. NOT put through
         `tidy` — see its comment. */
      assertInsideAOI(usdmClass, next);
      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;
      working[usdmClass] = next;
      return finishCascade(entry, [usdmClass], { editedClass: usdmClass, region }, label);
    },

    /**
     * Union a drawn shape into one class, then cascade.
     *
     * The change region is known EXACTLY here — it is the clipped shape — so
     * the cascade is narrowed by `S` itself rather than by a part-hash bbox
     * superset. Tighter and cheaper both.
     */
    addShape(usdmClass, shape, { label = `add ${usdmClass} area` } = {}) {
      if (!CLASSES.includes(usdmClass)) throw new Error(`[usdm/changeset] unknown class ${usdmClass}`);
      const S = clipShape(shape);
      if (!S) return outsideWorkingArea(label);
      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;
      /* A class with no contour yet simply becomes the shape — which is how
         drawing D3 over bare ground is meant to read. */
      working[usdmClass] = tidy(working[usdmClass] ? unionNear(working[usdmClass], S) : clone(S));
      return finishCascade(entry, [usdmClass], { editedClass: usdmClass, region: S }, label);
    },

    /**
     * Subtract a drawn shape from one class, then cascade.
     *
     * One primitive, two gestures: a shape drawn INSIDE a part reads as cutting
     * a hole, one drawn over its edge reads as erasing. The caller supplies the
     * label that says which.
     *
     * Subtracting everything leaves the class null, and the cascade then removes
     * whatever severer classes were orphaned by it.
     */
    subtractShape(usdmClass, shape, { label = `erase ${usdmClass} area` } = {}) {
      if (!CLASSES.includes(usdmClass)) throw new Error(`[usdm/changeset] unknown class ${usdmClass}`);
      const S = clipShape(shape);
      if (!S) return outsideWorkingArea(label);
      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;
      working[usdmClass] = working[usdmClass] ? tidy(differenceNear(working[usdmClass], S)) : null;
      return finishCascade(entry, [usdmClass], { editedClass: usdmClass, region: S }, label);
    },

    /**
     * Put one area back to what the archive published — across ALL classes.
     *
     * Per class: `union( working ∖ S , baseline ∩ S )`. Keep what the author has
     * outside the shape, take what the archive has inside it, and let the union
     * dissolve the seam along ∂S. Both halves are bbox-narrowed, so the cost is
     * local to the shape rather than to the class.
     *
     * The repair afterwards is `sweepAll` — grow-milder-only. The seam can
     * strand a severer part the author KEPT over milder ground that has just
     * been reset to published; growing the milder class preserves the kept
     * edit, while trimming the severer one would destroy work lying outside the
     * area the author asked to reset. See `cascadeContainment`.
     *
     * `dirty` gains only the classes whose geometry actually MOVED near the
     * shape — a part-hash comparison against the baseline, taken before
     * anything is written. Every class is rewritten (a class untouched near `S`
     * comes back as its own far parts, unchanged), but marking all five edited
     * because one of them was reset would put four classes the author never
     * touched into the review badge.
     */
    resetShape(shape, { label = 'reset area to published' } = {}) {
      const S = clipShape(shape);
      if (!S) return outsideWorkingArea(label);
      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;

      /* Empty FOR RESET PURPOSES: nothing, or hairline noise under one square
         metre — four orders of magnitude below the smallest reportable patch. */
      const gone = (g) => !g || areaKm2(asMulti(g)) * 1e6 < RESET_EXACT_M2;

      const moved = [];
      for (const c of CLASSES) {
        const before = working[c];
        if (changedBBoxRegion(partsNear(before, S), partsNear(baseline[c], S))) moved.push(c);
        if (!before && !baseline[c]) continue;

        /* REBUILT FROM THE BASELINE plus the author's diffs that survive
           OUTSIDE S — never unstitched from the working geometry. The old
           formulation, (working ∖ S) ∪ (baseline ∩ S), is algebraically
           identical and numerically not: against the unsimplified FSA
           boundary, ∂S rides thousands of coincident boundary vertices and
           the difference/union pair left ~16,000 m² of hairline residue
           (measured, 2026-09) — a phantom "0 km²" patch the author could
           neither see nor remove. The DIFFS, by contrast, subtract from S to
           exactly empty (S was derived from them), so a class whose every
           change lay inside S snaps back to the BASELINE OBJECT VERBATIM —
           "remove the only change" is exact by construction. A class with
           other changes keeps them: baseline minus the removals that survive,
           union the additions that survive. */
        const added = before && baseline[c] ? differenceNear(before, baseline[c]) : before;
        const removed = before && baseline[c] ? differenceNear(baseline[c], before) : baseline[c];
        const addedKeep = added ? differenceNear(added, S) : null;
        const removedKeep = removed ? differenceNear(removed, S) : null;
        if (gone(addedKeep) && gone(removedKeep)) {
          working[c] = baseline[c] ? clone(baseline[c]) : null;
          continue;
        }
        const kept = removedKeep && !gone(removedKeep)
          ? differenceNear(baseline[c], removedKeep) : baseline[c];
        working[c] = tidy(kept && addedKeep ? unionNear(kept, addedKeep) : (kept || addedKeep));
      }
      return finishCascade(entry, moved, { region: S, sweepAll: true }, label);
    },

    /**
     * Improve every class inside a drawn shape by exactly ONE step.
     *
     * Per class, reading `contour[D5]` as empty:
     *
     *     contour′[n] = ( contour[n] ∖ S ) ∪ ( contour[n+1] ∩ S )
     *
     * Inside `S`, D4 becomes D3, D3 becomes D2, and band D0 — which is in
     * `contour[D0]` and nothing severer — drops out altogether. Outside `S`
     * nothing moves.
     *
     * One primitive behind three gestures — a hole cut, an edge erased, a
     * split along a buffered line — all meaning "this ground got one class
     * better". Every class reads from a SNAPSHOT: `next[n]` reads
     * `before[n+1]`, and writing into `working` mid-loop would feed each class
     * its neighbour's already-stepped geometry, walking the stack down one
     * further class per iteration.
     *
     * CONTAINMENT HOLDS BY CONSTRUCTION: given c[n+1] ⊆ c[n], both terms of
     * contour′[n+1] are subsets of contour′[n]'s, so the nesting survives in
     * exact arithmetic. The `sweepAll` tail is therefore defensive, against
     * clipper hairlines on ∂S only (grow-milder — never putting a severer
     * class back over ground this op just improved); `healed` is expected
     * empty, asserted on a real week by § 16.
     */
    stepDownShape(shape, { label = 'improve the drawn area by one class' } = {}) {
      const S = clipShape(shape);
      if (!S) return outsideWorkingArea(label);

      /* Nothing to improve. Refused BEFORE the undo stack moves, so a gesture
         over drought-free ground leaves no history behind to press Undo
         through — the same contract `outsideWorkingArea` keeps. */
      if (!intersectNear(working.D0, S)) {
        return {
          applied: false, healed: [], label,
          reason: 'There is no drought in that area to improve.',
        };
      }

      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;

      const before = working;
      const next = {};
      const moved = [];
      for (let i = 0; i < CLASSES.length; i++) {
        const c = CLASSES[i];
        const severer = i + 1 < CLASSES.length ? before[CLASSES[i + 1]] : null;
        const kept = differenceNear(before[c], S);
        const stepped = severer ? intersectNear(severer, S) : null;
        next[c] = tidy(kept && stepped ? unionNear(kept, stepped) : (kept || stepped));
        if (changedBBoxRegion(partsNear(before[c], S), partsNear(next[c], S))) moved.push(c);
      }
      working = next;
      return finishCascade(entry, moved, { region: S, sweepAll: true }, label);
    },

    /**
     * Degrade every class inside a drawn shape by exactly ONE step — the exact
     * mirror of `stepDownShape`.
     *
     * Per class, reading `contour[−1]` as the whole working area:
     *
     *     contour′[n] = contour[n] ∪ ( contour[n−1] ∩ S )
     *
     * Inside `S`, drought-free ground becomes D0, D0 becomes D1, D3 becomes D4,
     * and D4 stays D4 — nothing is severer for it to step into. Outside `S`
     * nothing moves.
     *
     * The D0 term is `S` ITSELF: `contour[−1] ∩ S = S` because `S` has already
     * been through `clipShape` — an explicit intersection would buy the same
     * answer and quietly become a different one if clipShape ever stopped
     * clipping. Classes read from a SNAPSHOT for stepDownShape's mirror reason,
     * and containment again holds by construction (both terms of contour′[n+1]
     * are subsets of contour′[n]'s), leaving `sweepAll` defensive against ∂S
     * clipper hairlines only. NO "nothing to degrade" refusal, deliberately:
     * drought-free ground becoming D0 is what this op is FOR, so no state of
     * the map makes a degrade meaningless.
     */
    stepUpShape(shape, { label = 'degrade the drawn area by one class' } = {}) {
      const S = clipShape(shape);
      if (!S) return outsideWorkingArea(label);

      const entry = fullEntry(label);
      pushUndo(entry);
      redoStack.length = 0;

      const before = working;
      const next = {};
      const moved = [];
      for (let i = 0; i < CLASSES.length; i++) {
        const c = CLASSES[i];
        /* i === 0 is the `contour[−1] ∩ S = S` case above. */
        const milder = i > 0 ? before[CLASSES[i - 1]] : null;
        const promoted = i === 0 ? S : (milder ? intersectNear(milder, S) : null);
        next[c] = tidy(before[c] && promoted
          ? unionNear(before[c], promoted)
          : (before[c] || clone(promoted)));
        if (changedBBoxRegion(partsNear(before[c], S), partsNear(next[c], S))) moved.push(c);
      }
      working = next;
      return finishCascade(entry, moved, { region: S, sweepAll: true }, label);
    },

    /**
     * Cut a drawn shape down to the ONE band where applying `direction` to
     * `usdmClass` is a one-class move — the operand a single-class extend or
     * erase is allowed to act on.
     *
     * What makes a scoped verb honest without a rule that can be got wrong:
     *
     *     erase  D_n :  S ∩ ( contour[n]   ∖ contour[n+1] )
     *     extend D_n :  S ∩ ( contour[n−1] ∖ contour[n]   )
     *
     * (`contour[−1]` = the working area, `contour[5]` = empty). Handing the
     * result to the step ops makes the one-class rule true BY CONSTRUCTION —
     * and exactly equivalent to the absolute ops over the same operand, which
     * § 19 asserts; the stepped forms are used because they CANNOT skip a
     * class even on a wrong operand.
     *
     * Returns null when the shape reaches none of that band — and NOTHING
     * ELSE. It deliberately does NOT clip to the working area: the primitive
     * it feeds already does, so refusal is worded in one place, and callers
     * that must tell "missed the band" from "missed the working area" apart
     * ask `reachesWorkingArea` (different mistakes, different fixes). Operand
     * order is for cost: the many-part CLASS goes in as the side pruned by
     * the shape's bbox.
     */
    bandClip(shape, usdmClass, direction) {
      if (!CLASSES.includes(usdmClass)) throw new Error(`[usdm/changeset] unknown class ${usdmClass}`);
      if (direction !== 'extend' && direction !== 'erase') {
        throw new Error(`[usdm/changeset] bandClip direction must be extend or erase, got ${direction}`);
      }
      const S = asMulti(shape);
      if (!S) return null;

      const i = CLASSES.indexOf(usdmClass);
      /* The band's outer edge, then the hole the next class in punches in it.
         `outer === undefined` marks the `contour[−1]` case — extending D0, where
         the outer edge is the whole working area and so cuts nothing. */
      const outer = direction === 'erase'
        ? working[usdmClass]
        : (i > 0 ? working[CLASSES[i - 1]] : undefined);
      const inner = direction === 'erase'
        ? (i + 1 < CLASSES.length ? working[CLASSES[i + 1]] : null)
        : working[usdmClass];

      /* `S ∖ contour[n]` for extending D0: every point of the shape that is not
         already in the class. The step op clips the result to the AOI. */
      const onBand = outer === undefined ? S : (outer ? intersectNear(outer, S) : null);
      if (!onBand) return null;
      return inner ? differenceNear(onBand, inner) : onBand;
    },

    /**
     * Does any of this shape lie inside the working area?
     *
     * The cheap half of `clipShape`, exposed because `bandClip` returning null
     * is ambiguous between "missed the band" and "missed the working area" and
     * the two need different sentences. Boolean rather than geometry, so a
     * caller cannot be tempted to edit with it.
     */
    reachesWorkingArea(shape) {
      return clipShape(shape) !== null;
    },

    /**
     * The refusal an op returns for a shape outside the working area, exposed so
     * that a caller which refuses on its own account can still use the model's
     * wording. One sentence, one place; it names the working area, which is the
     * only part an author can act on.
     */
    outsideWorkingArea(label) {
      return outsideWorkingArea(label);
    },

    undo() {
      const e = undoStack.pop();
      if (!e) return false;
      redoStack.push(mirrorEntry(e));
      applyEntry(e);
      return true;
    },
    redo() {
      const e = redoStack.pop();
      if (!e) return false;
      pushUndo(mirrorEntry(e));
      applyEntry(e);
      return true;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },

    /** Throw the whole working area back to the archive. */
    revert() {
      pushUndo(fullEntry('revert all'));
      redoStack.length = 0;
      working = clone(baseline);
      dirty = new Set();
      touch();
      return api;
    },

    /**
     * Replace the whole working extent at once — a saved draft, a checkpoint.
     *
     * This exists because the obvious alternative, a `setContour` loop over the
     * saved classes, gets two things wrong. It can only ever ADD to `dirty`, so
     * a class the author edited since the checkpoint stays marked edited and
     * keeps its post-checkpoint geometry; and it pushes one undo entry per
     * class, so undoing a restore takes as many presses as the draft had
     * classes. One `kind:'full'` entry holding the PRE-restore state makes the
     * whole restore exactly one step, in both directions.
     *
     * A checkpoint is also the one way geometry from ANOTHER working area can
     * reach this one — a session file names its AOI but a caller can still hand
     * over the wrong contours — so every class is put through the same escape
     * guard `setContour` uses, before anything is assigned.
     *
     * @param {object} contours       {D0..D4} geometries; missing/null = empty
     * @param {string[]} editedClasses which classes the checkpoint had touched
     */
    restoreSnapshot({ contours, editedClasses, label = 'restore checkpoint' } = {}) {
      if (!contours || typeof contours !== 'object') {
        throw new Error('[usdm/changeset] restoreSnapshot needs a contours object');
      }
      if (!Array.isArray(editedClasses)) {
        throw new Error('[usdm/changeset] restoreSnapshot needs editedClasses as an array');
      }
      for (const c of editedClasses) {
        if (!CLASSES.includes(c)) throw new Error(`[usdm/changeset] unknown class ${c}`);
      }
      /* Rebuild every class, not just the ones the snapshot names — a class
         absent from the snapshot must come back EMPTY, and assigning over the
         existing `working` would leave whatever the author has drawn there.

         Built and checked BEFORE the undo entry is pushed, so a snapshot that
         is rejected halfway through leaves neither geometry nor history: a
         restore either happens whole or does not happen. */
      const next = {};
      for (const c of CLASSES) next[c] = contours[c] ? asMulti(clone(contours[c])) : null;
      for (const c of CLASSES) assertInsideAOI(c, next[c]);
      pushUndo(fullEntry(label));
      redoStack.length = 0;
      working = next;
      dirty = new Set(editedClasses);
      touch();
      return api;
    },

    /** The §3a gate over the working extent. Cheap — this is the live check. */
    validate(opts = {}) {
      /* THE BASELINE GOES IN, because one of the rules is a RELATION between the
         two: no ground may move more than one class from the published week
         (`ruleOneClassMove`). Every other rule is a fact about `working` alone,
         which is why this argument did not exist until composition turned out to
         be able to break the one-class guarantee that the primitives keep
         individually. A caller may still override it — and an override is
         computed fresh, never memoized: the memo is for the one default
         question every panel asks. */
      if (Object.keys(opts).length) {
        return validateContours(working, { scope: 'extent', baselineContours: baseline, ...opts });
      }
      if (!validateMemo) {
        const t0 = now();
        /* Narrowed: `ruleOneClassMove` runs over the changed region only — legal
           because THIS baseline is healed (nested), which the rule's header
           proves is what the narrowing needs. `api.changedRegion` is the memo. */
        validateMemo = validateContours(working, {
          scope: 'extent', baselineContours: baseline,
          narrowOneClassMove: true, changedRegion: api.changedRegion,
        });
        stats.validateMs = Math.round(now() - t0);
      }
      return validateMemo;
    },

    /**
     * Per-class before/after summary for the review screen — measured on the
     * EXCLUSIVE BANDS, not the cumulative contours. The contour of D0 contains
     * D1–D4, so a contour-measured table double-counted every nested class and
     * put the whole drought's footprint in the D0 row (caught 2026-09). The
     * bands partition the D0 contour: the `after` column sums to it. Parts are
     * counted on the bands too, so a band can show more parts than its
     * contour has (a ring of D1 around a D2 core is one contour part and one
     * band part with a hole; two D2 cores inside one D1 part make one part of
     * D1's band either way — but a D1 part split in two by a D2 strip is two
     * D1 band parts).
     */
    summary() {
      const bb = api.baselineBands, wb = api.bands;
      return CLASSES.map((usdmClass) => {
        const before = bb[usdmClass];
        const after = wb[usdmClass];
        const a = areaKm2(before), b = areaKm2(after);
        return {
          usdmClass,
          edited: dirty.has(usdmClass),
          areaKm2: { before: a, after: b, delta: b - a },
          parts: { before: tally(before).parts, after: tally(after).parts },
        };
      });
    },

    /**
     * Fold the edited extent back into the national contours.
     *
     * Rebuilds rather than pastes — see the header. Returns national CONTOURS,
     * the archive's own shape; `deriveBands` turns them into the exclusive
     * representation at package time for `validateDerivedBands`. The heal here
     * is idempotent and cheap on the unclipped product (~250 ms nationally;
     * ~6 s on the masked one, the standing upper bound) — kept because a caller
     * may hand in raw rows and the fold must not inherit their leaks.
     */
    applyToNational() {
      const turf = T();
      const nationalContours = healContours(contours);
      const out = {};
      for (const c of CLASSES) {
        const edited = working[c];
        const national = asMulti(nationalContours[c]);
        if (!national) { out[c] = edited; continue; }

        /* Split the national parts by whether they come anywhere near the
           working area. Parts that do not are passed through untouched — that
           is the whole optimization, and it is exact, because a part whose
           bounding box misses the AOI's bounding box cannot overlap the AOI.

           This split stays on BOUNDING BOXES even when the AOI is a polygon,
           and deliberately so. It is a prefilter, not an answer: being generous
           costs a part one boolean difference that turns out to change nothing,
           while being clever — testing against the polygon and calling a part
           inside the envelope but outside the boundary "far" — would be
           answering the question the difference below is there to answer. */
        const far = [], near = [];
        for (const rings of national.coordinates) {
          (bboxOverlaps(ringBBox(rings), area.bbox) ? near : far).push(rings);
        }

        /* The parts that DO come near it get the WORKING AREA subtracted — the
           AOI polygon itself, not its envelope. This is the step an earlier
           version got wrong by simply discarding them: a part that overlaps the
           working area usually extends far beyond it — the D0 contour's western
           component touches Montana and also covers Arizona — so dropping it
           whole deleted real geometry outside the working area. Measured, that
           bug cost the national D0 contour 52,000 vertices and 16 interior
           rings, and broke every containment pair. Subtracting a polygon AOI's
           rectangle instead of the polygon is the same bug at state scale: it
           would erase the drought in the Idaho corner of Montana's envelope,
           which `clipToAOI` never handed the author in the first place. */
        let remainder = null;
        if (near.length) {
          const nearGeom = asFeature({ type: 'MultiPolygon', coordinates: near });
          remainder = asMulti(turf.difference(turf.featureCollection([nearGeom, aoiPolygon])));
        }

        const pieces = [
          far.length ? { type: 'MultiPolygon', coordinates: far } : null,
          remainder,
          edited,
        ].filter(Boolean);

        if (!pieces.length) { out[c] = null; continue; }
        if (pieces.length === 1) { out[c] = asMulti(pieces[0]); continue; }

        /* One union over the pieces. This is also what dissolves the clip
           boundary: the Sutherland–Hodgman artifacts that the bbox prefilter
           leaves along the cut line are interior to this union and disappear. */
        out[c] = asMulti(turf.union(turf.featureCollection(pieces.map((g) => asFeature(g)))));
      }
      return out;
    },

    /**
     * The full package-time gate: fold back, derive the exclusive-class bands,
     * and validate both. Slow by design (~1.7 s nationally on the unclipped
     * product, ~15 s on the masked one) and run once, behind a progress
     * indicator — never during editing.
     */
    finalize() {
      const changed = changedExtentRegion(baseline, working, area);
      const nationalContours = api.applyToNational();
      const nationalBands = deriveBands(nationalContours);
      return {
        nationalContours,
        nationalBands,
        changedRegion: changed,
        contourGate: validateContours(nationalContours, { scope: 'national', changedRegion: changed }),
        bandGate: validateDerivedBands(nationalBands, { changedRegion: changed }),
        summary: api.summary(),
      };
    },
  };
  return api;
}

/** The working extent as a polygon, for boolean ops. */
function extentPolygon([w, s, e, n]) {
  return { type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
}

/**
 * Every way a caller may name a working area → one record.
 *
 * A `function` declaration, not a `const` arrow, because `createChangeset` calls
 * it on its first line and this module has already shipped one temporal-dead-zone
 * outage of exactly that shape (see CLAUDE.md).
 *
 * Accepted:
 *   `[w, s, e, n]`                 the original shape — a rectangular AOI
 *   `{ bbox }`                     the same thing, said as a record
 *   `{ geometry, bbox?, … }`       a jurisdiction; the envelope is derived when
 *                                  it is not supplied
 *
 * `geometry` is normalized through `asMulti` ONCE, here, so nothing downstream
 * has to ask whether it was handed a Polygon or a MultiPolygon — the artifact
 * js/topology.js's header describes.
 *
 * The record is frozen. `changeset.aoi` hands it straight to callers and it is
 * read on every clip, fold and guard; a caller who mutated it would move the
 * working area out from under geometry already clipped to the old one.
 *
 * @param {object|number[]} aoi
 * @returns {{kind:string|null, id:string|null, name:string|null,
 *            geometry:object|null, bbox:number[]}}
 */
export function normalizeAOI(aoi) {
  if (!aoi) {
    throw new Error('[usdm/changeset] no working area — pass aoi {geometry?, bbox} ' +
      'or bbox [minX,minY,maxX,maxY]');
  }
  const record = Array.isArray(aoi) ? { bbox: aoi } : aoi;
  const geometry = record.geometry ? asMulti(record.geometry) : null;
  const bbox = record.bbox ?? (geometry ? envelopeOf(indexParts(geometry)) : null);
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error('[usdm/changeset] bbox must be [minX,minY,maxX,maxY]');
  }
  return Object.freeze({
    kind: record.kind ?? null,
    id: record.id ?? null,
    name: record.name ?? null,
    geometry,
    bbox,
  });
}

/**
 * The proposal's disagreement with its baseline, kept APART per class and per
 * direction: `{ D0: { added, removed }, … }`, where `added` is
 * *working − baseline* (the class grew there) and `removed` is
 * *baseline − working* (it shrank there). Either may be null.
 *
 * This is the whole of `changedExtentRegion`'s arithmetic, stopped one step
 * early. `changedExtentRegion` wants the merged region and unions these ten
 * pieces back together; js/changes.js wants to know WHICH class moved WHICH way
 * under each patch of that region, and dissolving the pieces first throws away
 * exactly that. Nothing is recomputed twice: a caller that needs both takes the
 * diffs and merges them itself with `mergedDiffRegion`.
 *
 * The third argument takes anything `normalizeAOI` does, INCLUDING a bare
 * `[w,s,e,n]`. Null means "do not clip at all".
 *
 * Each piece is clipped to the working area SEPARATELY, which is the same
 * answer as clipping their union, because clipping is an intersection and
 * intersection distributes over union. It is not meaningfully more work either:
 * `clipToAOI` opens with the bbox prefilter, and a diff that does not reach the
 * AOI boundary is thrown out by arithmetic before any boolean op sees it.
 */
export function perClassDiffs(baseline, working, aoi = null) {
  const turf = T();
  const area = aoi ? normalizeAOI(aoi) : null;
  /* Clipping the result to the working area. Differencing two contours that
     were each clipped to the same boundary can leave hairlines along that
     boundary; they are not changes and would drag the heuristic's sample grid
     out to the edge — with a polygon AOI, out along a state line a thousand
     vertices long. */
  const clip = (g) => (g && area ? clipToAOI(indexParts(g), area.geometry, area.bbox) : g);

  const out = {};
  for (const c of CLASSES) {
    const a = asMulti(baseline?.[c]), b = asMulti(working?.[c]);
    let added = null, removed = null;
    if (a && b) {
      /* `despike`: differencing two contours that agree on thousands of shared
         vertices leaves out-and-back needles along the shared edges — zero
         width, but 30 km long, and every consumer of a diff (patch bboxes, the
         thread detector's 0.5 km growth, the heuristic's sample grid) reads
         extent. See the function. */
      added = despike(turf.difference(turf.featureCollection([asFeature(b), asFeature(a)])));
      removed = despike(turf.difference(turf.featureCollection([asFeature(a), asFeature(b)])));
    } else if (b) {
      added = b;             // the class appeared wholesale
    } else if (a) {
      removed = a;           // …or vanished
    }
    out[c] = { added: clip(added), removed: clip(removed) };
  }
  return out;
}

/**
 * The ten pieces of `perClassDiffs`, dissolved into one region.
 *
 * One `turf.union` over all of them, the way `applyToNational` unions its three
 * pieces, rather than the running pairwise fold this arithmetic was written as
 * before the split. Same pieces, same region — the fold order can only move the
 * last decimals of a shared vertex, and nothing downstream reads the region to
 * that precision.
 *
 * The union is also what makes each PART of the result a connected component:
 * it dissolves overlap and adjacency, so nothing that touches survives as two.
 * That is the property js/changes.js builds its whole identity model on.
 */
export function mergedDiffRegion(diffs) {
  const turf = T();
  const pieces = [];
  for (const c of CLASSES) {
    const d = diffs?.[c];
    if (!d) continue;
    if (d.added) pieces.push(asFeature(d.added));
    if (d.removed) pieces.push(asFeature(d.removed));
  }
  if (!pieces.length) return null;
  if (pieces.length === 1) return asMulti(pieces[0]);
  return asMulti(turf.union(turf.featureCollection(pieces)));
}

/**
 * Where inside the working area the proposal differs from its baseline — the
 * region the §3b heuristic samples and the region the national gate scopes to.
 *
 * The third argument takes anything `normalizeAOI` does, INCLUDING a bare
 * `[w,s,e,n]`, which is what js/submit.js passes (`cs.bbox`) and what this
 * function shipped with. Null means "do not clip the result at all".
 */
export function changedExtentRegion(baseline, working, aoi = null) {
  return mergedDiffRegion(perClassDiffs(baseline, working, aoi));
}
