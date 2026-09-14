/* ══ The layer ladder ═══════════════════════════════════════════════════════
   USDM Editor · js/layers.js

   Every MapLibre source and layer this app owns, and the order they stack in.
   `createLayerStack(map, deps)` returns the whole surface: `addAll`, the
   repaints, the three display modes (`setMapView`), `restyleForTheme`, and
   `boundariesFC` / `bandsFC` / `editBandsFC` for the PNG export.

   ONE function builds the whole stack, in one order, on both boots, around one
   ANCHOR — the basemap's first symbol (label) layer. Bottom to top:

     CARTO Positron ground        (or the blank `bg` layer, degraded)
     hillshade                    added by addHillshade(), under the anchor
     usdm-fill-D0 … D4            the published week, WORKING AREA PUNCHED OUT
     usdm-line-D0 … D4            its class edges
     usdm-edit-fill-D0 … D4       the PROPOSAL, inside the working area
     usdm-edit-line-D0 … D4       its class edges
     usdm-change-fill             hidden; the change VIEW replaces the four above
     hillshade-over               achromatic relief, over every fill
     ── the anchor: the basemap's first symbol layer ──
     CARTO place labels           above the drought
     aoi-dim                      everything OUTSIDE the working area
     band-dim                     while a scoped verb is armed: ground it can't reach
     band-line                    …and the dotted boundary of the band it CAN
     boundary-county              (best-effort) FSA LFP PMTiles, lands after boot
     boundary-state               (best-effort)
     boundary-nation              (best-effort) the country's outer edge
     boundary-aiannh              (best-effort) tribal areas, drawn always
     changes-line-casing/-line/-active   the change list's patches
     aoi-line-casing              white casing under…
     aoi-line                     …the working-area boundary itself

   The two class groups are ONE continuous map with a seam at `aoi-line`: same
   ramp, same 1.0, never overlapping by construction — see `SRC_EDIT`.

   Place labels ride ABOVE the drought: a symbol REPLACES pixels rather than
   blending, so no class is re-read as its neighbour. Fills below, symbols
   above (see CLAUDE.md, which also lists every sanctioned paint over the
   classes — the two living here are `hillshade-over` and `usdm-change-fill`).

   `setMapView` answers 'proposal', 'changes' and 'published'. Published is a
   DATA SWAP, not a hide: the working area is punched out of `usdm-fill-*`, so
   js/app.js feeds `usdm-edit-*` the area's published bands (already held —
   no geometry cost) and hides `EDIT_MARKS`. Exactly one group covers any
   pixel in every view.

   Degraded boots take the same path: `firstSymbolLayerId()` returns undefined
   and `addLayer(layer, undefined)` APPENDS — the anchor collapses to "the
   top" with no second code path.

   Nothing here reaches into js/app.js's state: every repaint takes its data
   as an ARGUMENT. `topojson` is the one injected dep (a vendored global from
   index.html), named in `deps` so a caller can hand in its own.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  CLASSES, USDM_COLORS, USDM_CHANGE_COLORS, USDM_CHANGE_LABELS, CHANGE_STEPS,
} from './color.js';
import { cssVar } from './dom.js';
import {
  addHillshadeOver, firstSymbolLayerId, labelLayerIds, restyleHillshade, waterLayerIds,
} from './basemap.js';
import { aoiMask, loadKindTopology } from './aoi.js';

/* Source ids. The two that are EXPORTED are the two js/export-png.js reuses when
   it rebuilds this picture on its own off-screen map; the rest never leave. */

/** The published week's bands — WITH THE WORKING AREA PUNCHED OUT. See `SRC_EDIT`. */
export const SRC = 'usdm';
/**
 * The proposal's own bands, inside the working area only.
 *
 * Not an overlay (see CLAUDE.md's no-fill exceptions): the same `js/color.js`
 * ramp at 1.0, painting DIFFERENT GEOMETRY inside a region whose edge
 * `aoi-line` already draws. It never doubles the published fills because the
 * working area is PUNCHED OUT of them — exactly one rendering covers any
 * pixel: `SRC` outside, `SRC_EDIT` inside (verify § 3c).
 *
 * WHY IT MUST BE SCOPED: `deriveBands` over one state's contours costs
 * 14.8 ms (fits the 250 ms debounce and 500 ms per-commit budget); NATIONALLY
 * it costs 7,667 ms, so nothing may ever repaint the nation per edit. The
 * punch is what makes the scoped version complete rather than additive:
 * without it, ground IMPROVED out of a class keeps its published colour and
 * the edit changes nothing on screen. Punching one state out of the five
 * national bands costs 418–572 ms, paid once per (week, AOI).
 *
 * The published VIEW feeds this same source the working area's published
 * bands, so the whole map reads published with no seam.
 */
const SRC_EDIT = 'usdm-edit';
/** The vendored state + nation meshes (vendor/aoi/states.json). */
export const SRC_BOUNDARY = 'boundaries';
/** The county reference tiles — the ONE boundary source that streams. */
const SRC_COUNTY = 'county-tiles';
/** The change list's own patches, as outlines. */
const SRC_CHANGES = 'usdm-changes';
/** The change map: one feature per class-change level (js/delta.js). */
const SRC_DELTA = 'usdm-delta';
/** Tribal-area outlines, drawn always. */
const SRC_TRIBAL = 'tribal-boundaries';
/** The band-dim mask: ground a scoped verb cannot reach, while one is armed. */
const SRC_BAND_MASK = 'band-mask';

/** The reachable band itself, outlined — the positive half of the same answer. */
const SRC_BAND_REACH = 'band-reach';

/** The three display modes the whole ladder answers to. See `setMapView`. */
const VIEWS = Object.freeze(['proposal', 'changes', 'published']);

/**
 * What the published view takes off the map: the change patches and the
 * working-area outline (the published week had no working area in it;
 * `aoi-dim` stays so the scope still reads as a knockdown). The class fills
 * can never be in here — the published view SWAPS what `usdm-edit-*` paints
 * rather than hiding it, because the area is cut out of the published fills
 * and something must cover it in every view.
 */
const EDIT_MARKS = Object.freeze([
  'changes-line-casing', 'changes-line', 'changes-line-active',
  'aoi-line-casing', 'aoi-line',
]);

/**
 * Run something once the browser is not busy — after boot, in practice.
 *
 * `requestIdleCallback` with a TIMEOUT, and a `setTimeout` fallback for Safari,
 * which has never shipped it. The timeout is what makes this safe to rely on: a
 * page that never goes idle still runs the callback, just later.
 */
const afterBoot = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 4000 })
  : setTimeout(fn, 1200));

/**
 * The FSA LFP county boundaries, as a PMTiles archive on the origin the app
 * already trusts for the USDM archive itself (connect-src is unchanged; a
 * PMTiles file is data MapLibre reads over range requests, not code). z0–13,
 * true EPSG:4326; source-layers `counties` (polygons; `id` = 5-digit FIPS
 * STRING, so the MVT integer id slot is deliberately empty and `promoteId`
 * is required) and `states` (innerlines, unused — the vendored mesh serves
 * the PNG export too, which tiles cannot).
 */
const COUNTY_TILES_URL = 'https://data.sustainable-fsa.com/data-tiles/tiles/fsa-lfp-counties-geo.pmtiles';

/* The tiles carry POLYGONS, so a line layer draws every interior county edge
   twice — once per neighbour — while the old mesh drew it once. Compounding
   the translucent token through two passes at layer opacity o gives
   1−(1−a·o)², and o = 0.54 solves that back to a for a = 0.25: interior edges
   render exactly as the one-pass mesh did (the approximation holds across the
   themes' alphas), and the coastline, drawn once, sits at a faint a·o under
   the state/nation/aoi lines that own that edge. */
const COUNTY_EDGE_OPACITY = 0.54;

/* The one view the county grid is not drawn in. The national pose is z3.4
   (NATIONAL_POSE, js/app.js); 4 is the first step above it, and a working area
   of any kind fits well past it. See the layer for why a floor came back after
   the old `minzoom: 5` was deliberately removed. */
const COUNTY_MINZOOM = 4;

/**
 * Register the pmtiles:// protocol from the vendored bundle, once.
 *
 * A LAZY RELATIVE import behind `.catch(() => null)` — the Squire pattern: no
 * import-map entry (the CSP hashes stay untouched), and a vendor 404 degrades
 * to exactly what a blocked remote fetch costs — the county lines — instead of
 * taking the module graph down. Module-scoped so a second `createLayerStack`
 * (the PNG export's off-screen map) can never double-register.
 */
let pmtilesProtocol = null;

/** Where the county tiles got to: 'pending' → 'added', or 'unavailable' (the
    vendored bundle failed to import) or 'failed' (anything after it threw).
    A debug breadcrumb (`__usdm.countyTiles`), because every failure here is
    deliberately quiet and the tests should not have to race afterBoot. */
let countyTilesStatus = 'pending';

async function ensurePmtilesProtocol() {
  if (pmtilesProtocol) return true;
  const maplibre = globalThis.maplibregl;
  if (!maplibre) return false;
  const mod = await import('../vendor/pmtiles-4.5.0/pmtiles.esm.js').catch(() => null);
  if (!mod?.Protocol) return false;
  pmtilesProtocol = new mod.Protocol();
  maplibre.addProtocol('pmtiles', pmtilesProtocol.tile);
  return true;
}

/** A fresh empty FeatureCollection every time. Not one shared constant:
 *  MapLibre keeps the object it is handed, and two sources sharing one is a
 *  hazard for the price of nothing. */
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

/* ── The class SEPARATOR ────────────────────────────────────────────────────
   A very thin WHITE line on every class edge — published (`usdm-line-*`),
   proposed (`usdm-edit-line-*`) and exported (`x-line-*`). Not a fill and not
   a mark an author acts on: it separates two fills, like a USDM figure's own
   class casing, and it is the only WHITE line on the map.

   Honest weakness: white against D0's `#ffff00` is a luminance ratio of about
   1.07, so D0's OUTER edge is the faintest line on screen. Interior edges all
   read (opaque fills, adjacent ramp steps); a dark casing for that one edge
   would cost ten layers, and `aoi-line` already draws the edge an author
   works inside.

   Zoom-interpolated: a flat width readable at state zoom fuzzes the national
   contours into white haze at z3. js/export-png.js carries the same values;
   if one moves, both move.

   A LITERAL, NOT A TOKEN — same call as the ramp: it separates two published
   class colours, so it is DATA, not chrome, and a theme must not move it. It
   is achromatic, the same ground `hillshade-over` stands on. */
export const CLASS_LINE_PAINT = Object.freeze({
  'line-color': '#ffffff',
  'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 9, 1.1],
  'line-opacity': 0.9,
});

/** Bands → a FeatureCollection MapLibre can paint, one feature per class. */
export function bandsToFC(bands) {
  return {
    type: 'FeatureCollection',
    features: CLASSES.filter((c) => bands[c]).map((c) => ({
      type: 'Feature', properties: { usdm_class: c }, geometry: bands[c],
    })),
  };
}

/**
 * Build the app's layer stack over an already-loaded map.
 *
 * @param {maplibregl.Map} map
 * @param {object} [deps]
 * @param {object} [deps.topojson]  the vendored topojson-client; defaults to the
 *                                  global index.html installs as a classic script.
 */
export function createLayerStack(map, { topojson = globalThis.topojson } = {}) {
  /* The state mesh, kept here once it is built.
     Held in the closure rather than read back out of the source at use time:
     `map.getSource(id)._data` is a MapLibre PRIVATE field and in v5 it is not
     GeoJSON at all — it holds `{ geojson: … }`, truthy and unparseable. The PNG
     export was reading it, and had been exporting figures with no state lines
     on them. See `boundariesFC()` and js/export-png.js. */
  let boundaries = null;

  /** Which display mode the map is in. One of `VIEWS`; 'proposal' by default. */
  let view = 'proposal';
  /** The delta FeatureCollection currently in `usdm-delta`, for the export. */
  let deltaData = emptyFC();
  /* The two class FeatureCollections currently on the map, for the export. Same
     closure-not-`_data` reason as `boundaries` above. See `bandsFC`. */
  let bandsData = null;
  let editBandsData = null;

  /**
   * Every layer this app owns, in order, over whatever ground it was given.
   *
   * Called once from boot(), after `addHillshade(map)` — which inserts under the
   * same anchor, and therefore ends up beneath everything added here. Relief
   * belongs to the ground.
   */
  async function addAll() {
    /* Read ONCE. Each `addLayer` inserts immediately before this id, so the
       later a layer is added the closer to the anchor it sits — which is exactly
       the order the list below is written in. */
    const beforeLabels = firstSymbolLayerId(map);

    map.addSource(SRC, { type: 'geojson', data: emptyFC() });

    /* One fill layer per class rather than one data-driven layer, because draw
       order matters: painting D0 first and D4 last puts the worse class's casing
       on top, which is how every published USDM map reads. */
    for (const c of CLASSES) {
      map.addLayer({
        id: `usdm-fill-${c}`, type: 'fill', source: SRC,
        filter: ['==', ['get', 'usdm_class'], c],
        /* FULLY OPAQUE. Terrain under a translucent fill modulates it — the
           same D2 reads as two oranges over a lit ridge and a shaded valley —
           and a fixed published palette must never be modulated by accident.
           Terrain reads through via `hillshade-over` instead: one achromatic
           layer with a known alpha (js/basemap.js), auditable where a
           translucent fill over arbitrary tiles is not; move this to 0.85 and
           you get both, compounded. `x-fill-*` in js/export-png.js carries
           the same value; if one moves, both move. */
        paint: { 'fill-color': USDM_COLORS[c], 'fill-opacity': 1 },
      }, beforeLabels);
    }


    for (const c of CLASSES) {
      map.addLayer({
        id: `usdm-line-${c}`, type: 'line', source: SRC,
        filter: ['==', ['get', 'usdm_class'], c],
        paint: { ...CLASS_LINE_PAINT },
      }, beforeLabels);
    }

    /* THE PROPOSAL, inside the working area. Same ramp, same 1.0, same class
       order — the two groups are one continuous map with a seam at `aoi-line`,
       and every reason the published paints are what they are applies unchanged.
       See `SRC_EDIT` for why this is allowed to exist at all. */
    map.addSource(SRC_EDIT, { type: 'geojson', data: emptyFC() });
    for (const c of CLASSES) {
      map.addLayer({
        id: `usdm-edit-fill-${c}`, type: 'fill', source: SRC_EDIT,
        filter: ['==', ['get', 'usdm_class'], c],
        paint: { 'fill-color': USDM_COLORS[c], 'fill-opacity': 1 },
      }, beforeLabels);
    }
    for (const c of CLASSES) {
      map.addLayer({
        id: `usdm-edit-line-${c}`, type: 'line', source: SRC_EDIT,
        filter: ['==', ['get', 'usdm_class'], c],
        paint: { ...CLASS_LINE_PAINT },
      }, beforeLabels);
    }

    addChangeFillLayer(beforeLabels);

    /* THE LAST THING UNDER THE ANCHOR, and that is the whole design: relief
       over every fill, under every label. See js/basemap.js § Hillshade, over
       for why a second hillshade is allowed above a published palette when
       nothing else is. */
    addHillshadeOver(map, beforeLabels);

    /* ── Above the drought, from here down ──────────────────────────────── */

    addAoiLayers();
    addBandDimLayer();
    await addBoundaryLayers();
    /* Separate from `addBoundaryLayers`, which returns early when the atlas
       is unreachable — the tribal outlines read their own file. NOT awaited,
       and that is load-bearing: the function adds its source and layer
       SYNCHRONOUSLY and only then awaits the fetch, so the ladder slot is
       claimed in order while the 639 KB download arrives whenever it arrives.
       (`addBoundaryLayers` IS awaited: it needs geometry before it can add
       anything.) */
    addTribalBoundaryLayer();


    /* `changes-line-*` goes here, before `aoi-line`, so the working-area
       boundary stays the topmost of the app's own MARKS — readable as a
       boundary rather than one line among several. The basemap labels and
       Terra Draw's handles are still raised above all of them. */
    addChangeLayers();

    addAoiOutline();

    /* LAST, and the only safe place: any layer added after this call lands
       back on top of the place names. There should be nothing below this
       line. */
    raiseReferenceGeography();
  }

  /* ══ The change VIEW ══════════════════════════════════════════════════════
     NDMC's other published product — how many classes each place moved — in
     NDMC's own ramp (js/color.js § The CHANGE palette; polygons from
     js/delta.js): the units a reviewer already reads every Thursday.

     Not a violation of the no-fill rule: a MODE, not an overlay.
     `setMapView('changes')` hides `usdm-fill-*`/`usdm-line-*`, so no class
     colour is on screen to blend with. Every level's NAME rides in the legend
     because this ramp diverges in hue too.

     "No change" is deliberately unpainted — NDMC's #cccccc exists because a
     PNG has nothing underneath; this app has the basemap and terrain — and
     the legend carries "No change — unshaded" so the encoding stays complete.
     See CLAUDE.md. */

  /**
   * One data-driven fill over the ten change levels, hidden until asked for.
   *
   * One layer rather than ten: unlike the class fills there is no draw-order
   * argument here — the diagonals of a change map are DISJOINT by construction
   * (js/delta.js), so no two of them can overlap and there is nothing for a
   * stacking order to decide.
   */
  function addChangeFillLayer(beforeLabels) {
    map.addSource(SRC_DELTA, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'usdm-change-fill', type: 'fill', source: SRC_DELTA,
      layout: { visibility: 'none' },
      paint: {
        /* Built from js/color.js, never hand-typed: the ramp is DATA and there
           must be exactly one copy of it. A level with no colour falls to
           'transparent' rather than to MapLibre's default black, so a delta
           this app does not know about paints nothing instead of paving the
           working area. */
        'fill-color': ['match', ['get', 'delta'],
          ...CHANGE_STEPS.flatMap((s) => [Number(s), USDM_CHANGE_COLORS[s]]),
          'transparent'],
        'fill-opacity': 1,
      },
    }, beforeLabels);
  }

  /**
   * Which of the three things the map is showing. Returns the view applied.
   *
   *   proposal   the class fills, with every edit mark on top
   *   changes    NDMC's class-change encoding instead of the fills
   *   published  the same two fill groups, the edited one fed PUBLISHED bands
   *
   * Between proposal and changes it moves the fills and the class edges and
   * nothing else: `changes-line-*`, `aoi-*` and everything Terra Draw owns
   * are OUTLINES, and an outline says the same true thing in both views —
   * hiding them would take the map's vocabulary away when it is most needed.
   *
   * The published view's data swap is made in js/app.js (`renderEditBands`
   * feeds `usdm-edit-*` the working area's published bands) — see the file
   * header. What this cannot take off the map is Terra Draw's own outlines:
   * `td-*` layers belong to the adapter, and this module owns every layer id
   * the app names. The editor empties its store instead — `editor.setDormant`.
   *
   * The caller supplies the geometry (`setDeltaData`) and the words (the legend,
   * the live region): this module knows about layers.
   */
  function setMapView(next) {
    const want = VIEWS.includes(next) ? next : 'proposal';
    if (want === view) return view;
    view = want;
    const changes = view === 'changes';
    const published = view === 'published';
    setVisible(CLASSES.map((c) => `usdm-fill-${c}`), !changes);
    setVisible(CLASSES.map((c) => `usdm-line-${c}`), !changes);
    /* The edit group hides with the published group and for the same reason:
       the change view paints NDMC's other encoding and no class colour may be on
       screen to be confused with it. It does NOT hide in the published view —
       there it is fed the working area's published bands instead, because the
       working area has been cut out of `SRC` and something has to cover it. */
    setVisible(CLASSES.map((c) => `usdm-edit-fill-${c}`), !changes);
    setVisible(CLASSES.map((c) => `usdm-edit-line-${c}`), !changes);
    setVisible(['usdm-change-fill'], changes);
    setVisible(EDIT_MARKS, !published);
    return view;
  }

  function getMapView() { return view; }

  /**
   * Hand over the change map's polygons, as one feature per level.
   *
   * `delta` is a NUMBER because the paint matches on one; the label rides along
   * so anything querying the rendered feature — a future hover readout, an
   * export — has the name without re-deriving it from the number.
   *
   * @param {object|null} deltas  `deriveChangeMap().deltas`, or null to clear
   */
  function setDeltaData(deltas) {
    deltaData = {
      type: 'FeatureCollection',
      features: CHANGE_STEPS
        .filter((s) => deltas?.[s])
        .map((s) => ({
          type: 'Feature',
          properties: { delta: Number(s), label: USDM_CHANGE_LABELS[s] },
          geometry: deltas[s],
        })),
    };
    map?.getSource(SRC_DELTA)?.setData(deltaData);
  }

  /** What is in the change source right now. The PNG export's only way to it. */
  function deltaFC() { return deltaData; }

  /* ── `baseline-fill-*` and `holdPublished(on)` stay RETIRED ───────────────
     They painted the published week clipped to the working area at 0.85 while
     the class fills painted the nation at 1.0 — two renderings, two extents,
     two opacities, all called "Published". `setMapView('published')` replaced
     them: one source, one opacity, one extent. Do not revive them (the hold
     also had no `aria-pressed` and could not be left on). See CLAUDE.md. */

  /** Set `visibility` on a list of layers, skipping any that are absent. */
  function setVisible(ids, on) {
    for (const id of ids) {
      if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }

  /**
   * The change list's patches, as OUTLINES — "show me Change 3" needs ground
   * marked, and a fill over the classes is the house rule's exact failure
   * (see CLAUDE.md).
   *
   * THE COLOUR IS NOT A CLASS COLOUR, and cannot be: a patch may span several
   * classes at once, so no single class's colour would be honest.
   * `--text-primary` over a white casing is neutral in both themes and
   * visibly not part of the ramp; the active patch takes `--selection-ring` —
   * what everything selected already wears — plus a dash of its own, because
   * Terra Draw wears that colour too on the same ground (see below).
   *
   * Three layers, not two: the active patch must win on width AND colour, and
   * a filter on one layer cannot paint two widths.
   */
  function addChangeLayers() {
    map.addSource(SRC_CHANGES, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'changes-line-casing', type: 'line', source: SRC_CHANGES,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'changes-line', type: 'line', source: SRC_CHANGES,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': cssVar('--text-primary', '#1a1a1a'),
        'line-width': 1.4, 'line-dasharray': [2, 1.5],
      },
    });
    map.addLayer({
      id: 'changes-line-active', type: 'line', source: SRC_CHANGES,
      layout: { 'line-join': 'round' },
      /* Matches nothing until a change is chosen. An empty literal array is a
         haystack no key can be in, so this is a filter that is off rather than
         a layer that is missing — and a missing layer is what a `setFilter`
         would throw on. Plural from the start, because the Explain step
         highlights a SELECTION of changes and a one-key filter cannot say
         "these three". */
      filter: ['in', ['get', 'key'], ['literal', []]],
      paint: {
        'line-color': cssVar('--selection-ring', '#1f3f9e'),
        /* WIDER THAN TERRA DRAW'S OUTLINE, AND DASHED. Terra Draw paints the
           polygon being edited in this same `--selection-ring`, SOLID, 2 px
           unselected / 4 px selected, on layers added later — and a patch edge
           usually runs along an edited boundary, so the two would otherwise be
           one indistinguishable line. A second selection colour is not the
           answer (the token means "the thing you picked"), so the marks differ
           by SHAPE: 6 px stands proud of 4 px on both sides, and the dash is
           the patch outline riding over the continuous geometry beneath it.

           `line-dasharray` is in units of LINE WIDTH: [1.4, 1] at 6 px is an
           8.4 px dash / 6 px gap — legible at state zoom, and nothing like
           `changes-line`'s [2, 1.5] at 1.4 px (2.8 / 2.1 px). */
        'line-width': 6,
        'line-dasharray': [1.4, 1],
      },
    });
  }

  /**
   * Redraw the patch outlines from the tracker's patch list.
   *
   * Called from `recomputeChanges`, which is the single place the patch list is
   * ever re-derived — so the outlines cannot describe a different list from the
   * panel beside them.
   */
  function renderChangeOutlines(patches) {
    const src = map?.getSource(SRC_CHANGES);
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: (patches ?? []).map((p) => ({
        type: 'Feature',
        properties: { key: p.key, seq: p.seq },
        geometry: p.geometry,
      })),
    });
  }

  /**
   * Highlight a SET of changes, or none.
   *
   * `['in', value, ['literal', […]]]` over an array haystack, so one filter
   * serves one change and twenty. An empty array matches nothing, which is the
   * same "filter that is off" property the single-key sentinel had.
   *
   * @param {string[]} keys
   */
  function setActiveChanges(keys) {
    if (!map?.getLayer('changes-line-active')) return;
    map.setFilter('changes-line-active',
      ['in', ['get', 'key'], ['literal', Array.isArray(keys) ? keys.filter(Boolean) : []]]);
  }

  /** One change, or none. Sugar over the plural call — one filter, one shape. */
  function setActiveChange(key) {
    setActiveChanges(key ? [key] : []);
  }

  /* ── `usdm-working-*` LIVED HERE and stays retired ──────────────────────
     It outlined every dirty class because the fills once ignored edits; the
     fills follow the proposal now (`usdm-edit-fill-*`/`-line-*`), so a heal
     is visible as a class covering different ground — the thing itself. Do
     not bring it back to mark "this class was edited": the fills and
     `changes-line-*` already carry both halves of that fact, and two marks
     for one fact is what the four-line-marks table (CLAUDE.md) prevents. */

  /**
   * The dim mask, and the source the outline reads from.
   *
   * Two sources rather than one because they carry different geometry for the
   * same area: `aoi` holds the polygon, `aoi-mask` holds the WORLD MINUS the
   * polygon. Deriving one from the other in a paint expression is not something
   * MapLibre can do.
   */
  function addAoiLayers() {
    map.addSource('aoi', { type: 'geojson', data: emptyFC() });
    map.addSource('aoi-mask', { type: 'geojson', data: emptyFC() });

    /* Legal because it never lands on the data: `aoiMask()` hands back a
       world rectangle with the AOI punched out (turf.mask), so every painted
       pixel is one the author is NOT editing — inside the working area the
       classes stay exactly as published. The alpha is baked into `--map-dim`,
       so one token owns the appearance in both themes. See CLAUDE.md's
       no-fill rule. */
    map.addLayer({
      id: 'aoi-dim', type: 'fill', source: 'aoi-mask',
      paint: { 'fill-color': cssVar('--map-dim', 'rgba(250,250,248,0.55)') },
    });
  }

  /**
   * The band-dim mask: while a scoped verb is armed, the ground it cannot
   * reach.
   *
   * WHY: a scoped verb acts on one band, and published bands are narrow —
   * median ~500 m for D0–D2, 25th percentile 300–500 m — so a big freehand
   * shape mostly refuses, which reads as the editor ignoring the gesture.
   *
   * A MASK, NOT A TINT: it dims everything ELSE, the same inversion and token
   * (`--map-dim`) as `aoi-dim`, so a class in the reachable band still reads
   * at exactly its published colour. The two never overlap (outside the AOI
   * vs a subset of the inside), so their relative order is inert; this sits
   * just after `aoi-dim`.
   *
   * TRANSIENT: empty until `renderBandMask` gets geometry; js/app.js empties
   * it on disarm, Escape, a finished shape, a class change, and in the change
   * and published views. This module never derives the geometry itself —
   * that needs the changeset and the current class, which it does not hold.
   * See CLAUDE.md's band-dim bullet.
   */
  function addBandDimLayer() {
    map.addSource(SRC_BAND_MASK, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'band-dim', type: 'fill', source: SRC_BAND_MASK,
      paint: { 'fill-color': cssVar('--map-dim', 'rgba(250,250,248,0.55)') },
    });
    /* The POSITIVE half of the same answer: the dim says where the gesture
       cannot act, this dots the boundary of the ~500 m band where it CAN. A
       LINE, never a fill — and a fifth mark, so it takes its own token and its
       own rhythm (dotted, no casing) to differ from each of the four in
       CLAUDE.md's line-marks table on at least two axes. Same slot, same
       transience, same renderer as the dim: the pair travel together or not
       at all. Where a band runs into the AOI edge this coincides with
       `aoi-line` — accepted; subtracting the edge would be a boolean op per
       arm for a cosmetic gain. */
    map.addSource(SRC_BAND_REACH, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'band-line', type: 'line', source: SRC_BAND_REACH,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': cssVar('--map-reach-line', '#0f5e66'),
        'line-width': 2,
        'line-dasharray': [0, 2],
      },
    });
  }

  /**
   * Paint (or clear) the band-dim mask and the reachable-band outline.
   *
   * ONE seam for the pair, deliberately: they answer the same question from two
   * sides, so they may never go transient separately.
   *
   * @param {object|null} geometry  the ILLEGAL ground — the working area minus
   *   whichever band the scoped verb can reach — or null to clear it. Always a
   *   FeatureCollection on the source, zero or one feature, matching every
   *   other source in this ladder rather than the bare Feature `renderAoi`
   *   hands `aoi`'s own outline source.
   * @param {object|null} reach  the band itself, whose boundary `band-line`
   *   dots — or null to clear it (also the honest value for the two empty
   *   verb×scope combinations, where nothing is reachable).
   */
  function renderBandMask(geometry, reach = null) {
    const wrap = (g) => g
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: g }] }
      : emptyFC();
    map?.getSource(SRC_BAND_MASK)?.setData(wrap(geometry));
    map?.getSource(SRC_BAND_REACH)?.setData(wrap(reach));
  }

  /**
   * The working-area boundary — the last thing on the canvas.
   *
   * A SCOPE IS NOT A SELECTION: `--selection-ring` means "the thing you
   * picked" (Terra Draw's outline, `changes-line-active`), and the working
   * area is the ground everything happens INSIDE — so it is neutral ink over
   * a white casing, told apart from `changes-line` by weight and rhythm. The
   * full four-mark table lives in CLAUDE.md.
   *
   * `line-dasharray` is in units of LINE WIDTH: [3,2] at 2.5 px is a 7.5 px
   * dash / 5 px gap — coarser and heavier than a change outline, which is the
   * right relationship: the scope contains the changes.
   *
   * Still no fill on the working area itself; see `addAoiLayers`.
   */
  function addAoiOutline() {
    map.addLayer({
      id: 'aoi-line-casing', type: 'line', source: 'aoi',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      /* White in both themes, like every other casing in this app: a casing is
         what makes a line readable over saturated data, and white is the only
         colour that does that against the whole USDM ramp at once. */
      paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'aoi-line', type: 'line', source: 'aoi',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': cssVar('--text-primary', '#1a1a1a'),
        'line-width': 2.5, 'line-dasharray': [3, 2],
      },
    });
  }

  /**
   * Tribal-area outlines, drawn ALWAYS: a tribal area is one of the two
   * jurisdictions work can be scoped to, so its edges are part of reading the
   * map rather than an aid to operating it.
   *
   * A LINE AND NOTHING ELSE. mco-web-style pairs this outline with a tinted
   * fill; that fill would break the no-fill rule, and the classes are opaque
   * anyway. The token carries its own alpha (`--map-tribal-line`).
   *
   * Best-effort: a failed fetch costs these lines and nothing else.
   */
  async function addTribalBoundaryLayer() {
    map.addSource(SRC_TRIBAL, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'boundary-aiannh', type: 'line', source: SRC_TRIBAL,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': cssVar('--map-tribal-line', 'rgba(122,79,36,0.55)'),
        /* Just above the county grade, and interpolated for the same reason:
           at national zoom 704 areas' worth of outline is noise, and the point
           of the layer is that the areas are FINDABLE, not that every parcel
           edge is legible from orbit. */
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 1.4],
      },
    });
    /* Same deferral as the counties, and for the same reason — see `afterBoot`
       in `addBoundaryLayers`. */
    afterBoot(async () => {
    try {
      /* Through js/aoi.js's kind cache, so previewing the outlines and choosing
         a tribal working area parse the 655 KB file once between them. */
      const topo = await loadKindTopology('aiannh');
      /* ── OFF-RESERVATION TRUST LAND IS NOT DRAWN ────────────────────────
         163 of the 867 features carry LSAD 'OT': scattered parcels already
         out of the AOI picker (`AIANNH_LSAD_DROP`, phase B of
         tools/build-aois.mjs) — drawing them showed outlines for areas the
         app refused to scope work to, as noise around the reservations.
         Filtered HERE, not in the vendored file: `vendor/aoi/aiannh.json`
         must keep matching the sibling usdm-aiannh product. The LSAD survives
         in the TopoJSON only as the id suffix (`${GNIS}-${LSAD}`), which is
         what this reads — never switch to a name match (CLAUDE.md). */
      const kept = {
        ...topo.objects.aiannh,
        geometries: (topo.objects.aiannh?.geometries ?? [])
          .filter((g) => !String(g.id ?? '').endsWith('-OT')),
      };
      /* The INTERIOR mesh would drop every outline that is not shared with
         another tribal area — which is nearly all of them, these being mostly
         non-contiguous. So the whole mesh, unfiltered by adjacency. */
      const mesh = topojson.mesh(topo, kept);
      map.getSource(SRC_TRIBAL)?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: mesh }],
      });
    } catch (err) {
      console.warn('[usdm] tribal-area boundaries unavailable', err);
    }
    });
  }


  /**
   * Reference boundaries — state and nation lines from the VENDORED
   * vendor/aoi/states.json, county lines from the FSA LFP PMTiles, always on.
   *
   * TRUE WGS84, and that is not a detail: the fleet's usual boundary source
   * (fsa-counties-dd22.topojson) is a shifted composite drawing Alaska at
   * 18–29°N off California, while the USDM draws it at 51–71°N — loading it
   * here would misalign silently. See vendor/VENDORED.md and
   * vendor/aoi/PROVENANCE.md. The AOI polygons come from this same file, so
   * the working-area boundary and the reference lines cannot disagree — and
   * the counties are the same FOIA'd product the states were dissolved from,
   * so the two grades share one coastline (NDMC's).
   *
   * BEST-EFFORT: this is awaited from `addAll`, and an unguarded fetch here
   * once threw all the way out of boot() — reference lines are context, and
   * losing them must not cost the map. The early return RETURNS; everything
   * after it in `addAll` still gets added, and every downstream reader checks
   * before touching these layers (`restyleForTheme`, `boundariesFC`).
   */
  async function addBoundaryLayers() {
    let states;
    try {
      states = await loadKindTopology('state');
    } catch (err) {
      console.warn('[usdm] state boundaries unavailable', err);
      return;   // no sources, no layers, no county loader — the map is still a map
    }
    /* INTERIOR mesh for the states (`(a, b) => a !== b` keeps only arcs two
       states share), and the WHOLE mesh for the nation — its arcs bound one
       object, so a filtered mesh would return nothing at all. */
    const statesMesh = topojson.mesh(states, states.objects.states, (a, b) => a !== b);
    const nationMesh = topojson.mesh(states, states.objects.nation);

    boundaries = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { kind: 'state' }, geometry: statesMesh },
        /* THE COUNTRY'S OUTER EDGE. Invisible over a basemap (CARTO draws a
           coastline), essential on the PNG export, which has no ground:
           without it Alaska and the Aleutians float in white space. */
        { type: 'Feature', properties: { kind: 'nation' }, geometry: nationMesh },
      ],
    };

    map.addSource(SRC_BOUNDARY, { type: 'geojson', data: boundaries });

    map.addLayer({
      id: 'boundary-state', type: 'line', source: SRC_BOUNDARY,
      filter: ['==', ['get', 'kind'], 'state'],
      paint: { 'line-color': cssVar('--text-primary', '#1a1a1a'), 'line-width': 0.8, 'line-opacity': 0.55 },
    });
    /* Just above the state lines and just heavier than them (1.2 px at 0.6 vs
       0.8 at 0.55). The country's edge is the outermost thing on a map of the
       United States and should read as such, but it is still a reference line —
       anything bolder would compete with the working-area boundary, which is
       the one line on this map an author is meant to be working inside. */
    map.addLayer({
      id: 'boundary-nation', type: 'line', source: SRC_BOUNDARY,
      filter: ['==', ['get', 'kind'], 'nation'],
      paint: { 'line-color': cssVar('--text-primary', '#1a1a1a'), 'line-width': 1.2, 'line-opacity': 0.6 },
    });

    /* AFTER BOOT, not during it: the counties competed with the archive for
       bandwidth on the boot path even before they streamed (the old 842 KB
       mesh surfaced as downstream flakiness).

       A ZOOM FLOOR AT THE NATIONAL VIEW, AND NOTHING ABOVE IT. This layer had
       `minzoom: 5` once, which made the county grid something you discovered by
       zooming rather than something the map had; that gate came off and the
       width was zoom-interpolated instead (0.4px at z3 → 1.0 at z8). The
       interpolation is right and stays — but 3,221 counties of line at 0.4px
       over the national pose is not a grid, it is moiré: at z3.4 the spacing
       approaches the pixel and the lines beat against the USDM fills instead of
       resolving. `minzoom: 4` removes exactly that one view. Every working view
       is above it (a state fits at z≈5, a tribal area higher), so the lines are
       still there the moment the map is about anywhere in particular — which is
       the whole of what dropping the old gate was for.

       The explicit beforeId re-claims the
       exact ladder slot the mesh layer had — below `boundary-state`, and
       safely under the labels `raiseReferenceGeography()` has already raised.
       MapLibre resolves the PMTiles header (one small range read) into
       TileJSON asynchronously; the layer order is correct from the moment
       addLayer returns. Best-effort twice over: a missing vendored bundle and
       a blocked remote fetch both cost exactly the county lines. */
    afterBoot(async () => {
      try {
        if (!(await ensurePmtilesProtocol())) {
          countyTilesStatus = 'unavailable';
          console.warn('[usdm] county boundaries unavailable (pmtiles bundle missing)');
          return;
        }
        map.addSource(SRC_COUNTY, {
          type: 'vector',
          url: `pmtiles://${COUNTY_TILES_URL}`,
          promoteId: { counties: 'id' },
        });
        map.addLayer({
          id: 'boundary-county', type: 'line', source: SRC_COUNTY, 'source-layer': 'counties',
          minzoom: COUNTY_MINZOOM,
          paint: {
            'line-color': cssVar('--map-county-line', 'rgba(26,26,26,0.25)'),
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 1.0],
            'line-opacity': COUNTY_EDGE_OPACITY,
          },
        }, 'boundary-state');
        countyTilesStatus = 'added';
      } catch (err) {
        countyTilesStatus = 'failed';
        console.warn('[usdm] county boundaries unavailable', err);
      }
    });
  }

  /* ── Reference geography rides on top ────────────────────────────────────
     `beforeLabels` is honoured by the drought layers and by NOTHING else: the
     masks, the boundary grades, the change outlines and the working-area dash
     are added with no `beforeId`, so `addLayer` APPENDS them over every place
     name — and Positron's water fills sit under the opaque classes. Measured
     on `?aoi=state:CO`: water at 9-10, usdm-fill-* at 14-18, the anchor at
     36, place_* at 94-108, boundary-county … aoi-line at 118-126.

     Threading `beforeLabels` through those nine `addLayer` calls would also
     drop the county lines under Positron's roads and buildings, so the rule
     is stated once, here, at the END of the stack — where it also survives a
     tenth layer added with no anchor.

     WATER IS A SANCTIONED EXCEPTION to the no-fill rule (CLAUDE.md):
     Positron's `water` is `#d4dadc` at `fill-opacity: 1`, so it OCCLUDES
     rather than tints — no class is modulated, and the USDM does not classify
     open water. `water_shadow` travels with it (Positron pairs them).

     ORDER IS LOAD-BEARING: water moves FIRST, while `beforeLabels` still
     names an unmoved layer; only then do the labels go to the top. The other
     way round, the anchor is above the app's lines and the lakes go up too.

     TERRA DRAW STAYS ABOVE THE LABELS. `td-*` arrives with `draw.start()`
     after this runs, and that is correct, not a leak: raising the labels a
     second time from `initEditorSeam` was tried and rejected — a label
     crossing the vertex you are reaching for costs more than the orientation
     it buys. tools/verify.mjs asserts the order so the flip stays a decision. */
  /**
   * Which labels ride over the app's own marks: `place_*` (answers "where am
   * I", which outranks every mark) and `watername_*` (water is raised over
   * the drought, and a visible lake with a buried name reads as a bug). NOT
   * all 27 of Positron's symbol layers — `roadname_*`, `poi_*` and
   * `housenumber` over the working-area dash are basemap DETAIL, not
   * orientation. Everything else stays where Positron put it.
   */
  const TOP_LABEL_PREFIXES = ['place_', 'watername_'];
  const isTopLabel = (id) => TOP_LABEL_PREFIXES.some((p) => id.startsWith(p));

  function raiseReferenceGeography() {
    const anchor = firstSymbolLayerId(map);
    /* `undefined` is a first-class answer on the blank-ground boot — there are
       no symbol layers and no water either, so both loops simply do nothing. */
    if (anchor) {
      for (const id of waterLayerIds(map)) {
        if (map.getLayer(id)) map.moveLayer(id, anchor);
      }
    }
    /* `moveLayer(id)` with no second argument moves to the TOP, so walking the
       list bottom-to-top preserves the labels' own relative order. */
    for (const id of labelLayerIds(map).filter(isTopLabel)) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  }

  /**
   * Paint the working area: its boundary, and the knockdown around it.
   *
   * `aoiMask` is a turf op over the AOI's rings, so it is not free on a large
   * state — but it runs once per working-area change, not per frame, and the
   * alternative (a mask baked at build time) would be 4,483 of them in the repo.
   * A failure here costs the dim, not the working area: the outline and the
   * changeset are what an author actually edits against.
   *
   * @param {object|null} aoi  a full js/aoi.js record, or null to clear
   */
  function renderAoi(aoi) {
    const outline = map?.getSource('aoi');
    const mask = map?.getSource('aoi-mask');
    if (!outline || !mask) return;
    if (!aoi) { outline.setData(emptyFC()); mask.setData(emptyFC()); return; }

    outline.setData({
      type: 'Feature', properties: {}, geometry: aoi.geometry,
    });
    try {
      mask.setData(aoiMask(aoi));
    } catch (err) {
      console.warn('[usdm] could not build the working-area mask', err);
      mask.setData(emptyFC());
    }
  }

  /** Repaint the USDM layers from whichever band geometry is current. */
  function renderBands(bands) {
    const src = map.getSource(SRC);
    if (!src || !bands) return;
    bandsData = bandsToFC(bands);
    src.setData(bandsData);
  }

  /**
   * Repaint the proposal's own fills, inside the working area.
   *
   * `null` empties it, which is the right state with no working area open: the
   * published fills are then whole (nothing has been punched out of them) and
   * this group has nothing to say. Anything else is a `{D0..D4}` band set —
   * `deriveBands(changeset.contours)` in the proposal view, the working area's
   * published bands in the published view. This function does not know or care
   * which; `js/app.js` decides, because deciding needs the view AND the
   * changeset and this module holds neither.
   */
  function renderEditBands(bands) {
    const src = map.getSource(SRC_EDIT);
    if (!src) return;
    editBandsData = bands ? bandsToFC(bands) : null;
    src.setData(editBandsData ?? emptyFC());
  }

  /**
   * The two class FeatureCollections currently on the map, for
   * js/export-png.js — held in this closure like `boundaries`, because
   * nothing in app code may read `map.getSource(id)._data` (in v5 it holds
   * `{ geojson: … }`, truthy and unparseable; the PNG export once shipped
   * with no state lines because of it).
   *
   * The export needs BOTH groups: it mirrors the current view — published
   * outside the working area, the proposal inside. Rebuilding from
   * `publishedBands` alone would paint the published week everywhere.
   */
  function bandsFC() { return bandsData; }
  function editBandsFC() { return editBandsData; }

  /**
   * Follow the theme, layer by layer.
   *
   * Gated per layer rather than bailing on the first missing one: the boundary
   * layers are optional (see `addBoundaryLayers`), and an early return on
   * `boundary-state` took the working-area outline and the map background down with
   * them — so on a load where the atlas 404'd, switching theme would leave a
   * light-mode background under a dark-mode page.
   *
   * Terra Draw's own outlines are NOT re-painted here: they live in style objects
   * the editor builds once, the editor is a dynamic import that is allowed to
   * fail, and this module knows nothing about it. js/app.js calls `editor.restyle()`
   * immediately after this, which keeps the order the same as it always was.
   */
  function restyleForTheme() {
    if (!map) return;
    const paint = (id, prop, value) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, value); };
    paint('boundary-state', 'line-color', cssVar('--text-primary', '#1a1a1a'));
    paint('boundary-nation', 'line-color', cssVar('--text-primary', '#1a1a1a'));
    paint('boundary-county', 'line-color', cssVar('--map-county-line', 'rgba(26,26,26,0.25)'));
    paint('boundary-aiannh', 'line-color', cssVar('--map-tribal-line', 'rgba(122,79,36,0.55)'));
    /* `--text-primary`, NOT `--selection-ring`: a scope is not a selection
       (see `addAoiOutline`). Casings stay white — white is white in both
       themes, which is why a casing is white. */
    paint('aoi-line', 'line-color', cssVar('--text-primary', '#1a1a1a'));
    paint('aoi-dim', 'fill-color', cssVar('--map-dim', 'rgba(250,250,248,0.55)'));
    /* Same token as `aoi-dim`, and it can be on screen mid-theme-toggle same as
       any other layer: an author armed Extend does not have to disarm it to
       get a working theme switch. */
    paint('band-dim', 'fill-color', cssVar('--map-dim', 'rgba(250,250,248,0.55)'));
    paint('band-line', 'line-color', cssVar('--map-reach-line', '#0f5e66'));
    /* Drawn in --text-primary and --selection-ring, both of which change
       under high contrast. */
    paint('changes-line', 'line-color', cssVar('--text-primary', '#1a1a1a'));
    paint('changes-line-active', 'line-color', cssVar('--selection-ring', '#1f3f9e'));
    /* `bg` exists only on the degraded style; the guard inside `paint` is what
       makes that a no-op rather than a branch. */
    paint('bg', 'background-color', cssVar('--map-bg', '#fafaf8'));
    /* The under-hillshade's colours are derived from --text-primary, --map-bg
       and --text-dim, so a theme change leaves them stale; `hillshade-over`'s
       are achromatic literals but its two ALPHAS deepen under high contrast, so
       both layers re-derive here (js/basemap.js). NEVER `setStyle()` here:
       it destroys every layer and source not in the incoming style — the USDM
       fills, the boundaries, the AOI layers and everything Terra Draw owns —
       mid-session and mid-edit. One style, re-painted (js/basemap.js § Positron
       only). */
    restyleHillshade(map);
  }

  /**
   * The state + nation mesh FeatureCollection, or null when the atlas was
   * unreachable. Each feature carries `properties.kind`, so the export can
   * paint the two at their own weights.
   *
   * The PNG export's only way to the boundaries, and the reason this closure
   * holds them at all — see the note beside `boundaries` above.
   */
  function boundariesFC() { return boundaries; }

  /** See `countyTilesStatus` at module scope — surfaced as `__usdm.countyTiles`. */
  function countyStatus() { return countyTilesStatus; }

  return {
    countyStatus,
    addAll,
    renderBands,
    renderEditBands,
    renderAoi,
    renderBandMask,
    renderChangeOutlines,
    setActiveChanges,
    setActiveChange,
    setMapView,
    getMapView,
    setDeltaData,
    deltaFC,
    restyleForTheme,
    boundariesFC,
    bandsFC,
    editBandsFC,
  };
}
