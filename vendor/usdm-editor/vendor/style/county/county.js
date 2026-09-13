/* ============================================================================
   NGP RIDR house-style kit · county/county.js · v0.2.0
   The FSA county composite: vintage selection, TopoJSON decode, MapLibre
   layers, hover/selection state, and the pointer tooltip.

   ES module, no build step. Import it pinned to a release:

     import { loadCounties, addCountyLayers, vintageForYear }
       from '../vendor/style/county/county.js';

   REQUIRES `window.topojson` — the vendored UMD build, loaded as a CLASSIC
   script BEFORE the app module:

     <script src="../vendor/style/vendor/topojson-client-3.1.0/topojson-client.min.js"></script>

   The decode asserts that global and throws with that tag in the message.

   ==========================================================================
   THE DESIGN RULE: COUNTY KEYS ARE 5-CHARACTER FSA STRINGS
   ==========================================================================
   Every county id in this module — every Map key, every `feature.id`, every
   argument and every return value — is the topojson's own **5-character FSA
   string id**: the 2-character State FSA code concatenated with the
   3-character county FSA code, zero-padded ("01001", "06003"). This API never
   accepts and never emits a numeric id, and **no integer parse of an id
   appears anywhere in this file** — not one call, not one coercion. Neither
   should one appear in yours (kit rule 10, AGENTS.md).

   FSA county codes are NOT FIPS codes. They coincide for most counties and
   diverge exactly where it matters: FSA splits some FIPS counties into several
   administrative offices that each set their own program dates (East and West
   Lucas, Ohio; North and South St. Louis, Minnesota), and merges others (one
   office in Palmer, Alaska covers fourteen census areas).

   The motivating incident: a sibling dashboard built its join key as
   `paste0(FIPS state, FIPS county)` — an integer-derived key — and joined it
   against FSA-coded dd17 geometry. Most counties matched, so the map drew and
   looked right; the rest were silently blank or silently attributed to the
   wrong office. **A join that is 97% correct on a federal eligibility map is a
   wrong map, and nothing in the rendering says so.**

   Two corollaries this module enforces:
     · A numeric round-trip DESTROYS leading zeros ("01001" → 1001), which is
       every county in Alabama, Alaska, Arizona, Arkansas, California,
       Colorado, Connecticut and Delaware.
     · Unmatched ids are REPORTED, not swallowed. recolor() returns the ids it
       was given that have no polygon in the current vintage — an id in the
       data with no geometry is a real fact (the island territories are in
       neither archive) and belongs in the legend or the summary.

   ── Attribution ────────────────────────────────────────────────────────────
   New in this kit — mco-web-style has no county module (its maps are station
   points on a tiled basemap). Ported from mt-climate-office/mco-web-style
   (MIT) all the same: map/mco-map.js for the token→paint resolution and the
   theme re-apply contract, and the cursor-tooltip pattern that kit specced as
   `MCO.map.initCursorTooltip` in CHANGELOG.md § "Planned for 0.7.0" (element +
   cursor+14 positioning + `.visible` toggle + a single map-level mousemove
   dispatcher doing its own queryRenderedFeatures), as implemented in
   mt-climate-office/mesonet-status app.js. Both kits are MIT.
   ========================================================================== */

import { escapeHTML, fetchJSON, promiseCache } from '../core/core.js';
import { resolveToken } from '../map/map.js';

/* ── Requirements ────────────────────────────────────────────────────────── */

const TOPOJSON_TAG =
  '<script src="../vendor/style/vendor/topojson-client-3.1.0/topojson-client.min.js"></script>';

/**
 * The topojson-client UMD global, or a thrown Error naming the missing tag.
 * Read off globalThis (not `window`) so the decode is testable under node.
 * @returns {any} window.topojson
 */
function topojsonLib() {
  const tj = (typeof globalThis !== 'undefined') ? globalThis.topojson : undefined;
  if (!tj || typeof tj.feature !== 'function' || typeof tj.mesh !== 'function') {
    throw new Error(
      '[ridr/county] window.topojson is not defined. Load the vendored UMD '
      + 'build as a classic script BEFORE your app module:\n  ' + TOPOJSON_TAG);
  }
  return tj;
}

/* ── Vintage ─────────────────────────────────────────────────────────────────
   The boundary vintage follows the PROGRAM YEAR. Never interpolated, never one
   vintage for a whole app (HOUSE-STYLE §7). */

/** First program year drawn on dd22 boundaries. */
export const VINTAGE_SWITCH_YEAR = 2015;

/**
 * Geometry is fetched at RUNTIME from the boundary archives' own Pages sites —
 * a named runtime dependency of every county app in this fleet. Same origin as
 * the kit and the app, so `connect-src 'self'` covers it and no consumer
 * vendors a copy. One archive, one truth: a re-simplification or a correction
 * reaches every app with no release.
 */
export const BOUNDARY_URLS = {
  dd17: 'https://sustainable-fsa.com/fsa-counties-dd17/fsa-counties-dd17.topojson',
  dd22: 'https://sustainable-fsa.com/fsa-counties-dd22/fsa-counties-dd22.topojson',
};

/**
 * Program year → boundary vintage. `'dd17'` / `'dd22'` pass through unchanged,
 * so anything taking "a year or a vintage" can normalize through this one call.
 *
 * FSA RE-DREW EIGHT COUNTY FOOTPRINTS between the dd17 and dd22 handbook
 * digests — Shoshone, ID split out of the Benewah and Kootenai offices; Sioux,
 * NE consolidated into 31165; King, WA into 53033; Richmond City, VA out of
 * Henrico — and six codes map to a different set of FIPS counties in each.
 * Program years 2015+ use the dd22 definitions: 16079 (Shoshone) first appears
 * in the reported data that year, and from then on 16009, 16055 and 16079 all
 * report, which only holds under the dd22 arrangement.
 *
 * NEVER MIX VINTAGES WITHIN A YEAR. Drawing a 2011 program year on dd22
 * boundaries leaves the territory of a since-split county blank even though its
 * grazing period *was* reported, under the office that then administered it —
 * a data-availability claim that is simply false. Drawing 2020 on dd17 does the
 * reverse.
 *
 * @param {number|string} year a program year, or 'dd17'/'dd22'
 * @returns {'dd17'|'dd22'}
 */
export function vintageForYear(year) {
  if (year === 'dd17' || year === 'dd22') return year;
  // Number() coerces a PROGRAM YEAR here, never a county id. Ids stay strings
  // end to end — see the design rule at the top of this file.
  const y = (typeof year === 'number') ? year : Number(String(year).trim());
  if (!Number.isFinite(y)) {
    throw new Error("[ridr/county] vintageForYear: expected a program year or "
      + "'dd17'/'dd22', got " + JSON.stringify(year));
  }
  return y < VINTAGE_SWITCH_YEAR ? 'dd17' : 'dd22';
}

/* ── Load + decode ───────────────────────────────────────────────────────── */

// Per-session, per-(vintage,url). Storing PROMISES dedupes the concurrent
// double-load an app does when the year control and a deep link both resolve
// on the same tick; a rejected fetch evicts itself so a retry refetches.
const _boundaryCache = promiseCache();

/** A well-formed FSA county key: exactly five digits, leading zeros intact. */
const FSA_ID_RE = /^[0-9]{5}$/;

/**
 * Decode a boundary topology. Pure apart from the topojson global — exported
 * (underscored) so the decode contract can be tested outside a browser.
 *
 * @param {object} topo a parsed topology with `objects.counties` and
 *        `objects.states`
 * @param {string|null} [vintage]
 * @returns {{vintage: string|null, fc: object, statesMesh: object,
 *            bounds: number[][], index: Map<string, object>,
 *            names: Map<string, {county: string, state: string}>}}
 */
export function _decodeTopology(topo, vintage = null) {
  const tj = topojsonLib();
  const objects = topo && topo.objects;
  if (!objects || !objects.counties || !objects.states) {
    throw new Error('[ridr/county] not an FSA boundary topology: expected '
      + "objects.counties and objects.states, got "
      + JSON.stringify(objects ? Object.keys(objects) : objects));
  }

  const fc = tj.feature(topo, objects.counties);
  // Interior borders only: (a, b) => a !== b drops each state's outer ring
  // where it coincides with a neighbor, so the shared edge is drawn once.
  const statesMesh = tj.mesh(topo, objects.states, (a, b) => a !== b);

  const index = new Map();
  const names = new Map();
  // Bounds are RECOMPUTED from the decoded features rather than read from
  // topo.bbox: the archives' bbox is written by the exporter and can drift
  // from the geometry after a re-simplification, and a stale bbox silently
  // mis-frames every fit and every zoom-floor snap.
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;

  const malformed = [];
  const duplicates = [];

  for (const f of fc.features) {
    // topojson.feature() carries geometry.id through to feature.id; the
    // archives also repeat it in properties.id (which is what MapLibre's
    // promoteId reads). Both are the 5-character string; String() here is a
    // no-op that documents the type, NOT a coercion from a number.
    const raw = (f.id != null) ? f.id : (f.properties && f.properties.id);
    const id = (raw == null) ? '' : String(raw);
    f.id = id;
    if (!FSA_ID_RE.test(id)) malformed.push(id);
    if (index.has(id)) duplicates.push(id);

    index.set(id, f);
    const p = f.properties || {};
    names.set(id, { county: p.county, state: p.state });

    const bb = featureBBox(f);
    if (bb) {
      if (bb[0] < w) w = bb[0];
      if (bb[1] < s) s = bb[1];
      if (bb[2] > e) e = bb[2];
      if (bb[3] > n) n = bb[3];
    }
  }

  if (malformed.length) {
    console.warn('[ridr/county] ' + malformed.length + ' feature id(s) are not '
      + '5-character FSA strings — joins will silently miss: '
      + malformed.slice(0, 5).join(', '));
  }
  if (duplicates.length) {
    console.warn('[ridr/county] duplicate feature id(s) in the topology; the '
      + 'last polygon wins: ' + duplicates.slice(0, 5).join(', '));
  }

  return {
    vintage,
    fc,
    statesMesh,
    bounds: [[w, s], [e, n]],
    index,
    names,
  };
}

/**
 * Fetch + decode a boundary vintage, cached for the session.
 *
 * @param {number|string} yearOrVintage a program year, or 'dd17'/'dd22'
 * @param {{urls?: {dd17: string, dd22: string}}} [opts]
 * @returns {Promise<{vintage: string, fc: object, statesMesh: object,
 *                    bounds: number[][], index: Map<string, object>,
 *                    names: Map<string, {county: string, state: string}>}>}
 *          `bounds` is [[w,s],[e,n]] — MapLibre's array form, ready for
 *          fitBounds() and installZoomFloor().
 */
export async function loadCounties(yearOrVintage, { urls = BOUNDARY_URLS } = {}) {
  const vintage = vintageForYear(yearOrVintage);
  const url = (urls && urls[vintage]) || BOUNDARY_URLS[vintage];
  if (!url) {
    throw new Error('[ridr/county] no boundary URL for vintage ' + JSON.stringify(vintage));
  }
  return _boundaryCache.cached(vintage + '|' + url, async () => {
    const topo = await fetchJSON(url);
    return _decodeTopology(topo, vintage);
  });
}

/* ── Geometry helpers ────────────────────────────────────────────────────── */

// Non-enumerable caches: they must not ride along when the FeatureCollection is
// structured-cloned into MapLibre's worker, or serialized by an app.
const BBOX_KEY = '_ridrBBox';
const CENTROID_KEY = '_ridrCentroid';

function stash(obj, key, value) {
  try {
    Object.defineProperty(obj, key, {
      value, writable: true, configurable: true, enumerable: false,
    });
  } catch (err) { /* frozen feature — recompute next time */ }
  return value;
}

/**
 * [w, s, e, n] for a Feature, cached on it.
 * @param {object} feature
 * @returns {number[]|null}
 */
function featureBBox(feature) {
  if (!feature) return null;
  const hit = feature[BBOX_KEY];
  if (hit) return hit;
  const g = feature.geometry;
  if (!g || !g.coordinates) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  (function walk(a) {
    if (!a || !a.length) return;
    if (typeof a[0] === 'number') {
      const x = a[0], y = a[1];
      if (x < w) w = x;
      if (y < s) s = y;
      if (x > e) e = x;
      if (y > n) n = y;
      return;
    }
    for (let i = 0; i < a.length; i++) walk(a[i]);
  })(g.coordinates);
  if (!Number.isFinite(w)) return null;
  return stash(feature, BBOX_KEY, [w, s, e, n]);
}

/**
 * [lng, lat] at the mean of the feature's bbox — the label/flyTo anchor.
 *
 * A bbox center, not a true polygon centroid: the Alaska, Hawaii and Puerto
 * Rico insets are PRE-BAKED into the archives' coordinates, so there is no
 * reprojection to respect and no wrap-around case; for these compact
 * administrative polygons the bbox center lands inside or beside the shape
 * either way. Cached on the feature.
 *
 * Pass the feature from `counties.index.get(id)`, NOT one from
 * queryRenderedFeatures() — rendered features are clipped to the tile and
 * simplified for the current zoom, so their bbox is not the county's.
 *
 * @param {object} feature
 * @returns {[number, number]|null}
 */
export function countyCentroid(feature) {
  if (!feature) return null;
  const hit = feature[CENTROID_KEY];
  if (hit) return hit;
  const bb = featureBBox(feature);
  if (!bb) return null;
  return stash(feature, CENTROID_KEY, [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]);
}

/* ── Layers ──────────────────────────────────────────────────────────────────
   Order, per HOUSE-STYLE §7: county fills → county strokes → hover → state
   mesh → selection halo. Thin lines above fills, always; the selection halo
   sits above the state mesh so a selected county on a state line still reads
   as selected. */

const LAYER = {
  fill: 'ridr-county-fill',
  line: 'ridr-county-line',
  hover: 'ridr-county-hover',
  stateLine: 'ridr-state-line',
  selectedCasing: 'ridr-county-selected-casing',
  selected: 'ridr-county-selected',
};

// Fallbacks for a page whose theme CSS has not applied yet. Restated light
// values only — theme/ridr-theme.css owns all of these.
const FALLBACK = {
  '--no-data': '#cccccc',
  '--map-county-line': 'rgba(31,41,55,0.25)',
  '--map-state-line': '#ffffff',
  '--selection-ring': '#8f320a',
  '--selection-casing': '1px',
  '--accent-line': '#8f320a',
  '--bg-surface': '#ffffff',
  '--map-bg': '#faf7f2',
};

function token(name) { return resolveToken(name, FALLBACK[name] || ''); }

/**
 * A length token ('1px', '1.5px') as a number of pixels. Regex + Number, never
 * an integer parse — partly on principle in this file, mostly because the
 * high-contrast theme's --selection-casing is 1.5px and an integer parse would
 * floor the casing to 1, silently un-thickening exactly the theme that asked
 * for more separation.
 */
function px(name, fallback) {
  const m = /(-?\d*\.?\d+)/.exec(token(name));
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// Line weights. Not tokens: the theme carries COLOR, and these widths are the
// same in both themes except where the theme deliberately strengthens the
// county stroke (see countyLinePaint below).
const RING_WIDTH = 2.2;
const HOVER_WIDTH = 1.6;
const STATE_WIDTH = 1.2;

// Empty string, not null: a filter needs a comparable value, and no FSA id is
// ever ''. `['==', ['id'], '']` matches nothing, which is exactly "no
// selection".
const NO_SELECTION = '';

/**
 * Add the county composite to a map. Call after `map.on('load')`.
 *
 * @param {any} map
 * @param {object} counties the resolved value of loadCounties()
 * @param {{before?: string, sourceId?: string, noDataColor?: string}} [opts]
 *        before: insert beneath this layer id (e.g. an app's label layer).
 * @returns {object} the layer handle — see the individual methods below.
 */
export function addCountyLayers(map, counties, {
  before, sourceId = 'ridr-counties', noDataColor,
} = {}) {
  const stateSourceId = sourceId + '-states';

  map.addSource(sourceId, {
    type: 'geojson',
    data: counties.fc,
    // promoteId lifts properties.id to feature.id so setFeatureState(),
    // ['id'] filters and ['feature-state', …] expressions all key on the
    // 5-CHARACTER FSA STRING. Without it MapLibre assigns its own numeric ids
    // and every join in the app is against a number that means nothing.
    promoteId: 'id',
  });
  map.addSource(stateSourceId, {
    type: 'geojson',
    // topojson.mesh() returns a bare MultiLineString geometry; wrap it, because
    // a geojson source's `data` is specced as a Feature or FeatureCollection.
    data: { type: 'Feature', geometry: counties.statesMesh, properties: {} },
  });

  // Every paint value below that comes from a token is re-resolved by
  // applyThemePaints(). GL paints cannot read CSS custom properties.
  map.addLayer({
    id: LAYER.fill,
    type: 'fill',
    source: sourceId,
    paint: { 'fill-color': fillColorExpr(noDataColor) },
  }, before);

  map.addLayer({
    id: LAYER.line,
    type: 'line',
    source: sourceId,
    paint: countyLinePaint(),
  }, before);

  map.addLayer({
    id: LAYER.hover,
    type: 'line',
    source: sourceId,
    paint: hoverPaint(),
  }, before);

  map.addLayer({
    id: LAYER.stateLine,
    type: 'line',
    source: stateSourceId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: statePaint(),
  }, before);

  // The selection is TWO line layers: a light casing underneath, the ring on
  // top. A single ring is unreadable where it crosses a fill of similar
  // lightness, and the choropleth's colors are not knowable in advance — the
  // casing guarantees a boundary between ring and fill whatever is beneath it.
  map.addLayer({
    id: LAYER.selectedCasing,
    type: 'line',
    source: sourceId,
    filter: ['==', ['id'], NO_SELECTION],
    paint: casingPaint(),
  }, before);

  map.addLayer({
    id: LAYER.selected,
    type: 'line',
    source: sourceId,
    filter: ['==', ['id'], NO_SELECTION],
    paint: ringPaint(),
  }, before);

  /* ── paint builders ───────────────────────────────────────────────────── */

  function fillColorExpr(noData) {
    return ['coalesce', ['feature-state', 'color'], noData ?? token('--no-data')];
  }
  function countyLinePaint() {
    // The light theme's --map-county-line is a LOW-ALPHA rgba: at national
    // zoom a solid county stroke reads as noise over the fills. The
    // high-contrast theme makes it solid, because polygon shape has to survive
    // without color. The layer is always present either way — hiding it by
    // visibility would mean re-adding a layer on theme change instead of
    // re-painting one, and the alpha does the job.
    return {
      'line-color': token('--map-county-line'),
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1.1],
    };
  }
  function hoverPaint() {
    // Driven by feature-state, not by a filter — filters cannot read feature
    // state, and re-filtering a layer on every mousemove would re-tessellate.
    return {
      'line-color': token('--accent-line'),
      'line-width': HOVER_WIDTH,
      'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0],
    };
  }
  function statePaint() {
    return { 'line-color': token('--map-state-line'), 'line-width': STATE_WIDTH };
  }
  function casingPaint() {
    return {
      // --bg-surface is white in both themes: the casing reads as the page's
      // own surface color showing through, which is why it separates the ring
      // from any fill.
      'line-color': token('--bg-surface'),
      'line-width': RING_WIDTH + 2 * px('--selection-casing', 1),
    };
  }
  function ringPaint() {
    return { 'line-color': token('--selection-ring'), 'line-width': RING_WIDTH };
  }

  /* ── state ────────────────────────────────────────────────────────────── */

  let hoverId = null;
  let selectedId = null;
  let raf = 0;
  let pendingColors = null;
  let disposed = false;

  const rAF = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame : ((fn) => setTimeout(fn, 16));
  const cancelRAF = (typeof cancelAnimationFrame === 'function')
    ? cancelAnimationFrame : clearTimeout;

  function entries(colors) {
    if (!colors) return [];
    if (colors instanceof Map) return Array.from(colors.entries());
    if (Array.isArray(colors)) return colors;
    return Object.entries(colors);
  }

  function flushColors() {
    raf = 0;
    const colors = pendingColors;
    pendingColors = null;
    if (disposed || !colors) return;
    // One wipe, then one set per entry. Clearing per-id instead would mean a
    // removeFeatureState call for every county that dropped out of the data
    // between renders — and the app does not know which those are.
    map.removeFeatureState({ source: sourceId });
    for (const [id, color] of entries(colors)) {
      if (color == null) continue;           // let it fall through to --no-data
      map.setFeatureState({ source: sourceId, id: String(id) }, { color });
    }
    // The wipe above takes `hover` with it — it is feature state too. Re-apply
    // it, or the county under the cursor loses its halo on every recolor.
    if (hoverId) map.setFeatureState({ source: sourceId, id: hoverId }, { hover: true });
  }

  const handle = {
    counties,
    sourceId,
    stateSourceId,
    // Draw order, bottom to top.
    layerIds: [LAYER.fill, LAYER.line, LAYER.hover, LAYER.stateLine,
      LAYER.selectedCasing, LAYER.selected],

    /**
     * Paint the choropleth. Coalesced to one flush per animation frame — a
     * year slider dragged across a decade otherwise issues thousands of
     * setFeatureState calls per second, and only the last frame is ever seen.
     * A queued payload is REPLACED, not merged: each call is the complete
     * picture.
     *
     * @param {Map<string, string>|object|Array} colors id → CSS color. An id
     *        absent from the map falls through to --no-data.
     * @returns {string[]} ids with no polygon in the CURRENT vintage —
     *          reported, never swallowed (see the design rule up top). Expect
     *          entries here for data-only territories; investigate any others,
     *          because that is what a FIPS-keyed join looks like.
     */
    recolor(colors) {
      const unmatched = [];
      for (const [id] of entries(colors)) {
        if (!handle.counties.index.has(String(id))) unmatched.push(String(id));
      }
      pendingColors = colors;
      if (!raf) raf = rAF(flushColors);
      return unmatched;
    },

    /**
     * Swap to another vintage's geometry in place — the ONLY sanctioned way to
     * change vintage.
     *
     * setData() does NOT clear feature-state, and state is keyed by id: the
     * eight footprints that changed between dd17 and dd22 keep the OLD
     * vintage's color, and the last hovered county keeps its halo forever.
     * So: removeFeatureState FIRST, then setData, then let the app recolor.
     *
     * @param {object} counties2 another loadCounties() result
     */
    swapVintage(counties2) {
      map.removeFeatureState({ source: sourceId });
      hoverId = null;
      pendingColors = null;
      if (raf) { cancelRAF(raf); raf = 0; }

      handle.counties = counties2;
      map.getSource(sourceId).setData(counties2.fc);
      map.getSource(stateSourceId).setData({
        type: 'Feature', geometry: counties2.statesMesh, properties: {},
      });

      // A county that does not exist in the new vintage cannot stay selected —
      // its ring would hang over whatever polygon now covers that ground.
      if (selectedId && !counties2.index.has(selectedId)) handle.setSelected(null);
    },

    /** @param {string|null} id */
    setHover(id) {
      const next = (id == null) ? null : String(id);
      if (next === hoverId) return;
      if (hoverId) map.setFeatureState({ source: sourceId, id: hoverId }, { hover: false });
      hoverId = next;
      if (hoverId) map.setFeatureState({ source: sourceId, id: hoverId }, { hover: true });
    },

    /** @returns {string|null} */
    getHover() { return hoverId; },

    /**
     * Selection is filter-driven rather than feature-state-driven so it
     * survives a recolor's feature-state wipe untouched.
     * @param {string|null} id
     */
    setSelected(id) {
      selectedId = (id == null) ? null : String(id);
      const f = ['==', ['id'], selectedId ?? NO_SELECTION];
      map.setFilter(LAYER.selectedCasing, f);
      map.setFilter(LAYER.selected, f);
    },

    /** @returns {string|null} */
    getSelected() { return selectedId; },

    /**
     * Re-resolve every token-derived paint. CALL THIS ON EVERY THEME CHANGE —
     * wire it to core's initThemeToggle({ onChange }). MapLibre resolves paint
     * values in the GL renderer, not the CSS engine, so a theme toggle that
     * only swaps `data-theme` leaves the whole map painted in the old palette.
     */
    applyThemePaints() {
      map.setPaintProperty(LAYER.fill, 'fill-color', fillColorExpr(noDataColor));
      const line = countyLinePaint();
      map.setPaintProperty(LAYER.line, 'line-color', line['line-color']);
      map.setPaintProperty(LAYER.line, 'line-width', line['line-width']);
      map.setPaintProperty(LAYER.hover, 'line-color', hoverPaint()['line-color']);
      map.setPaintProperty(LAYER.stateLine, 'line-color', statePaint()['line-color']);
      const casing = casingPaint();
      map.setPaintProperty(LAYER.selectedCasing, 'line-color', casing['line-color']);
      map.setPaintProperty(LAYER.selectedCasing, 'line-width', casing['line-width']);
      map.setPaintProperty(LAYER.selected, 'line-color', ringPaint()['line-color']);
      // The blank style's background layer is token-derived too, and it is the
      // canvas the whole composite sits on — repaint it here rather than
      // making every app remember a second theme hook.
      if (map.getLayer('background')) {
        map.setPaintProperty('background', 'background-color', token('--map-bg'));
      }
    },

    /** Remove every layer and source this handle added. */
    dispose() {
      disposed = true;
      if (raf) { cancelRAF(raf); raf = 0; }
      pendingColors = null;
      for (const id of handle.layerIds) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      if (map.getSource(stateSourceId)) map.removeSource(stateSourceId);
    },
  };

  return handle;
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

const TOOLTIP_OFFSET = 14;   // px from the cursor, matching the house tooltip

/**
 * Pointer-following county tooltip, wired to the fill layer.
 *
 * The tooltip is DECORATIVE for assistive tech (`aria-hidden`) — a screen
 * reader can no more follow a cursor than it can read the WebGL canvas. Route
 * the same content through the app's live region and its on-demand table
 * (HOUSE-STYLE §5.2); this is the sighted-pointer channel only.
 *
 * One map-level `mousemove` doing its own queryRenderedFeatures, rather than
 * layer-scoped listeners: layer handlers can be left detached when a style is
 * swapped, while the map-level handler is stable.
 *
 * @param {any} map
 * @param {object} handle the addCountyLayers() handle
 * @param {{render?: (feature: object, id: string) => (object|string),
 *          element?: HTMLElement, onClick?: (id: string, feature: object) => void,
 *          layerId?: string}} [opts]
 *        render returns `{name, sub, val}` (each escaped for you) or an HTML
 *        STRING, which is inserted as-is — app-authored markup only, exactly
 *        like ui/help.js. There is no sanitizer in this kit.
 * @returns {{dispose: () => void}}
 */
export function initCountyTooltip(map, handle, {
  render, element, onClick, layerId = LAYER.fill,
} = {}) {
  const created = !element;
  const el = element || document.createElement('div');
  if (created) {
    el.className = 'ridr-tooltip';
    document.body.appendChild(el);
  }
  el.setAttribute('aria-hidden', 'true');

  const canvas = map.getCanvas();
  let raf = 0;
  let pending = null;      // latest mousemove, processed once per frame
  let shownId = null;
  // Touch has no hover: a tap that showed a tooltip would leave it stranded on
  // screen until the next tap. Track the pointer type and show for mice only.
  let touching = false;

  function featureAt(point) {
    if (!map.getLayer(layerId)) return null;
    const hits = map.queryRenderedFeatures(point, { layers: [layerId] });
    return hits && hits[0] ? hits[0] : null;
  }

  function idOf(feature) {
    if (!feature) return null;
    const raw = (feature.id != null) ? feature.id
      : (feature.properties && feature.properties.id);
    return (raw == null) ? null : String(raw);
  }

  function defaultRender(feature, id) {
    const nm = handle.counties.names.get(id);
    return nm ? { name: nm.county + ', ' + nm.state, sub: id } : { name: id };
  }

  function html(feature, id) {
    const out = (render || defaultRender)(feature, id);
    if (out == null) return null;
    if (typeof out === 'string') return out;
    let s = '';
    if (out.name != null) s += '<span class="tooltip-name">' + escapeHTML(out.name) + '</span>';
    if (out.sub != null) s += '<span class="tooltip-sub">' + escapeHTML(out.sub) + '</span>';
    if (out.val != null) s += '<span class="tooltip-val">' + escapeHTML(out.val) + '</span>';
    return s;
  }

  function place(clientX, clientY) {
    // Flip to the other side of the cursor near the viewport edge rather than
    // letting the tooltip clip or push a scrollbar.
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = clientX + TOOLTIP_OFFSET;
    let y = clientY + TOOLTIP_OFFSET;
    if (x + r.width > vw - 8) x = Math.max(8, clientX - TOOLTIP_OFFSET - r.width);
    if (y + r.height > vh - 8) y = Math.max(8, clientY - TOOLTIP_OFFSET - r.height);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  function hide() {
    shownId = null;
    el.classList.remove('visible');
    handle.setHover(null);
    canvas.style.cursor = '';
  }

  function frame() {
    raf = 0;
    const ev = pending;
    pending = null;
    if (!ev) return;
    const f = featureAt(ev.point);
    const id = idOf(f);
    if (!id) { hide(); return; }

    handle.setHover(id);
    canvas.style.cursor = 'pointer';
    if (id !== shownId) {
      const markup = html(f, id);
      if (markup == null) { hide(); return; }
      el.innerHTML = markup;
      shownId = id;
      el.classList.add('visible');
    }
    place(ev.clientX, ev.clientY);
  }

  function onMouseMove(e) {
    if (touching) return;
    // Throttled to one hover set/unset per frame: mousemove fires far faster
    // than the compositor, and each pass costs a queryRenderedFeatures.
    pending = {
      point: e.point,
      clientX: e.originalEvent ? e.originalEvent.clientX : 0,
      clientY: e.originalEvent ? e.originalEvent.clientY : 0,
    };
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function onClickMap(e) {
    const f = featureAt(e.point);
    const id = idOf(f);
    // A tap is a click: MapLibre synthesizes click from touch, so touch users
    // reach the same handler without a hover step.
    if (touching) hide();
    if (id && onClick) onClick(id, f);
  }

  function onPointerDown(e) { touching = (e.pointerType === 'touch'); }
  function onLeave() { hide(); }

  map.on('mousemove', onMouseMove);
  map.on('click', onClickMap);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('mouseleave', onLeave);

  return {
    element: el,
    dispose() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      pending = null;
      map.off('mousemove', onMouseMove);
      map.off('click', onClickMap);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('mouseleave', onLeave);
      hide();
      if (created && el.parentNode) el.parentNode.removeChild(el);
    },
  };
}

/* ── Search ──────────────────────────────────────────────────────────────── */

/**
 * Rows for the county search combobox (ui/search.js), sorted by label.
 *
 * @param {object} counties a loadCounties() result
 * @param {Array<{id: string, label?: string, county?: string, state?: string,
 *                code?: string}>} [extra]
 *        Data-only territories that are in the DATA but in neither boundary
 *        archive — they must still be findable, and a search that silently
 *        omits them tells the user they do not exist. An extra sharing an id
 *        with a real county REPLACES it, so an app can override a label.
 * @returns {Array<{id: string, label: string, code: string}>}
 */
export function searchItems(counties, extra = []) {
  const rows = new Map();
  counties.names.forEach(({ county, state }, id) => {
    rows.set(id, { id, label: county + ', ' + state, code: id });
  });
  for (const x of (extra || [])) {
    if (!x || x.id == null) continue;
    const id = String(x.id);
    const label = x.label != null ? x.label
      : ((x.county != null && x.state != null) ? x.county + ', ' + x.state : id);
    rows.set(id, { id, label, code: x.code != null ? String(x.code) : id });
  }
  // localeCompare with base sensitivity so "Doña Ana, New Mexico" sorts where a
  // user expects it rather than after Z.
  return Array.from(rows.values())
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
