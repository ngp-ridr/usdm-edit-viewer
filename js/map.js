/* ══ The map: the editor's ladder, plus what a comparison needs ═════════════
   USDM Edit Viewer · js/map.js

   `createMapView(map, { layers })` — docs/contracts.md § 10. It mounts the
   vendored `createLayerStack` unchanged and adds the four sources this app has
   that the editor does not: the findings, the seams, the shown proposals' patch
   outlines, and the anchor letters.

   THE VENDORED STACK IS NOT FORKED AND MUST NOT BE. Everything the editor's
   ladder already knows how to do — the class fills at 1.0, the white class
   separator, the working-area dim, the reference boundary grades, the labels
   raised last, the three display modes — is called, not copied. What is added
   here is what a reconciliation view needs and a single-author editor never
   did. `usdm-changes` and `usdm-delta` stay EMPTY in this app: they are the
   editor's change surfaces, this app's Differences view is `setMapView(
   'changes')` over them, and an empty source is cheaper than a fork.

   THE FOUR `band-*` ENTRIES ARE TAKEN BACK OFF, and the doctrine is worth
   stating because it is the general answer to "the vendored stack builds
   something this app cannot use": `band-dim`/`band-line` over
   `band-mask`/`band-reach` show the band a SCOPED VERB can reach while one is
   armed. This app arms nothing. `createLayerStack` is byte-identical by rule
   and offers no flag to skip them, so `dropEditorOnlyBandLayers()` removes the
   pair and their sources immediately after `addAll()` — after, so the vendored
   file is untouched and a re-sync keeps working. See that function for why
   every vendored caller survives it.

   ── THE LADDER AS BUILT, bottom to top ─────────────────────────────────────
     CARTO Positron ground · hillshade
     usdm-fill-* / usdm-line-*            the published week, punched
     usdm-edit-fill-* / usdm-edit-line-*  the picked proposal, inside its area
     usdm-change-fill                     (empty, the editor's)
     findings-fill                        ← ours, before hillshade-over
     hillshade-over
     ── the basemap's first symbol layer (the anchor) ──
     water · aoi-dim · boundary-county/-state/-nation/-aiannh
                                          (band-dim/band-line removed here)
     changes-line-*  (empty, the editor's)
     aoi-line-casing · aoi-line
     ── everything below inserts before the first RAISED place_/watername_ ──
     patches-casing
     patches-line-0 · patches-line-1 · patches-line-2 · patches-line-3
     findings-line-onesided · findings-line-conflict
     seams-casing · seams-line-onesided · seams-line
     patches-line-active · findings-line-active · seams-line-active
     anchors-label
     ── place_* / watername_* labels, raised by raiseReferenceGeography() ──

   `findings-fill` goes UNDER `hillshade-over` because it is data, not a mark:
   it paints NDMC's published class-change ramp at 1.0 in the Differences view,
   where the class fills are hidden, and it takes relief over it exactly as the
   class fills do. Everything else this module adds is a LINE or a GLYPH and
   belongs over the dim and the boundary grades, under the place names.

   The insertion anchor for the marks is the first RAISED label, found by
   scanning the live layer order for `place_*`/`watername_*` (js/layers.js's
   `raiseReferenceGeography` has already moved them to the top, so the first one
   in the list is above every app line). On a degraded boot there are no symbol
   layers at all, the anchor is `undefined`, and `addLayer(layer, undefined)`
   APPENDS — the same collapse-to-the-top the editor's stack relies on, with no
   second code path.

   ── THE MARKS, AND WHY EACH PAIR DIFFERS ON TWO AXES ───────────────────────
     mark                     colour             shape
     ───────────────────────  ─────────────────  ──────────────────────────────
     patches-line-0..3        --text-primary     the proposal's dash, 1.6 px,
                                                 over a 3.5 px white casing
     findings-line-conflict   --text-primary     solid 2.2 px
     findings-line-onesided   --text-primary     dashed [2, 1.5] 2.2 px
     seams-line               --map-reach-line   solid 3 px      (reciprocal)
     seams-line-onesided      --map-reach-line   dashed [1.5, 1] 3 px
     seams-casing (isNew)     white              5 px under the line
     *-active                 --selection-ring   dashed [1.4, 1] 6 px

   Colour alone never separates two of them, because under the high-contrast
   theme `--text-primary` and `--selection-ring` are both `#000000` — that is
   not a flaw in the theme, it is why the table has a shape column.

   `line-dasharray` IS NOT DATA-DRIVEN in MapLibre. That is the whole reason
   there are four `patches-line-*` layers filtered on `mark` and two seam line
   layers filtered on `reciprocal`, and it is why collapsing them into one
   data-driven layer cannot be done however much it looks like it should.

   `anchors-label` is A DOCUMENTED DOCTRINE EXCEPTION and the only one in this
   app: a symbol drawn over the USDM classes. The editor's rule is that nothing
   paints over that ramp, and the reason is blending — a translucent fill makes
   one drought read as two classes. A glyph does not blend, it REPLACES pixels,
   the way the basemap's own place names already do over the same fills; and the
   letter is the text twin of the dash, which is the only channel a colour-blind
   reader has for "whose outline is this". CLAUDE.md carries the record.

   ── WHAT THIS MODULE WILL NOT DO ───────────────────────────────────────────
   NO `queryRenderedFeatures`, ANYWHERE. It is blind to holes (every ring
   reports a hit independently, interior rings included) and it answers with
   tile-simplified geometry. `hitTest` reads the geometry this module was
   HANDED, held in this closure — never `map.getSource(id)._data`, which in
   MapLibre v5 is not GeoJSON at all (it holds `{ geojson: … }`, truthy and
   unparseable; the editor's PNG export shipped with no state lines on it for
   exactly that reason).

   NO FILL OVER THE CLASSES beyond the two the contract names (`findings-fill`
   in the Differences view, where no class colour is on screen; the vendored
   `aoi-dim`, which paints the world OUTSIDE the loaded areas). Dimming a
   hidden proposal's findings dims their OUTLINES and never `findings-fill`:
   the change ramp is a published encoding and a modulated one is a different
   reading.

   ── MEASURED COSTS ─────────────────────────────────────────────────────────
   THE PUNCH is the only expensive thing here: `differenceNear` over the five
   national bands for one state, measured 418–572 ms in the editor (2026-08-11,
   MT/CA/TX, on the masked product; the unclipped one is cheaper). It is cached
   on `(week, aoi.id)` and recomputed only when the PICK changes to another
   working area — never per view change, never per selection, never per frame.
   `lastPunchMs` on the returned surface is what catches that going wrong;
   js/app.js surfaces it as `__viewer.lastPunchMs`.

   Everything else is a `setData` or a `setFilter`. The AOI union is one
   `unionNear` chain per session (five states: tens of ms) cached on the joined
   id list.

   Measured in a Chromium smoke over tools/fixtures/findings-map.json (whose
   bands are rectangles, so these are FLOORS, not the state-sized numbers):
   first pick 1 ms, a re-pick of the same working area 0 ms — the (week, AOI)
   cache holding is the property those two numbers are there to state. The
   whole attach (four sources, sixteen layers) is under one frame. The real
   bar is the editor's 418–572 ms above, which is what `lastPunchMs` is
   compared against once demo/ is loaded.

   `function` declarations throughout, not `const` arrows: this file's exports
   call downward and two editor modules shipped broken on exactly that TDZ.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CLASSES, CHANGE_STEPS, USDM_CHANGE_COLORS } from '../vendor/usdm-editor/js/color.js';
import { cssVar } from '../vendor/usdm-editor/js/dom.js';
import { labelLayerIds } from '../vendor/usdm-editor/js/basemap.js';
import {
  T, asMulti, differenceNear, unionNear, indexParts, envelopeOf, bboxOverlaps,
} from '../vendor/usdm-editor/js/topology.js';
import { markStyle, MARK_COUNT } from './marks.js';

/* ── Source ids. The three the vendored stack owns are named here only so the
      comment above can say they stay empty; this module never touches them. ── */

/** Regions — conflicts and one-sided differences. Polygons. */
const SRC_FINDINGS = 'findings';
/** Seams — the disjuncture runs along a shared working-area line. Lines. */
const SRC_SEAMS = 'seams';
/** The shown proposals' patch outlines, one feature per patch. */
const SRC_PATCHES = 'patches';
/** One point per patch, carrying its proposal's letter. */
const SRC_ANCHORS = 'anchors';

/** The three modes, in this app's spelling. `setMapView` takes 'changes'. */
const VIEWS = Object.freeze(['proposal', 'published', 'differences']);

/**
 * How close a click has to land on a seam to pick it: six CSS pixels,
 * converted to km at the current latitude and zoom.
 *
 * A pixel budget rather than a distance: a seam is a LINE, so the only honest
 * tolerance is the one the reader's finger and the screen impose, and 6 px is
 * the editor's own `SEGMENT_HIT_PX` (12) halved — a seam is picked from a
 * whole map rather than from inside an edit, so it can afford to be fussier.
 */
const SEAM_HIT_PX = 6;

/** Metres per tile edge in MapLibre's projection, for the km-per-pixel maths. */
const EQUATOR_KM = 40075.016686;
/** MapLibre renders vector tiles at 512 px. */
const TILE_PX = 512;

/** How much of a dimmed outline is left. Visibly back, unmistakably not gone. */
const DIM_OPACITY = 0.3;

/** A fresh empty FeatureCollection. Never one shared constant — MapLibre keeps
 *  the object it is handed, and two sources sharing one is a hazard for the
 *  price of nothing. */
function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

/** A filter that matches nothing: an empty haystack no key can be in. A filter
 *  that is OFF rather than a layer that is missing — and a missing layer is
 *  what a later `setFilter` would throw on. */
function matchNothing(key = 'id') {
  return ['in', ['get', key], ['literal', []]];
}

/**
 * Build the viewer's map surface over an already-constructed MapLibre map.
 *
 * @param {maplibregl.Map} map  a map whose style has loaded
 * @param {object} deps
 * @param {object} deps.layers  the vendored `createLayerStack(map)`. If its
 *   `addAll()` has not run yet this awaits it, so the caller may build this
 *   before or after the stack without a second spelling.
 * @param {Function} [deps.punch]  `(bands, aoi, week) → bands | Promise<bands>`.
 *   Defaults to the editor's twelve-line punch, cached here. js/app.js passes
 *   an adapter over `js/bands.js`'s `punched(week, aoi)` when WP-B's provider
 *   is the one holding the cache — the two must never both hold one, or the
 *   418–572 ms is paid twice.
 * @param {Function} [deps.fitPadding]  `(base) → {top,right,bottom,left}`, the
 *   padding that keeps a fit from putting its subject under the docked card or
 *   the bottom sheet. js/app.js owns the measurement; the default is uniform.
 * @param {Function} [deps.onPick]  called with `hitTest`'s answer on every map
 *   click, `null` included — "nothing here" is an answer a reader needs, and a
 *   click that silently does nothing is indistinguishable from a broken map.
 * @returns {object} docs/contracts.md § 10's surface
 */
export function createMapView(map, {
  layers,
  punch = punchBands,
  fitPadding = uniformPadding,
  onPick = null,
} = {}) {
  if (!map) throw new Error('[viewer/map] createMapView needs a map');
  if (!layers) throw new Error('[viewer/map] createMapView needs the vendored layer stack');

  /* ── What this view is showing. Held here, never read back off the map. ── */
  const state = {
    view: 'proposal',
    /** The national published bands, as handed to `setPublished`. */
    published: null,
    /** The picked proposal, or null. */
    pick: null,
    /** Proposal ids whose outlines draw. `null` means ALL of them. */
    shown: null,
    /** The raw model objects, for `hitTest` and for rebuilding on `setShown`. */
    regions: [],
    seams: [],
    patches: [],
    aois: [],
    selection: null,
  };

  /* The FeatureCollections currently in each viewer source — held in the
     closure for the same reason js/layers.js holds `boundaries`: nothing in app
     code may read `map.getSource(id)._data`. `sourceFC()` is the only way back
     out, and tools/verify.mjs is its only caller. */
  const painted = {
    [SRC_FINDINGS]: emptyFC(),
    [SRC_SEAMS]: emptyFC(),
    [SRC_PATCHES]: emptyFC(),
    [SRC_ANCHORS]: emptyFC(),
  };

  /** Where the anchor letters got to: 'added', or 'no-glyphs' on a degraded
   *  style that has no font server to ask. A breadcrumb, because the failure is
   *  deliberately quiet and a test should not have to infer it. */
  let anchorsStatus = 'pending';
  let added = false;
  let lastPunchMs = 0;
  /** Guards a late `punch` promise from painting over a newer pick. */
  let pickGeneration = 0;

  /**
   * Resolves with the surface once every viewer layer is on the map.
   *
   * DECLARED HERE AND ASSIGNED AT THE BOTTOM OF THIS FUNCTION, and that is not
   * style. It was written as an `async` IIFE up here, and on the normal path —
   * a stack whose `addAll()` has already run — the body reached NO `await` at
   * all, ran straight through to `return surface`, and threw
   * `Cannot access 'surface' before initialization` on the very first boot.
   * The `await` that was supposed to defer it was behind an `if`. This is
   * CLAUDE.md's TDZ trap wearing a promise, and the fix is the same one: put
   * the thing that reads a `const` after the `const`.
   */
  let ready = null;

  /** Add every viewer layer and paint whatever the caller has handed over. */
  function attach() {
    dropEditorOnlyBandLayers();
    addViewerLayers();
    added = true;
    repaintAll();
    return surface;
  }

  /**
   * The scoped-verb reach mask, removed rather than forked.
   *
   * `band-dim` / `band-line` (over `band-mask` / `band-reach`) are the
   * editor's: they show which band a scoped Improve or Degrade can reach while
   * one is ARMED. This app arms nothing — it never edits and has no verbs — so
   * nothing here can ever feed them, and four style entries MapLibre walks
   * every frame is four it walks for nothing.
   *
   * TAKEN OFF AFTER `addAll()`, NEVER TRIMMED OUT OF IT. `createLayerStack` is
   * vendored byte-identical (CLAUDE.md's first rule) and takes no composition
   * flag for this; the alternative to these four lines is a fork, which is a
   * copy nobody can re-sync. Layers before sources — MapLibre refuses to remove
   * a source a layer still reads — and every vendored caller survives it:
   * `renderBandMask` is `getSource(id)?.setData(…)` and `restyleForTheme`
   * guards each paint with `getLayer(id)`, so both become no-ops rather than
   * throws. `usdm-changes` and `usdm-delta` STAY: the editor's change view is
   * `setMapView('changes')`, which this app's Differences view maps onto.
   */
  function dropEditorOnlyBandLayers() {
    for (const id of ['band-dim', 'band-line']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ['band-mask', 'band-reach']) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }

  /* ══ Adding the layers ════════════════════════════════════════════════════ */

  function addViewerLayers() {
    /* THE CHANGE RAMP, under the relief. Before `hillshade-over` when it is
       there; before the first raised label when it is not (a boot with no DEM),
       which keeps it under the place names even in the degraded case. */
    const beforeRelief = map.getLayer('hillshade-over') ? 'hillshade-over' : firstRaisedLabelId();

    map.addSource(SRC_FINDINGS, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'findings-fill', type: 'fill', source: SRC_FINDINGS,
      /* The Differences view alone turns this on. In the other two the class
         fills are on screen and NDMC's other encoding over them would be the
         exact failure the no-fill rule exists to prevent. */
      layout: { visibility: 'none' },
      paint: {
        /* BUILT FROM js/color.js, NEVER HAND-TYPED: the ramp is DATA and there
           must be exactly one copy of it in the fleet. A delta this app does
           not know about falls to 'transparent' rather than to MapLibre's
           default black, so an unexpected value paints nothing instead of
           paving a state. */
        'fill-color': ['match', ['get', 'delta'],
          ...CHANGE_STEPS.flatMap((s) => [Number(s), USDM_CHANGE_COLORS[s]]),
          'transparent'],
        /* OPAQUE, like every other data fill in this fleet. Dimming a hidden
           proposal's finding dims its OUTLINE (below); modulating a published
           ramp would make the same step read as two. */
        'fill-opacity': 1,
      },
    }, beforeRelief);

    /* ── Everything from here is a MARK, and marks go over the reference
          geography and under the place names. ─────────────────────────────── */
    const beforeLabels = firstRaisedLabelId();

    map.addSource(SRC_SEAMS, { type: 'geojson', data: emptyFC() });
    map.addSource(SRC_PATCHES, { type: 'geojson', data: emptyFC() });
    map.addSource(SRC_ANCHORS, { type: 'geojson', data: emptyFC() });

    /* ONE casing under all four dash patterns: a casing is what makes a line
       readable over saturated data, and white is the only colour that does that
       against the whole USDM ramp at once. */
    map.addLayer({
      id: 'patches-casing', type: 'line', source: SRC_PATCHES,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.9 },
    }, beforeLabels);

    for (let i = 0; i < MARK_COUNT; i++) {
      const style = markStyle(i);
      const paint = {
        'line-color': cssVar('--text-primary', '#1a1a1a'),
        'line-width': style.width,
      };
      /* Omitted, not `[1]`: MapLibre has no dasharray value meaning solid. */
      if (style.dasharray) paint['line-dasharray'] = style.dasharray;
      map.addLayer({
        id: `patches-line-${i}`, type: 'line', source: SRC_PATCHES,
        filter: ['==', ['get', 'mark'], i],
        layout: { 'line-join': 'round', 'line-cap': style.cap },
        paint,
      }, beforeLabels);
    }

    /* THE TWO FINDING KINDS, and the order is the ranking: a conflict drawn
       over a one-sided outline is the right way round, because a conflict is
       what a reconciliation exists to settle. Both are `--text-primary` and
       both are 2.2 px, so they are told apart by RHYTHM alone — which is legal
       only because they are never the same ground: a piece is one or the
       other by construction (docs/contracts.md § 4 step 3). */
    map.addLayer({
      id: 'findings-line-onesided', type: 'line', source: SRC_FINDINGS,
      filter: ['==', ['get', 'kind'], 'one-sided'],
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: {
        'line-color': cssVar('--text-primary', '#1a1a1a'),
        'line-width': 2.2,
        'line-dasharray': [2, 1.5],
        'line-opacity': dimExpression(),
      },
    }, beforeLabels);
    map.addLayer({
      id: 'findings-line-conflict', type: 'line', source: SRC_FINDINGS,
      filter: ['==', ['get', 'kind'], 'conflict'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': cssVar('--text-primary', '#1a1a1a'),
        'line-width': 2.2,
        'line-opacity': dimExpression(),
      },
    }, beforeLabels);

    /* THE SEAM CASING IS A MEANING, not legibility: five white pixels under a
       run says the published map did not have this step at all. So it is
       filtered on `isNew` rather than drawn under every seam — a casing that is
       always there says nothing. */
    map.addLayer({
      id: 'seams-casing', type: 'line', source: SRC_SEAMS,
      filter: ['==', ['get', 'isNew'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 },
    }, beforeLabels);
    /* TWO LAYERS for one mark, because `line-dasharray` is not data-driven.
       One-sided first so a reciprocal seam draws over it where they meet. */
    map.addLayer({
      id: 'seams-line-onesided', type: 'line', source: SRC_SEAMS,
      filter: ['!=', ['get', 'reciprocal'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': cssVar('--map-reach-line', '#0f5e66'),
        'line-width': 3,
        'line-dasharray': [1.5, 1],
        'line-opacity': dimExpression(),
      },
    }, beforeLabels);
    map.addLayer({
      id: 'seams-line', type: 'line', source: SRC_SEAMS,
      filter: ['==', ['get', 'reciprocal'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': cssVar('--map-reach-line', '#0f5e66'),
        'line-width': 3,
        'line-opacity': dimExpression(),
      },
    }, beforeLabels);

    /* ── The three selections. One at a time, and always on: a selected thing
          is drawn even in a view whose own outline layer is off, because the
          reader just asked for it by name. ───────────────────────────────── */
    for (const [id, src, key] of [
      ['patches-line-active', SRC_PATCHES, 'key'],
      ['findings-line-active', SRC_FINDINGS, 'id'],
      ['seams-line-active', SRC_SEAMS, 'id'],
    ]) {
      map.addLayer({
        id, type: 'line', source: src,
        filter: matchNothing(key),
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': cssVar('--selection-ring', '#1f3f9e'),
          /* WIDER THAN EVERY MARK IT SITS ON, AND DASHED. `--selection-ring`
             and `--text-primary` are the same black under the high-contrast
             theme, so 6 px standing proud of 2.2/3 px on both sides, plus a
             rhythm nothing else has, is what actually carries "this one". */
          'line-width': 6,
          'line-dasharray': [1.4, 1],
        },
      }, beforeLabels);
    }

    /* THE ANCHOR LETTERS — the doctrine exception, and the text twin of the
       dash. `text-font` is copied off a label layer the basemap already renders
       rather than named: a font this style's glyph server does not serve draws
       nothing at all, silently. A style with no `glyphs` at all (the degraded
       blank ground) has no font server to ask, so the layer is skipped and says
       so through `status()` rather than filling the console with tile errors. */
    if (map.getStyle()?.glyphs) {
      const layout = {
        'text-field': ['get', 'letter'],
        'text-size': 11,
        /* NEVER over another letter: two proposals' anchors a kilometre apart
           would otherwise stack into an unreadable smudge, and the panel is the
           complete list — the map's letters are orientation, not inventory. */
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-padding': 4,
      };
      const font = borrowTextFont();
      if (font) layout['text-font'] = font;
      map.addLayer({
        id: 'anchors-label', type: 'symbol', source: SRC_ANCHORS,
        layout,
        paint: {
          'text-color': cssVar('--text-primary', '#1a1a1a'),
          /* White, like every casing in this app, and for the same reason: it
             is the one colour that reads against the whole USDM ramp at once. */
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      }, beforeLabels);
      anchorsStatus = 'added';
    } else {
      anchorsStatus = 'no-glyphs';
    }
  }

  /**
   * The first label layer the vendored stack raised over the app's own marks.
   *
   * `raiseReferenceGeography()` moves every `place_*` and `watername_*` symbol
   * layer to the TOP of the style, so the first one in the live layer order is
   * above `aoi-line` and everything under it — which makes it exactly the
   * anchor a new mark wants. `undefined` on a degraded boot (no symbol layers
   * at all), and `addLayer(layer, undefined)` APPENDS, which is the same
   * "collapse to the top" the editor's stack relies on.
   */
  function firstRaisedLabelId() {
    return labelLayerIds(map)
      .find((id) => id.startsWith('place_') || id.startsWith('watername_'));
  }

  /** The `text-font` the basemap's own place names use, or null. */
  function borrowTextFont() {
    for (const id of labelLayerIds(map)) {
      if (!id.startsWith('place_')) continue;
      try {
        const font = map.getLayoutProperty(id, 'text-font');
        if (Array.isArray(font) && font.length && typeof font[0] === 'string') return [...font];
      } catch { /* a layer with no text-field — keep looking */ }
    }
    return null;
  }

  /**
   * The opacity a mark draws at: full, or dimmed because a proposal it belongs
   * to is hidden.
   *
   * Data-driven, so hiding a proposal is one `setData` and no layer churn.
   * OPACITY IS THE ONE CHANNEL A DIM MAY USE HERE — not colour (there is none
   * spare) and not width (that is how the marks tell each other apart).
   */
  function dimExpression() {
    return ['case', ['==', ['get', 'dimmed'], true], DIM_OPACITY, 1];
  }

  /* ══ What the map is showing ══════════════════════════════════════════════ */

  /**
   * The published week's national bands.
   *
   * Held rather than painted straight through, because whether they go on the
   * map whole or with a hole in them is a function of the VIEW and the PICK,
   * and this is the only place that knows all three.
   */
  function setPublished(bands) {
    state.published = bands ?? null;
    return paintClasses();
  }

  /**
   * Whose classes the Proposal view paints — and therefore where the hole in
   * the published fills goes.
   *
   * WHY PUNCH AT ALL: an opaque fill can only ADD a class. Ground a proposal
   * improved OUT of a class has no polygon of its own over it, so without the
   * punch the published fill shows through and the improvement changes nothing
   * on screen. The punch is what makes the proposal's group complete rather
   * than additive, and it is why exactly one group covers any pixel.
   */
  function setPick(proposal) {
    state.pick = proposal ?? null;
    return paintClasses();
  }

  /**
   * Repaint both class groups for the current (view, pick, published).
   *
   * Returns a promise, because `punch` may be WP-B's async provider. The
   * generation guard is what stops a slow punch for a pick the reader has
   * already moved off from landing on the map afterwards.
   */
  async function paintClasses() {
    if (!added) return;
    const generation = ++pickGeneration;
    const published = state.published;

    if (state.view === 'published' || !state.pick) {
      /* THE PUBLISHED VIEW IS A DATA SWAP, not a hide: nothing is punched, and
         `usdm-edit` is emptied rather than made invisible — the vendored
         `setMapView('published')` deliberately leaves that group visible,
         because in the editor it carries the working area's published bands. */
      layers.renderBands(published ?? null);
      layers.renderEditBands(null);
      return;
    }

    const aoi = state.pick.aoi ?? null;
    let holed = published;
    if (published && aoi?.geometry) {
      const t0 = now();
      holed = await punch(published, aoi, state.pick.week);
      /* A newer pick landed while this one was in the clipper. Dropping the
         result is the whole point of the generation counter: painting it would
         put the previous author's hole back under the current author's fills. */
      if (generation !== pickGeneration) return;
      /* Only a REAL punch moves the number. A cache hit rounds to 0 ms, and
         zeroing the measurement would take away exactly the signal this exists
         to give — "the punch has started running per interaction". */
      const ms = Math.round(now() - t0);
      if (ms > 0) lastPunchMs = ms;
    }
    layers.renderBands(holed ?? null);
    layers.renderEditBands(state.pick.bands ?? null);
  }

  /**
   * Which of the three the map is in. `setMapView` takes 'changes', not
   * 'change' and not 'differences' — the editor's spelling, mapped here once.
   */
  function setView(next) {
    const want = VIEWS.includes(next) ? next : 'proposal';
    state.view = want;
    layers.setMapView(want === 'differences' ? 'changes' : want);
    paintVisibility();
    paintClasses();
    return want;
  }

  /**
   * Which marks the current view draws.
   *
   *   proposal / published   conflicts, patches, seams — the one-sided
   *                          outlines are OFF, because in a view that paints
   *                          one author's classes the interesting question is
   *                          where somebody disagrees, and forty one-sided
   *                          outlines over a state is a hatch, not a mark.
   *   differences            the change ramp, BOTH outline kinds and the seams;
   *                          patch outlines and anchors OFF, because the
   *                          findings are the subject and the patches would
   *                          double every edge.
   *
   * The three `*-active` layers are never in here: the selected thing draws in
   * every view, including one whose own outline layer is off.
   */
  function paintVisibility() {
    const differences = state.view === 'differences';
    show('findings-fill', differences);
    show('findings-line-onesided', differences);
    show('findings-line-conflict', true);
    for (const id of ['patches-casing', 'anchors-label',
      ...Array.from({ length: MARK_COUNT }, (unused, i) => `patches-line-${i}`)]) {
      show(id, !differences);
    }
    for (const id of ['seams-casing', 'seams-line', 'seams-line-onesided']) show(id, true);
  }

  function show(id, on) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /* ══ The data ═════════════════════════════════════════════════════════════ */

  /** The loaded working areas. The union dims the world outside the SET, and
   *  `aoi-line` then draws every loaded boundary — the vendored stack takes one
   *  record, so the union is built here and handed over as one. */
  function setAois(aois) {
    state.aois = Array.isArray(aois) ? aois.filter(Boolean) : [];
    const geometry = unionOfAois(state.aois);
    layers.renderAoi(geometry ? { geometry } : null);
  }

  /** Which proposals' outlines draw. `null` or an empty set means ALL of them —
   *  the same convention js/app.js's `state.shown` uses, and the reason `?show=`
   *  is emitted only when the set is a real subset. */
  function setShown(ids) {
    const set = ids instanceof Set ? ids : (Array.isArray(ids) ? new Set(ids) : null);
    state.shown = set && set.size ? set : null;
    paintPatches();
    paintFindings();
    paintSeams();
  }

  function isShown(proposalId) {
    if (!proposalId) return true;
    return !state.shown || state.shown.has(proposalId);
  }

  function setFindings(regions) {
    state.regions = Array.isArray(regions) ? regions.filter(Boolean) : [];
    paintFindings();
  }

  function setSeams(seams) {
    state.seams = Array.isArray(seams) ? seams.filter(Boolean) : [];
    paintSeams();
  }

  function setPatches(patches) {
    state.patches = (Array.isArray(patches) ? patches : []).filter((p) => p?.geometry);
    paintPatches();
  }

  function repaintAll() {
    paintFindings();
    paintSeams();
    paintPatches();
    paintVisibility();
    paintClasses();
    highlight(state.selection);
  }

  function paintFindings() {
    const features = state.regions.map((r) => ({
      type: 'Feature',
      properties: {
        id: r.id,
        kind: r.kind,
        /* THE SIGNED STEP FROM PUBLISHED TO THE SIDE DEPARTING FURTHEST — the
           engine's if it computed one, ours otherwise. See `deltaFor`. */
        delta: Number.isFinite(r.delta) ? r.delta : deltaFor(r),
        magnitude: r.magnitude ?? null,
        areaKm2: r.areaKm2 ?? null,
        aoiId: r.aoiId ?? null,
        dimmed: !(isShown(r.proposalA) && isShown(r.proposalB)),
      },
      geometry: r.geometry,
    })).filter((f) => f.geometry);
    setData(SRC_FINDINGS, { type: 'FeatureCollection', features });
  }

  function paintSeams() {
    const features = [];
    for (const s of state.seams) {
      const dimmed = !(isShown(sideProposalId(s.sideA)) && isShown(sideProposalId(s.sideB)));
      for (const piece of seamPieces(s)) {
        features.push({
          type: 'Feature',
          properties: {
            id: s.id,
            kind: 'seam',
            isNew: piece.isNew === true,
            step: piece.step ?? s.maxStep ?? null,
            lengthKm: piece.lengthKm ?? s.lengthKm ?? null,
            /* NOT in docs/contracts.md § 10's property list, and it has to be:
               `line-dasharray` is not data-driven, so the reciprocal/one-sided
               distinction can only be made by a FILTER over two layers. */
            reciprocal: s.reciprocal === true,
            dimmed,
          },
          geometry: piece.geometry,
        });
      }
    }
    setData(SRC_SEAMS, { type: 'FeatureCollection', features });
  }

  function paintPatches() {
    const outlines = [];
    const anchors = [];
    for (const p of state.patches) {
      if (!isShown(p.proposalId)) continue;
      const properties = {
        proposalId: p.proposalId ?? null,
        key: p.key ?? p.id ?? null,
        seq: p.seq ?? null,
        mark: Number.isFinite(p.mark) ? p.mark : 0,
        letter: p.letter ?? '',
      };
      outlines.push({ type: 'Feature', properties, geometry: p.geometry });
      const at = anchorPoint(p);
      if (at) anchors.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: at } });
    }
    setData(SRC_PATCHES, { type: 'FeatureCollection', features: outlines });
    setData(SRC_ANCHORS, { type: 'FeatureCollection', features: anchors });
  }

  function setData(id, fc) {
    painted[id] = fc;
    if (added) map.getSource(id)?.setData(fc);
  }

  /* ══ Selection, focus, theme ══════════════════════════════════════════════ */

  /**
   * Ring exactly one thing, or nothing.
   *
   * ONE SELECTION AT A TIME, enforced by clearing the other two filters on
   * every call: three `*-active` layers with three independent filters is three
   * ways to leave a stale ring on the map, and the editor found every one of
   * them.
   *
   * @param {{kind:string, id:string}|null} selection
   */
  function highlight(selection) {
    state.selection = selection ?? null;
    if (!added) return;
    const kind = selection?.kind ?? null;
    const id = selection?.id ?? null;
    setFilterOn('findings-line-active', 'id',
      (kind === 'conflict' || kind === 'one-sided') ? id : null);
    setFilterOn('seams-line-active', 'id', kind === 'seam' ? id : null);
    setFilterOn('patches-line-active', 'key', kind === 'change' ? id : null);
  }

  function setFilterOn(layerId, key, value) {
    if (!map.getLayer(layerId)) return;
    map.setFilter(layerId,
      value ? ['in', ['get', key], ['literal', [value]]] : matchNothing(key));
  }

  /**
   * Frame a finding, a patch, a working area, a geometry or a bare bbox.
   *
   * The padding clears the docked card or the bottom sheet, because a fit that
   * puts its subject under the thing that opened it is a fit that did nothing.
   * `maxZoom` is what stops a 20 km² region becoming a street map.
   *
   * REDUCED MOTION IS HONOURED HERE AND NOT IN CSS. A camera flight is a
   * six-hundred-millisecond zoom of the whole viewport — the largest motion
   * this app makes, and the one a vestibular reader is most likely to have
   * asked not to be shown — but it is drawn into a canvas, where
   * `prefers-reduced-motion` in a stylesheet cannot reach it. The answer is the
   * same either way: the fit still happens, it just arrives rather than
   * travels.
   */
  function focus(target, { base = 32, maxZoom = 10, duration = 600 } = {}) {
    const bbox = bboxOf(target);
    if (!bbox) return null;
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: fitPadding(base), maxZoom, duration, animate: !prefersReducedMotion(),
    });
    return bbox;
  }

  /** Re-resolve every token this module painted with. The vendored stack does
   *  its own; neither knows about the other's layers, which is the point. */
  function restyleForTheme() {
    layers.restyleForTheme();
    if (!added) return;
    const ink = cssVar('--text-primary', '#1a1a1a');
    const ring = cssVar('--selection-ring', '#1f3f9e');
    const seam = cssVar('--map-reach-line', '#0f5e66');
    const paint = (id, prop, value) => {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
    };
    for (let i = 0; i < MARK_COUNT; i++) paint(`patches-line-${i}`, 'line-color', ink);
    paint('findings-line-onesided', 'line-color', ink);
    paint('findings-line-conflict', 'line-color', ink);
    paint('seams-line', 'line-color', seam);
    paint('seams-line-onesided', 'line-color', seam);
    paint('patches-line-active', 'line-color', ring);
    paint('findings-line-active', 'line-color', ring);
    paint('seams-line-active', 'line-color', ring);
    paint('anchors-label', 'text-color', ink);
    /* The casings stay white. White is white in both themes, which is the whole
       reason a casing is white. */
  }

  /* ══ hitTest ══════════════════════════════════════════════════════════════ */

  /**
   * What is under a click, read from the geometry this module was handed.
   *
   * NEVER `queryRenderedFeatures`: it is blind to holes (every ring reports a
   * hit independently, so a click in the doughnut's hole hits the doughnut) and
   * it answers with tile-simplified coordinates. The arrays in this closure are
   * the same objects the panel lists, so the map and its text twin cannot
   * disagree about what was clicked.
   *
   * PRECEDENCE — conflict > one-sided > seam > change — and it is NOT
   * view-aware, deliberately. A one-sided region has no outline in the Proposal
   * view, but it is a row in the findings panel in every view, so answering
   * "nothing proposed here" over ground the panel lists would be a lie. What
   * IS filtered is `shown`: a hidden proposal's patch is not drawn and is not
   * pickable, which is the fact the reader asserted by hiding it.
   *
   * @param {[number, number]} lngLat
   * @returns {{kind:string, id:string}|null}
   */
  function hitTest(lngLat) {
    if (!Array.isArray(lngLat) || lngLat.length < 2) return null;
    const pt = [Number(lngLat[0]), Number(lngLat[1])];
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) return null;

    for (const kind of ['conflict', 'one-sided']) {
      const hit = state.regions.find((r) => r.kind === kind && covers(r.geometry, r.bbox, pt));
      if (hit) return { kind, id: hit.id };
    }

    const nearSeam = seamUnder(pt);
    if (nearSeam) return { kind: 'seam', id: nearSeam.id };

    const patch = state.patches.find((p) => isShown(p.proposalId) && covers(p.geometry, p.bbox, pt));
    if (patch) return { kind: 'change', id: patch.key ?? patch.id };

    return null;
  }

  /**
   * The seam whose line passes within `SEAM_HIT_PX` of the point, nearest
   * first — a shared line may carry two seams where two proposals meet.
   *
   * BBOX FIRST, like every other hit test in this module. `pointToLineDistance`
   * walks every segment of a line, and a run's line is now the BORDER rather
   * than a two-point chord (`seamPieces`) — hundreds of vertices per run,
   * thousands per session — so the prefilter went from an optimisation over
   * twenty two-point lines to the same thing `covers()` does for polygons. The
   * box is grown by the tolerance in DEGREES at this latitude, so a point just
   * outside a line's envelope but well within six pixels of it is still tested.
   */
  function seamUnder(pt) {
    const turf = T();
    const tolerance = SEAM_HIT_PX * kmPerPixel(pt[1]);
    /* Latitude first, then longitude widened by the convergence of the
       meridians — a degree of longitude is a kilometre less the further north
       the border runs, and the SD/NE line is at 43°. */
    const padY = tolerance / 111.32;
    const padX = padY / Math.max(0.1, Math.cos((pt[1] * Math.PI) / 180));
    const near = [pt[0] - padX, pt[1] - padY, pt[0] + padX, pt[1] + padY];
    let best = null;
    for (const s of state.seams) {
      for (const piece of seamPieces(s)) {
        for (const line of lineStringsOf(piece.geometry)) {
          if (line.length < 2) continue;
          const box = bboxOfCoordinates(line);
          if (box && !bboxOverlaps(near, box)) continue;
          let km;
          try {
            km = turf.pointToLineDistance(turf.point(pt), turf.lineString(line), { units: 'kilometers' });
          } catch { continue; }
          if (km <= tolerance && (!best || km < best.km)) best = { km, id: s.id };
        }
      }
    }
    return best;
  }

  /** bbox first, then point-in-polygon. The bbox is the whole reason a national
   *  click is not a scan of every ring in the session. */
  function covers(geometry, bbox, pt) {
    if (!geometry) return false;
    const box = Array.isArray(bbox) && bbox.length >= 4
      ? bbox
      : envelopeOf(indexParts(geometry));
    if (box && !bboxOverlaps([pt[0], pt[1], pt[0], pt[1]], box)) return false;
    try {
      return T().booleanPointInPolygon(pt, { type: 'Feature', properties: {}, geometry });
    } catch {
      return false;
    }
  }

  /** Kilometres one CSS pixel covers at this latitude and the current zoom. */
  function kmPerPixel(lat) {
    const scale = TILE_PX * (2 ** map.getZoom());
    return (EQUATOR_KM * Math.cos((lat * Math.PI) / 180)) / scale;
  }

  /* ══ Geometry helpers ═════════════════════════════════════════════════════ */

  /**
   * The union of every loaded working area, cached on the joined id list.
   *
   * `unionNear` rather than a naked `turf.union` chain: each step hands the
   * clipper only the parts whose bounding boxes can touch, which over five
   * unsimplified FSA state rings is the difference between tens of milliseconds
   * and seconds.
   */
  let aoiUnionCache = { key: null, geometry: null };
  function unionOfAois(aois) {
    const list = aois.filter((a) => a?.geometry);
    if (!list.length) return null;
    const key = list.map((a) => a.id ?? a.name ?? '?').join('|');
    if (aoiUnionCache.key === key) return aoiUnionCache.geometry;
    let g = asMulti(list[0].geometry);
    for (let i = 1; i < list.length; i++) {
      try { g = unionNear(g, list[i].geometry); } catch (err) {
        console.warn('[viewer/map] could not union a working area into the mask', err);
      }
    }
    aoiUnionCache = { key, geometry: g };
    return g;
  }

  /**
   * The pieces of a seam the map draws, and what each of them means.
   *
   * A `Seam` (docs/contracts.md § 5) carries `runs`, not a geometry: the line
   * itself is shared with its neighbour and mostly says nothing. So the map
   * draws the runs that ARE a finding — `new`, `widened`, `narrowed` — and
   * leaves `agree` and `pre-existing` off, which is what makes a white
   * `isNew` casing mean something when it appears.
   *
   * A RUN IS DRAWN AS THE BORDER, NEVER AS THE CHORD BETWEEN ITS ENDS.
   * `Run.geometry` is this run's own stretch of the line, every vertex of it,
   * and js/seams.js computes it with `sliceString` for exactly this
   * (docs/contracts.md § 5). A jurisdiction line is not straight — the
   * Missouri carries the SD/NE border for 200 km — so a two-point chord draws
   * the seam through the wrong state, and `seams-casing`'s five white pixels,
   * which mean "the published map did not have this step", land on ground
   * neither author was talking about. `[from, to]` survives as the fallback
   * for a run that carries no geometry, which is a straight two-point line
   * drawn honestly rather than nothing at all.
   *
   * Falls back, in order, to a geometry the engine attached (`geometry`, then
   * `line`), then to the edge effects' own `segments`. THE FALLBACK IS NOT
   * DECORATION: a seam whose far side is the published week may have no runs at
   * all, and a seam with no geometry is a finding the map cannot show.
   */
  function seamPieces(seam) {
    const runs = Array.isArray(seam?.runs) ? seam.runs : [];
    const marked = runs.filter((r) => r && r.kind !== 'agree' && r.kind !== 'pre-existing');
    const drawable = marked.filter((r) => runCoordinates(r).length >= 2);
    if (drawable.length) {
      return drawable.map((r) => ({
        geometry: { type: 'LineString', coordinates: runCoordinates(r) },
        isNew: r.kind === 'new',
        step: r.step ?? null,
        lengthKm: r.lengthKm ?? null,
      }));
    }
    const whole = seam?.geometry ?? seam?.line ?? segmentsOf(seam);
    if (!whole) return [];
    return [{
      geometry: whole,
      isNew: seam?.isNew === true,
      step: seam?.maxStep ?? null,
      lengthKm: seam?.lengthKm ?? null,
    }];
  }

  /**
   * A run's coordinates: its own stretch of the border, or the chord.
   *
   * `r.geometry?.coordinates ?? [r.from, r.to]` with the ends checked, because
   * a run that carries neither is not drawable at all and must not become a
   * `LineString` with an `undefined` in it — MapLibre answers that by dropping
   * the whole source, silently.
   */
  function runCoordinates(run) {
    const coords = run?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) return coords;
    return (Array.isArray(run?.from) && Array.isArray(run?.to)) ? [run.from, run.to] : [];
  }

  /** Every `edgeEffects[].segments` on a seam, as one MultiLineString. */
  function segmentsOf(seam) {
    const strings = [];
    for (const e of seam?.edgeEffects ?? []) {
      for (const line of lineStringsOf(e?.segments)) strings.push(line);
    }
    return strings.length ? { type: 'MultiLineString', coordinates: strings } : null;
  }

  /** A LineString or MultiLineString (or a Feature around one) as arrays. */
  function lineStringsOf(geometry) {
    const g = geometry?.type === 'Feature' ? geometry.geometry : geometry;
    if (g?.type === 'LineString') return [g.coordinates];
    if (g?.type === 'MultiLineString') return g.coordinates;
    if (g?.type === 'GeometryCollection') {
      return (g.geometries ?? []).flatMap(lineStringsOf);
    }
    return [];
  }

  /** A patch's anchor, or a point the map can put a letter on. `anchor` is an
   *  INTERIOR point the engine chose, never a centroid — a USDM polygon is
   *  wildly concave and its centroid is regularly outside it. */
  function anchorPoint(patch) {
    const a = patch?.anchor;
    if (Array.isArray(a) && a.length >= 2 && Number.isFinite(a[0])) return [a[0], a[1]];
    if (Array.isArray(a?.coordinates)) return a.coordinates.slice(0, 2);
    if (Array.isArray(a?.geometry?.coordinates)) return a.geometry.coordinates.slice(0, 2);
    try {
      const p = T().pointOnFeature({ type: 'Feature', properties: {}, geometry: patch.geometry });
      return p?.geometry?.coordinates ?? null;
    } catch {
      return null;
    }
  }

  /** A bbox out of whatever `focus` was handed. */
  function bboxOf(target) {
    if (!target) return null;
    if (Array.isArray(target) && target.length >= 4 && target.every((n) => Number.isFinite(n))) {
      return target.slice(0, 4);
    }
    if (Array.isArray(target.bbox) && target.bbox.length >= 4) return target.bbox.slice(0, 4);
    /* A SEAM HAS NO BBOX AND NO GEOMETRY of its own (docs/contracts.md § 5 —
       it carries runs), so the pieces the map draws for it are also the pieces
       a fit should frame. Without this branch "Zoom" on a seam card does
       nothing, which reads as a dead button. */
    if (Array.isArray(target.runs) || target.sideA || target.sideB) {
      const lines = seamPieces(target).flatMap((p) => lineStringsOf(p.geometry));
      const box = bboxOfCoordinates(lines.flat());
      if (box) return box;
    }
    const geometry = target.geometry ?? (target.type && target.coordinates ? target : null);
    if (!geometry) {
      /* Last resort: a finding that carries only its anchor still frames, at a
         degree box the `maxZoom` then pulls back in. */
      const at = Array.isArray(target.anchor) ? target.anchor : null;
      return at && Number.isFinite(at[0])
        ? [at[0] - 0.25, at[1] - 0.25, at[0] + 0.25, at[1] + 0.25]
        : null;
    }
    /* Polygons through `indexParts`, which is a bbox scan and already indexed;
       anything else (a seam's lines) through turf, which is linear. */
    const polygonBox = envelopeOf(indexParts(geometry));
    if (polygonBox) return polygonBox;
    try {
      return T().bbox({ type: 'Feature', properties: {}, geometry }).slice(0, 4);
    } catch {
      return null;
    }
  }

  /* ══ Clicks ═══════════════════════════════════════════════════════════════ */

  if (typeof onPick === 'function') {
    map.on('click', (e) => {
      onPick(hitTest([e.lngLat.lng, e.lngLat.lat]), e);
    });
  }

  /* ══ The surface ══════════════════════════════════════════════════════════ */

  const surface = Object.freeze({
    /** A GETTER, because `ready` is assigned below this object — see its
     *  declaration for the boot this arrangement exists to survive. */
    get ready() { return ready; },
    setPublished, setPick, setShown, setAois,
    setFindings, setSeams, setPatches,
    setView, highlight, focus, hitTest, restyleForTheme,
    /** What is in one of the four viewer sources right now. The only way back
     *  out, because `map.getSource(id)._data` is not GeoJSON in v5. */
    sourceFC: (id) => painted[id] ?? null,
    /** Breadcrumbs for tools/verify.mjs. */
    get view() { return state.view; },
    get lastPunchMs() { return lastPunchMs; },
    status: () => ({ added, anchors: anchorsStatus, view: state.view, punchMs: lastPunchMs }),
  });

  /* THE LAST STATEMENT, and the only safe place for it: `attach()` returns
     `surface`, so nothing may run it before the line above.

     Either construction order works. A caller who builds this AFTER the
     vendored stack is up (js/app.js does) pays one `getSource` lookup and the
     layers are on the map before `createMapView` returns, so a setter called on
     the next line paints immediately. A caller who builds it BEFORE gets the
     stack built first and the setters queue until `ready` — `setData` stores
     into `painted` either way, and `repaintAll()` flushes. */
  if (map.getSource('usdm')) {
    ready = Promise.resolve(attach());
  } else {
    ready = layers.addAll().then(attach);
  }

  return surface;
}

/* ══ Module-scope helpers ═════════════════════════════════════════════════════
   Outside the closure because they hold no map state and because the punch's
   cache is a fact about the WEEK and the WORKING AREA, not about one view — a
   second map (a test harness, a future side-by-side) should hit the same one.
   ══════════════════════════════════════════════════════════════════════════ */

/** Cached on `(week, aoi.id)`. Module scope rather than the view's closure
 *  because a punch is a fact about the WEEK and the WORKING AREA and not about
 *  one view: a second map — a test harness, a future side-by-side — should hit
 *  the same cache rather than pay the half-second again. `createMapView` times
 *  the CALL, so the cost still reaches `lastPunchMs` from here. */
let punchCache = { key: null, bands: null };

/**
 * The published bands with one working area cut out of them.
 *
 * The editor's `app.js:616–632`, as a wrapper rather than an edit to the
 * vendored copy. `differenceNear` splits each band's parts into FAR (bounding
 * box misses the AOI, so the difference would return them unchanged) and NEAR,
 * and hands the clipper only the near group — which is the difference between
 * half a second and an unusable map.
 *
 * Measured 418–572 ms for one state over the five national bands. Cached on
 * `(week, aoi.id)`, so it is paid once per working area and never per view
 * change, per selection or per frame.
 */
export function punchBands(bands, aoi, week) {
  if (!bands) return null;
  if (!aoi?.geometry) return bands;
  const key = `${week ?? ''}|${aoi.id ?? `${aoi.kind}:${aoi.value ?? ''}`}`;
  if (punchCache.key === key) return punchCache.bands;
  const out = {};
  for (const c of CLASSES) {
    const g = bands[c];
    out[c] = g ? differenceNear(g, aoi.geometry) : null;
  }
  punchCache = { key, bands: out };
  return out;
}

/**
 * The signed step from the published class to the side that departed furthest.
 *
 * The change ramp is signed — degradation warm, improvement cool — so a region
 * needs ONE number, and the honest one is the bigger departure: a piece where
 * one proposal left the class alone and the other moved it two steps is a
 * two-step disagreement, whatever the quiet side did.
 *
 * ON A TIE (published D1, one side D0 and the other D2) it takes the
 * DEGRADATION. Both readings are defensible and the tie has to break
 * somewhere; degradation is the half of the ramp a reviewer is looking for,
 * and a finding that reads as "worse" and turns out to be an argument about
 * better is a smaller surprise than the other way round. Recorded so nobody
 * re-derives it from the pixels.
 *
 * Exported for tools/marks.test.mjs and for anything that needs the same number
 * without a map.
 */
export function deltaFor(region) {
  const p = ordOf(region?.published);
  const a = ordOf(region?.classA);
  const b = ordOf(region?.classB);
  if (p === null) return 0;
  const da = a === null ? 0 : a - p;
  const db = b === null ? 0 : b - p;
  if (Math.abs(da) === Math.abs(db)) return Math.max(da, db);
  return Math.abs(da) > Math.abs(db) ? da : db;
}

/** `LEVELS`'s ordinal — none = −1, D0 = 0 … D4 = 4 (docs/contracts.md § 1).
 *  `null` for anything that is not a level, which is a DIFFERENT answer from
 *  `'none'` and callers must not collapse the two. */
function ordOf(level) {
  if (level === 'none') return -1;
  if (typeof level !== 'string') return null;
  const i = CLASSES.indexOf(level);
  return i === -1 ? null : i;
}

/**
 * The proposal id a seam side carries, or null.
 *
 * A `Side` (docs/contracts.md § 5) is one of three kinds, and only `'proposal'`
 * has an author behind it: `'published'` is the week NDMC shipped and
 * `'unknown'` is a week the archive would not give up. NULL IS THE RIGHT ANSWER
 * for both — a side nobody proposed cannot be hidden, so `isShown(null)` is
 * true and a one-sided seam never dims itself.
 */
function sideProposalId(side) {
  return side?.proposal?.id ?? side?.proposalId ?? null;
}

/** The envelope of a flat list of `[lng, lat]`, or null for an empty one. */
function bboxOfCoordinates(coords) {
  let box = null;
  for (const c of coords) {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    if (!box) { box = [c[0], c[1], c[0], c[1]]; continue; }
    if (c[0] < box[0]) box[0] = c[0];
    if (c[1] < box[1]) box[1] = c[1];
    if (c[0] > box[2]) box[2] = c[0];
    if (c[1] > box[3]) box[3] = c[1];
  }
  return box;
}

/** Uniform padding — the default when the caller has no card to clear. */
function uniformPadding(base) {
  return { top: base, right: base, bottom: base, left: base };
}

/**
 * Has this reader asked for less motion?
 *
 * READ AT EVERY FIT, never cached: the setting is a system preference a reader
 * can change while the page is open, and a value captured at boot would keep
 * flying the camera at somebody who has just turned it off. Guarded, because
 * `matchMedia` is absent under Node, where this module's helpers are read.
 */
function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/** `performance.now()` where there is one, `Date.now()` where there is not. */
function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}
