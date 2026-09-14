/* ============================================================================
   USDM Editor · js/basemap.js
   The basemap seam: a CARTO Positron ground, two terrarium hillshades and a
   globe — all optional, none allowed to take the app down.

   Ported from mt-climate-office/mco-web-style map/mco-map.js v0.1.0 (MIT ©
   Montana Climate Office). The helpers live HERE, not in vendor/style/: the
   kit's fork deleted them on purpose (vendor/style/map/map.js, delta 2) and
   its value is staying diffable against upstream — neither tree imports the
   other. Three keyless hosts: basemaps.cartocdn.com (style.json, fetched
   here), tiles.basemaps.cartocdn.com (tiles/sprite/glyphs, fetched by
   MapLibre), s3.amazonaws.com (terrarium DEM). Keyless is a fleet decision
   (mco-web-style CONSUMERS.md @0.6.0): a key in a static bundle is a
   published key and has to be revoked at the vendor.

   POSITRON ONLY — no dark basemap. This app ships light plus a WHITE-BASED
   high-contrast theme (paper and ink, not an inverted screen), which buys its
   separation from a stronger hillshade (exaggeration 0.80) and the app's own
   line bumps instead. Structurally too: `map.setStyle()` DESTROYS every layer
   and source not in the incoming style — USDM fills, boundaries, Terra
   Draw's — mid-edit. One style, re-painted (`restyleHillshade`); never two
   styles, swapped.

   FAILURE MUST PRODUCE A WORKING STYLE. Boot awaits the map's `load` behind a
   30-second deadline (js/app.js), and a style URL that 404s or answers with
   captive-portal HTML may never fire `load` at all — so `resolveBaseStyle()`
   fetches with its own deadline and resolves EVERY failure to
   `{ style: blankStyle(), degraded: true }`, globe and sky included: the
   basemap is progressive enhancement and never outranks the data.

   House rules hold: no inline `style` attributes (`style-src 'self'`), and
   reachable helpers are `function` declarations, never `const` arrows (TDZ).
   ========================================================================== */

/* ── Remote origins ───────────────────────────────────────────────────────── */

/**
 * CARTO Positron, keyless. A neutral, desaturated data-vis backdrop — anything
 * with colour of its own competes with the USDM ramp on top of it. Positron
 * ONLY; no dark-matter counterpart (file header, § POSITRON ONLY).
 */
export const CARTO_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

/* ── Label halos ─────────────────────────────────────────────────────────────
   The place names are the one symbol allowed over the classes, and Positron's
   `rgba(255,255,255,0.5)` halo BLENDS with the class beneath, so the glyph
   never sits on a known colour. Measured, `#697b89` text vs the blended
   ground: Positron's own #fafaf8 4.19:1 (CARTO's design point), D0 4.14, D1
   3.68, D2 3.15, D3 1.71, D4 1.35 — and bare, with no halo, D3 is 1.10:1, so
   the worst class is not the darkest. THE FIX IS THE ALPHA: an opaque halo
   takes every class to a constant 4.38:1. Width is a separate typographic
   judgment carrying NO contrast claim — opaque at Positron's own width 1
   already delivers the 4.38:1 (verified at 1, 1.5 and 2, all legible over
   D4); 1.5 registers over saturated ground where 2 reads heavy on the smallest
   labels. Hue is preserved: already-opaque halos (#f5f5f3, #fafaf8, #d4dadc,
   #fff) are left exactly as Positron chose them, and `#697b89` stays CARTO's
   type colour — pushing for 4.5:1 is a larger decision, see
   docs/plan-polish-round.md § 2.3. Style-time only: the theme is URL-fixed at
   boot, so no post-load pass and no flash of unhaloed labels. */

/** Halo width, in px, for every basemap label. Positron ships 1 — and 0 on
 *  `place_state`, which is the largest label on a national view and therefore
 *  the one most likely to be sitting over drought. See § Label halos: this
 *  number is a typographic judgment, and no contrast claim rests on it. */
const LABEL_HALO_WIDTH = 1.5;

/**
 * The same halo colour, with any alpha removed.
 *
 * A hex is already opaque and comes back untouched; `rgba(r,g,b,a)` loses the
 * `a`. Anything unrecognised — an expression object, a missing value — falls
 * back to white, because a halo that cannot be made opaque is the defect this
 * whole block exists to remove.
 */
function opaqueHalo(color) {
  if (typeof color !== 'string') return '#ffffff';
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i
    .exec(color.trim());
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : color;
}

/**
 * Keyless global DEM: AWS Terrain Tiles (Mapzen), terrarium encoding. Ported
 * verbatim from mco-map.js § Hillshade — the attribution string is a condition
 * of the data. Live-shaded rather than a baked raster so the colours derive
 * per theme (one source serves light and high-contrast both), and global
 * because a globe that stops at the border is worse than one that does not.
 *
 * ── `maxzoom` IS 11, NOT 15, AND IT IS ON THE SOURCE ───────────────────────
 * Terrain was the largest byte category on this page: 256-px tiles against a
 * 512-px default means MapLibre asks for DEM tiles one level BELOW the map's
 * own zoom, so every zoom step quadrupled the ask and kept going to z15 — all
 * of it under class fills at opacity 1.0, which is to say mostly invisible.
 * Measured on `?aoi=state:MT` (1440×900, cumulative DEM image requests at the
 * state fit, then z7 → z9 → z11 → z13, two runs each):
 *
 *     maxzoom 15    78 → 102 → 126 → 146 → 170    (81 → 105 → 129 → 149 → 173)
 *     maxzoom 11    87 → 111 → 135 → 144 → 144    (90 → 114 → 138 → 147 → 147)
 *
 * The base count varies by a handful run to run — the globe picks its own
 * horizon — so read the MARGINAL cost of a zoom step instead: +24/+24/+20/+24
 * against +24/+24/+9/+0. The cap bites exactly where the DEM was being fetched
 * for nothing, and a deep zoom now asks for no new tiles at all. Screenshots
 * at z9, z11 and z13 over central Montana: z9 and z11 are indistinguishable,
 * z13 is softer and still reads as relief.
 *
 * ON THE SOURCE, deliberately, and not `maxzoom` on the two hillshade LAYERS.
 * A layer maxzoom HIDES the layer above it — relief would simply vanish the
 * moment an author zoomed in to draw, which is the zoom at which they are
 * looking hardest at the ground. A source maxzoom makes MapLibre OVERZOOM the
 * deepest tile it has, so relief still reads at every zoom and merely stops
 * gaining detail. 11 rather than 10 because a state fit lands near z6-7 and
 * the DEM is already one level ahead of the camera: 11 keeps native-resolution
 * relief through the whole range anyone edits at, and the smoothing past it is
 * invisible under a drought class. The `over` hillshade reads through the
 * fills on the user's explicit instruction (§ Hillshade, over) and is the
 * reason the layer answer was not acceptable here.
 */
export const TERRARIUM_DEM = {
  type: 'raster-dem',
  tileSize: 256,
  maxzoom: 11,
  encoding: 'terrarium',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  attribution: 'Terrain: Mapzen/AWS Open Data',
};

/** Source and layer ids this module owns. Fixed, not parameterised (delta 5). */
const DEM_SOURCE = 'dem';
const HILLSHADE_LAYER = 'hillshade';
/** The SECOND hillshade, above the drought fills. See § Hillshade, over. */
const HILLSHADE_OVER_LAYER = 'hillshade-over';

/* ── Globe ────────────────────────────────────────────────────────────────────
   The projection and the sky are properties of THIS APP, so both branches of
   resolveBaseStyle() get them — a degraded boot still shows a globe.
   `atmosphere-blend` fades the halo as the camera descends (full through
   zoom 5, gone by 7), so no atmospheric glow tints the fixed published
   palette at editing zooms. */

/** A fresh projection block. Fresh, not shared: a returned style is the
 *  caller's to mutate, and two callers must not share one object. */
function globeProjection() {
  return { type: 'globe' };
}

/** A fresh sky block, with the horizon haze zoomed out from under the data. */
function globeSky() {
  return {
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  };
}

/* ── Tokens ───────────────────────────────────────────────────────────────────
   MAPLIBRE PAINTS CANNOT READ CSS CUSTOM PROPERTIES. `var(--text-primary)` in
   a paint is not a value at all — the GL renderer resolves style values, not
   the CSS engine, and an unparseable colour falls back to MapLibre's own
   default with no error. Every token below is resolved to a concrete string
   before it reaches a paint, and re-resolved on theme change through
   `restyleHillshade()`. */

/** A CSS custom property off <html>, or '' where there is no DOM. */
function token(name) {
  if (typeof document === 'undefined' || !document.documentElement) return '';
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || '';
}

/** The live theme name, or '' outside a browser. Light is the default and is
 *  spelled by ABSENCE in some boots, so this never assumes a value. */
function theme() {
  if (typeof document === 'undefined' || !document.documentElement) return '';
  return document.documentElement.dataset.theme || '';
}

/**
 * `color` at opacity `a`, as an `rgba()` string a GL paint accepts — the
 * tokens are opaque hexes and hillshade colours need alpha. Returns null on
 * anything it cannot parse (`color-mix()`, `oklch()`, …) so the caller can
 * fall back to mco's literal values rather than paint garbage.
 *
 * @param {string} color `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`
 * @param {number} a alpha, 0-1
 * @returns {string|null}
 */
function rgba(color, a) {
  const c = String(color || '').trim();
  let r; let g; let b;
  const hex = /^#([0-9a-f]+)$/i.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else {
      return null;
    }
  } else {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
    if (!m) return null;
    r = Math.round(Number(m[1]));
    g = Math.round(Number(m[2]));
    b = Math.round(Number(m[3]));
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return `rgba(${r},${g},${b},${a})`;
}

/* ── The no-basemap style ─────────────────────────────────────────────────── */

/**
 * The app's no-basemap style: one background layer on the live `--map-bg`
 * token, no sources. Same layer id (`bg`), token and '#fafaf8' fallback as
 * `buildMap()` in js/app.js, so a degraded boot is byte-for-byte the map this
 * app shipped with and `restyleForTheme()` (js/layers.js) keeps working. Not
 * exported: js/app.js owns the canvas, and a second public way to build it is
 * a second place for that layer id to drift.
 *
 * @returns {object} a MapLibre style-spec object, globe included
 */
function blankStyle() {
  return {
    version: 8,
    sources: {},
    layers: [{
      id: 'bg',
      type: 'background',
      paint: { 'background-color': token('--map-bg') || '#fafaf8' },
    }],
    projection: globeProjection(),
    sky: globeSky(),
  };
}

/* ── Style resolution ─────────────────────────────────────────────────────── */

/** How long CARTO gets before the app stops waiting on it. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Fetch the CARTO Positron style, adapt it, and hand back a style object that
 * is ALWAYS constructible. Adaptations, in order:
 *
 *   · Every `boundary*` layer is hidden (`layout.visibility: 'none'`): this
 *     app draws its own boundaries, and CARTO's would be a second,
 *     differently-generalised set of the same lines. Hidden, not deleted, so
 *     the style stays a faithful Positron with one switch flipped.
 *   · Every label halo is made OPAQUE and widened to `LABEL_HALO_WIDTH` —
 *     1.35:1 over D4 becomes a constant 4.38:1; measurements in § Label
 *     halos. `housenumber` is skipped — its text is `transparent`.
 *   · `projection` and `sky` are injected. See § Globe.
 *
 * Never rejects. Never throws. See the file header, § FAILURE.
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{style: object, degraded: boolean}>} `degraded: true` means
 *          the blank style — the app is fully usable, just without a ground.
 */
export async function resolveBaseStyle({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /* A local AbortController rather than AbortSignal.timeout(), because the
     timer has to be CLEARED on success: a pending 5-second timer holds the
     event loop and, in a headless harness, is the difference between a run
     that exits and one that hangs. */
  let timer = null;
  try {
    if (typeof fetch !== 'function') return { style: blankStyle(), degraded: true };
    const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(CARTO_STYLE_URL, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const style = await res.json();
    /* A 200 that is not a style is a captive portal or an error page, and it
       fails LATER and worse than a 404 — MapLibre may simply never fire
       `load`. Shape-check before trusting it. */
    if (!style || typeof style !== 'object' || !Array.isArray(style.layers)) {
      throw new Error('not a style document');
    }
    for (const layer of style.layers) {
      if (!layer || typeof layer.id !== 'string') continue;
      if (layer.id.startsWith('boundary')) {
        // Positron ships these with no `layout` key at all, so create one.
        layer.layout = { ...(layer.layout || {}), visibility: 'none' };
        continue;
      }
      /* Opaque halo for every label (§ Label halos); skip `housenumber`, whose
         text is `transparent` — a halo there is a row of white blobs down
         every street around glyphs nobody can see. */
      if (layer.type === 'symbol' && layer.paint?.['text-color'] !== 'transparent') {
        layer.paint = {
          ...(layer.paint || {}),
          'text-halo-color': opaqueHalo(layer.paint?.['text-halo-color']),
          'text-halo-width': LABEL_HALO_WIDTH,
        };
      }
    }
    style.projection = globeProjection();
    style.sky = globeSky();
    return { style, degraded: false };
  } catch (err) {
    console.warn('[usdm] basemap unavailable; continuing without one', err);
    return { style: blankStyle(), degraded: true };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ── Hillshade ────────────────────────────────────────────────────────────────
   Ported from mco-map.js § Hillshade. TWO hillshades share the one DEM source:
   this under-layer inserts beneath the labels (relief belongs to the ground);
   § Hillshade, over is the achromatic second layer above the fills.
   `restyleHillshade()` re-derives both. */

/**
 * The id of the first symbol (label) layer in the CURRENT style — in Positron,
 * `waterway_label` — or undefined. Anything that belongs UNDER the basemap's
 * labels is inserted before this id. Undefined is a first-class answer, not a
 * failure: the degraded style has no symbol layers, and
 * `map.addLayer(layer, undefined)` appends, which is exactly right there.
 *
 * @param {any} map a maplibregl.Map
 * @returns {string|undefined}
 */
export function firstSymbolLayerId(map) {
  const layers = (map.getStyle() || {}).layers || [];
  for (const layer of layers) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

/**
 * Every label layer in the CURRENT style, bottom to top. This module names
 * them because it owns the ground; js/layers.js raises them because it owns
 * the order (its § Reference geography rides on top). Called BEFORE the editor
 * loads, so Terra Draw's later `td-point-marker` is deliberately NOT in the
 * list — the handles you are dragging belong above everything.
 *
 * @param {maplibregl.Map} map
 * @returns {string[]} layer ids, in their existing relative order
 */
export function labelLayerIds(map) {
  return (map.getStyle().layers ?? [])
    .filter((l) => l.type === 'symbol')
    .map((l) => l.id);
}

/**
 * Every water layer in the CURRENT style, bottom to top — lakes, coastline and
 * rivers, but NOT `waterway_label`, which is a label and travels with those.
 * Keyed on `source-layer` (the tile schema's name, the stabler of the two)
 * rather than Positron's layer ids, so a style bump that renames a layer does
 * not silently drop the lakes back under the drought.
 *
 * @param {maplibregl.Map} map
 * @returns {string[]} layer ids, in their existing relative order
 */
export function waterLayerIds(map) {
  return (map.getStyle().layers ?? [])
    .filter((l) => l.type !== 'symbol'
      && (l['source-layer'] === 'water' || l['source-layer'] === 'waterway'))
    .map((l) => l.id);
}

/**
 * Theme-derived hillshade paints. No dark theme here (§ POSITRON ONLY), so
 * mco's three branches collapse to two: light, exaggeration 0.50, and
 * high-contrast, 0.80 — both mco's own values. The COLOURS are the
 * adaptation: token-derived so relief tracks a theme change — shadow
 * `--text-primary` (#1a1a1a → #000000), highlight `--map-bg`
 * (#fafaf8 → #ffffff), accent `--text-dim` (#5a5a5a → #333333) — with
 * high-contrast deepening every alpha. mco's literal light-theme values are
 * the fallback when a token cannot be resolved (pre-stylesheet, or a harness
 * with no CSS). `hillshade-method: 'igor'` is the house method: subtle and
 * overlay-friendly, and the drought classes are what the eye should read.
 *
 * @returns {object} a MapLibre hillshade paint object
 */
export function hillshadePaints() {
  const hc = theme() === 'high-contrast';
  const shadow = rgba(token('--text-primary'), hc ? 0.72 : 0.55);
  const highlight = rgba(token('--map-bg'), hc ? 0.92 : 0.78);
  const accent = rgba(token('--text-dim'), hc ? 0.34 : 0.22);
  return {
    'hillshade-exaggeration': hc ? 0.8 : 0.5,
    // Fallbacks are mco-map.js's literal light-theme values, verbatim.
    'hillshade-shadow-color': shadow || 'rgba(55,65,80,0.55)',
    'hillshade-highlight-color': highlight || 'rgba(255,255,255,0.78)',
    'hillshade-accent-color': accent || 'rgba(90,100,120,0.22)',
    'hillshade-method': 'igor',
  };
}

/**
 * Add the terrarium DEM source and the hillshade layer, beneath the basemap's
 * labels. Idempotent on the source; on the degraded style there is no symbol
 * layer and the hillshade simply appends over the background.
 *
 * The try/catch is load-bearing: `hillshade-method` needs MapLibre ≥ 5.2, and
 * an older build's `addLayer` THROWS on the unknown paint property — strip the
 * method and re-add, because default shading is fine and no shading is not.
 * Tile failures are deliberately NOT handled here: an unreachable S3 raises
 * MapLibre `error` events the app already logs, and the map carries on.
 *
 * @param {any} map a maplibregl.Map with its style loaded
 * @returns {string} the layer id
 */
export function addHillshade(map) {
  if (!map.getSource(DEM_SOURCE)) {
    /* A copy, not the exported constant: MapLibre takes ownership of a source
       spec, and a module-level object handed to two maps is one map's edit
       away from being wrong in the other. */
    map.addSource(DEM_SOURCE, { ...TERRARIUM_DEM, tiles: [...TERRARIUM_DEM.tiles] });
  }
  const layer = {
    id: HILLSHADE_LAYER,
    type: 'hillshade',
    source: DEM_SOURCE,
    paint: hillshadePaints(),
  };
  const before = firstSymbolLayerId(map);
  try {
    map.addLayer(layer, before);
  } catch (err) {
    // hillshade-method needs MapLibre ≥ 5.2 — fall back to default shading.
    delete layer.paint['hillshade-method'];
    map.addLayer(layer, before);
  }
  return HILLSHADE_LAYER;
}

/* ── Hillshade, over ──────────────────────────────────────────────────────────
   A SECOND hillshade on the same DEM source, above every fill — added on the
   user's explicit instruction that terrain must read THROUGH the classes, and
   allowed on the narrowest terms (see CLAUDE.md's no-fill bullet): it is
   ACHROMATIC — black shadow, white highlight, accent alpha exactly 0 — so only
   luminance moves and a D2 on a lit ridge stays the same orange; the fills
   stay at 1.0 and this one named layer does all the modulating. Shadow-biased
   on purpose (shadow 0.28 light / 0.38 high-contrast vs highlight 0.10 / 0.14):
   a white highlight washes light classes toward the paper, a black shadow
   reads as depth on every class including D4's near-black. LITERAL rgba, not
   token-derived — the one deliberate break from delta-4 convention: the point
   is theme-independent neutrality, and deriving black from `--text-primary`
   would make relief over a published palette a function of brand tokens.
   Inserted before the label anchor, AFTER every fill (topmost of the
   under-anchor group). The PNG export does NOT mirror it (js/export-png.js);
   tools/verify.mjs § 1 asserts the opacity, the slot, the zero accent and the
   shadow bound. */

/**
 * Achromatic, shadow-biased paints for the relief that sits OVER the fills.
 *
 * @returns {object} a MapLibre hillshade paint object
 */
export function hillshadeOverPaints() {
  const hc = theme() === 'high-contrast';
  return {
    'hillshade-exaggeration': hc ? 0.50 : 0.35,
    'hillshade-shadow-color': hc ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.28)',
    'hillshade-highlight-color': hc ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.10)',
    /* ZERO. The accent is the one hillshade channel that carries a colour of
       its own, and any colour at all here would tint a published class. */
    'hillshade-accent-color': 'rgba(0,0,0,0)',
    'hillshade-method': 'igor',
  };
}

/**
 * Add the second hillshade, over the fills, under the labels. Reuses the `dem`
 * source `addHillshade` installed — a second layer costs a second paint, not a
 * second download. Same MapLibre ≥ 5.2 method-strip try/catch as
 * `addHillshade`.
 *
 * @param {any} map a maplibregl.Map with its style loaded
 * @param {string|undefined} beforeId  the label anchor; undefined appends
 * @returns {string} the layer id
 */
export function addHillshadeOver(map, beforeId) {
  if (!map.getSource(DEM_SOURCE)) {
    map.addSource(DEM_SOURCE, { ...TERRARIUM_DEM, tiles: [...TERRARIUM_DEM.tiles] });
  }
  const layer = {
    id: HILLSHADE_OVER_LAYER,
    type: 'hillshade',
    source: DEM_SOURCE,
    paint: hillshadeOverPaints(),
  };
  try {
    map.addLayer(layer, beforeId);
  } catch (err) {
    delete layer.paint['hillshade-method'];
    map.addLayer(layer, beforeId);
  }
  return HILLSHADE_OVER_LAYER;
}

/**
 * Re-derive BOTH hillshades' paints from the current theme, in place — never a
 * re-add: this app never calls `setStyle()`, so the layers survive and only
 * their colours go stale. Called from `restyleForTheme()` (js/layers.js);
 * unreached since the theme became URL-fixed at boot (tombstone at js/app.js),
 * kept with the restyle chain. The two layers take DIFFERENT paints —
 * token-derived vs achromatic literals — so one loop over one paint object
 * would put a tint back over the classes; each re-derives its own. Each
 * property is set independently: `hillshade-method` may have been stripped at
 * add time on an old MapLibre and would throw here, and one unsupported
 * refinement must not cost the colours after it in the loop. A no-op per
 * absent layer — degraded boots may have skipped the hillshade.
 *
 * @param {any} map a maplibregl.Map
 */
export function restyleHillshade(map) {
  if (!map || !map.getLayer) return;
  for (const [id, paints] of [[HILLSHADE_LAYER, hillshadePaints()],
                              [HILLSHADE_OVER_LAYER, hillshadeOverPaints()]]) {
    if (!map.getLayer(id)) continue;
    for (const [prop, value] of Object.entries(paints)) {
      try {
        map.setPaintProperty(id, prop, value);
      } catch (err) {
        console.warn(`[usdm] ${id} paint ${prop} not supported`, err);
      }
    }
  }
}
