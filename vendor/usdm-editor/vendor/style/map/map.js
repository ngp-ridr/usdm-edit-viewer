/* ============================================================================
   NGP RIDR house-style kit · map/map.js · v0.2.0
   MapLibre GL setup for the basemap-less FSA county composite.

   ES module, no build step. Import it pinned to a release:

     import { createCompositeMap, addNavigation, addFitControl,
              installZoomFloor, fitDefault, cameraParams, cameraParamsIfDefault }
       from '../vendor/style/map/map.js';

   REQUIRES `window.maplibregl` — the vendored UMD build, loaded as a CLASSIC
   script BEFORE the app module:

     <script src="../vendor/style/vendor/maplibre-gl-5.18.0/maplibre-gl.js"></script>

   Every entry point asserts that global at first use and throws with that tag
   in the message, because the failure mode otherwise is a blank cream
   rectangle and a `maplibregl is not defined` five frames deep in a callback.

   There is NO basemap (HOUSE-STYLE §7): the county composite IS the map, on a
   brand-cream canvas. Nothing here fetches a tile, needs an API key, or adds
   an attribution bar. Rotation and pitch are off — a rotated composite is
   meaningless and the baked-in Alaska/Hawaii/Puerto Rico insets make it
   actively misleading.

   ── Attribution ────────────────────────────────────────────────────────────
   Ported from mt-climate-office/mco-web-style, map/mco-map.js (MIT). The
   zoom-floor hardenings come from mt-climate-office/mesonet-explorer's local
   version of that helper, specced for absorption in mco-web-style's
   CHANGELOG.md § "Planned for 0.7.0". Both kits are MIT.

   Deltas from mco-map.js:

     1. ES module with named exports — no IIFE, no `window.MCO` global.
     2. NO basemap helpers. `themedStyleUrl()`, `cartoStyleUrl()`,
        `addHillshade()`, `TERRARIUM_DEM`, `hillshadePaints()`,
        `firstSymbolLayerId()` and the Montana overlay/tribal-label paints are
        deliberately not ported: this fleet has no tile host and no basemap
        labels to slot under. `blankStyle()` + `createCompositeMap()` replace
        the whole basemap surface.
     3. `MT_FIT_BOUNDS` / `FIT_OPTS` are retired. Bounds come from the decoded
        geometry (`counties.bounds`, county/county.js); `COMPOSITE_BOUNDS`
        below is only a boot-time stand-in for the frames before it arrives.
     4. NEW `cameraParamsIfDefault()` — the clean-URL default-elision pair from
        the same "Planned for 0.7.0" list, shipped as one call rather than a
        separate `atDefaultExtent()` predicate. It compares against the pose a
        fit ACTUALLY settles at inside the maxBounds cage (see § Default pose),
        not against `cameraForBounds()`, which ignores the cage.
     5. `addFitControl()` is a real `IControl` (MCO appends a bare button and
        returns null when no group exists yet), so it survives `removeControl`
        and works before any other control is added — while still FUSING into
        the navigation group when there is one, which is the whole visual
        point.
     6. `installZoomFloor()` bakes in the two mco-0.7.0 hardenings (spring-back
        latch + chrome-only-resize skip) and the `onBeforeSnap` veto.
     7. The reduced-motion gate is imported from core/core.js instead of being
        inlined — this kit's core is an ES module, so there is no dependency
        cost to sharing the one live media query.
   ========================================================================== */

import { reducedMotion } from '../core/core.js';

/* ── Requirements ────────────────────────────────────────────────────────── */

const MAPLIBRE_TAG =
  '<script src="../vendor/style/vendor/maplibre-gl-5.18.0/maplibre-gl.js"></script>';

/**
 * The MapLibre GL UMD global, or a thrown Error naming the missing tag.
 * @returns {any} window.maplibregl
 */
function maplibre() {
  const gl = (typeof globalThis !== 'undefined') ? globalThis.maplibregl : undefined;
  if (!gl) {
    throw new Error(
      '[ridr/map] window.maplibregl is not defined. Load the vendored UMD '
      + 'build as a classic script BEFORE your app module:\n  ' + MAPLIBRE_TAG);
  }
  return gl;
}

/* ── Tokens → paints ─────────────────────────────────────────────────────────
   MAPLIBRE PAINTS CANNOT READ CSS CUSTOM PROPERTIES. Style values are resolved
   by the GL renderer, not the CSS engine, so `var(--map-bg)` in a paint is not
   a value at all — it is silently invalid and the layer draws in MapLibre's
   own default. Every token-derived paint in this kit is resolved through
   resolveToken() at layer-add time AND re-resolved on every theme change
   (map.js: nothing to re-apply here beyond the canvas; county/county.js:
   `handle.applyThemePaints()`). A theme toggle that only swaps `data-theme`
   leaves the map painted in the old palette. */

/**
 * Resolve a CSS custom property off <html> to a concrete value a GL paint can
 * use. Exported because any app-owned layer needs exactly this and copying it
 * per app is what the kit exists to prevent.
 * @param {string} name e.g. '--map-bg'
 * @param {string} [fallback] used when the theme CSS has not loaded (or when
 *        called outside a browser)
 * @returns {string}
 */
export function resolveToken(name, fallback = '') {
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return (v && v.trim()) || fallback;
}

// Restated light-theme value, used ONLY when the theme CSS has not applied yet
// (first paint of a page that loads the stylesheet late, or a test harness).
// Not a second source of truth: theme/ridr-theme.css owns --map-bg.
const MAP_BG_FALLBACK = '#faf7f2';

/* ── Framing ─────────────────────────────────────────────────────────────────
   The composite's own extent, rounded outward from the bbox that BOTH boundary
   archives share (dd17 and dd22 are byte-identical here: -125.2582, 18.5921,
   -66.9499, 49.3844 — Alaska, Hawaii and Puerto Rico arrive pre-translated
   into AlbersUSA-style insets, so this really is the whole composite).

   It is a BOOT-TIME stand-in only. The map is created before the topojson
   arrives; once county/county.js has decoded it, re-fit and re-arm the zoom
   floor against `counties.bounds`, which is recomputed from the features and
   is the authority. */
export const COMPOSITE_BOUNDS = [[-125.30, 18.55], [-66.90, 49.42]];

/** Padding/animation used by every fit in this module. */
const DEFAULT_FIT_OPTS = { padding: 24, animate: false };

// fitOpts may be a FUNCTION in every helper here, so an app whose padding
// depends on live chrome (an open sidebar, a bottom sheet) can pass a getter
// once instead of re-installing the control on every layout change.
function fitOptsOf(fitOpts) {
  const fo = (typeof fitOpts === 'function') ? fitOpts() : fitOpts;
  return fo || DEFAULT_FIT_OPTS;
}

// …and so may `bounds`, for the same reason and in the same helpers: an app
// whose extent follows the loaded vintage can hand `() => counties.bounds`
// to addFitControl()/installZoomFloor() once instead of tearing them down and
// re-installing them on every decode. (installZoomFloor's `refresh(newBounds)`
// is the other route; both are supported, neither is required.)
function boundsOf(bounds) {
  const b = (typeof bounds === 'function') ? bounds() : bounds;
  return b || COMPOSITE_BOUNDS;
}

/**
 * A style with no sources and one background layer — the cream canvas the
 * county layers sit on. This is the whole "basemap".
 * @param {{background?: string}} [opts] explicit color wins; otherwise the
 *        resolved --map-bg token.
 * @returns {object} a MapLibre style-spec object
 */
export function blankStyle({ background } = {}) {
  return {
    version: 8,
    sources: {},
    layers: [{
      id: 'background',
      type: 'background',
      paint: { 'background-color': background ?? resolveToken('--map-bg', MAP_BG_FALLBACK) },
    }],
  };
}

/**
 * The house map: blank style, no rotation, no pitch, no world copies, no
 * attribution control (there is nothing to attribute — see HOUSE-STYLE §7),
 * and a maxBounds cage so the composite can't be flung off screen.
 *
 * The container itself is the app's: give it `role="application"` and a
 * descriptive `aria-label`, and make sure the map is never the only route to
 * the data (HOUSE-STYLE §5.2). The kit deliberately does not stamp that role
 * for you — `role="application"` without a real label is worse than none.
 *
 * @param {{container: HTMLElement|string, bounds?: any, params?: URLSearchParams,
 *          fitPadding?: number, maxBoundsPadDeg?: number, background?: string}} [opts]
 * @returns {{map: any, bounds: any, fitOpts: {padding: number, animate: boolean}}}
 *          `bounds` and `fitOpts` are the exact values to hand to
 *          addFitControl() / installZoomFloor() / cameraParamsIfDefault().
 */
export function createCompositeMap({
  container, bounds = COMPOSITE_BOUNDS, params, fitPadding = 24,
  maxBoundsPadDeg = 6, background,
} = {}) {
  const gl = maplibre();
  const fitOpts = { padding: fitPadding, animate: false };
  const camera = initialCamera(params, { bounds, fitOpts });

  const map = new gl.Map({
    container,
    style: blankStyle({ background }),
    renderWorldCopies: false,     // one composite, not a repeating strip
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    maxPitch: 0,
    ...camera,
  });

  // Two-finger twist and the keyboard's shift+arrow rotation are separate
  // handlers from dragRotate and stay ON unless disabled explicitly.
  map.touchZoomRotate.disableRotation();
  if (map.keyboard && typeof map.keyboard.disableRotation === 'function') {
    map.keyboard.disableRotation();
  }

  map.setMaxBounds(padBounds(boundsOf(bounds), maxBoundsPadDeg));

  // The constructor's fit has already run and setMaxBounds() has already
  // re-constrained it, so the camera standing here IS the default pose — read
  // it back (§ Default pose). Not when the URL named a camera: that pose is the
  // reader's, not the default, and recording it would elide their ?lng&lat&zoom
  // out of the URL on the first moveend.
  poseState(map);                       // start tracking either way
  if (!camera.center) recordDefaultPose(map);

  return { map, bounds, fitOpts };
}

/**
 * Grow a [[w,s],[e,n]] box by `deg` on all sides, clamped to the valid
 * lng/lat domain. Pure — exported shape is the same as MapLibre's
 * LngLatBoundsLike array form.
 * @param {any} bounds [[w,s],[e,n]]
 * @param {number} deg
 * @returns {number[][]}
 */
export function padBounds(bounds, deg) {
  const [[w, s], [e, n]] = bounds;
  return [
    [Math.max(-180, w - deg), Math.max(-90, s - deg)],
    [Math.min(180, e + deg), Math.min(90, n + deg)],
  ];
}

/* ── Default pose ────────────────────────────────────────────────────────────
   WHAT THE DEFAULT VIEW ACTUALLY IS, on a caged map.

   `map.cameraForBounds()` ignores `maxBounds`. createCompositeMap() installs a
   cage (`padBounds(bounds, 6)`), and on a wide, short container — the shape of
   every county map in this fleet — the cage holds the camera at a HIGHER zoom
   than the fit alone would land on (measured on the kit demo's 1048×460 map
   container: 3.385 constrained against 2.922 reported; at a full-width
   1440×460 the same pair is 3.846 against 2.926). Comparing the live camera to
   cameraForBounds() therefore never matched on a real house map, so an
   untouched map emitted ?lng&lat&zoom and the clean-URL rule (HOUSE-STYLE §4)
   was broken on arrival.

   The fix is to stop predicting the default pose and start REMEMBERING it: the
   camera is read back at the moveend that concludes a kit fit, which is the
   constrained pose by construction, whatever MapLibre's cage arithmetic did.
   The kit records it

     • at boot, in createCompositeMap(), unless ?lng&lat&zoom named a camera
       (then there is no default pose to record and cameraParamsIfDefault()
       falls back to its old cameraForBounds() comparison);
     • at every fit it performs itself — fitDefault(), the fit control's
       button, and the zoom floor's spring-back;
     • after a container resize that found the camera still at the default
       pose (the cage re-frames silently there, and the pose moves with it);
     • on installZoomFloor()'s refresh(), which re-reads it for the current
       container and INVALIDATES it when it is handed new bounds.

   An app that re-frames the map itself should fit through fitDefault() rather
   than map.fitBounds(), which is the whole of the contract: a raw fitBounds is
   indistinguishable from any other programmatic camera move, so the kit leaves
   the remembered pose alone and the URL keeps the camera. */

/** One entry per map: `{pose, atDefault, rearm}`. WeakMap, not a property on
    the map, so nothing is stamped on the vendor object and the entry dies with
    the map. */
const POSE = new WeakMap();

/** Tolerances the TRACKER uses for "is the camera still where the last fit put
    it". cameraParamsIfDefault() takes its own (looser or tighter) eps from the
    caller; these only decide whether a resize or a refresh should re-read the
    pose, so they are deliberately not options. */
const POSE_ZOOM_EPS = 0.02;
const POSE_CENTER_EPS = 0.01;

function readPose(map) {
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
}

function poseMatches(a, b, eps, centerEps) {
  return !!a && !!b
    && Math.abs(a.zoom - b.zoom) < eps
    && Math.abs(a.lng - b.lng) < centerEps
    && Math.abs(a.lat - b.lat) < centerEps;
}

/**
 * The per-map pose state, creating it (and its two listeners) on first use.
 * @param {any} map
 * @returns {{pose: object|null, atDefault: boolean, rearm: boolean}}
 */
function poseState(map) {
  const found = POSE.get(map);
  if (found) return found;
  const st = { pose: null, atDefault: false, rearm: false };
  POSE.set(map, st);

  // Registered HERE, at create/track time, so it runs before the app's own
  // moveend handler (the one that mirrors the camera into the URL) — that
  // handler must read a pose that is already up to date.
  map.on('moveend', (e) => {
    // A user gesture that interrupts a flight ends the move too. It is not the
    // fit landing, so it must not be recorded as the default pose.
    const user = !!(e && e.originalEvent);
    if (st.rearm) {
      st.rearm = false;
      if (!user) { recordDefaultPose(map); return; }
    }
    st.atDefault = poseMatches(readPose(map), st.pose, POSE_ZOOM_EPS, POSE_CENTER_EPS);
  });

  // map.resize() re-constrains the camera against the cage BEFORE it fires its
  // own moveend, so the flag read here is still the PRE-resize truth: a map
  // that was showing its default framing is still showing it at the new size,
  // just at a different constrained zoom. Re-arm and let the concluding
  // moveend read the new pose back.
  map.on('resize', () => { if (st.atDefault) st.rearm = true; });

  return st;
}

/** Read the live camera back as this map's default pose. */
function recordDefaultPose(map) {
  const st = poseState(map);
  st.pose = readPose(map);
  st.atDefault = true;
  return st.pose;
}

/** Forget it — the framing it was measured against is gone. */
function invalidateDefaultPose(map) {
  const st = poseState(map);
  st.pose = null;
  st.atDefault = false;
}

/**
 * The pose a fit of the app's bounds ACTUALLY settles at on this map, as last
 * observed, or null when none has been recorded yet.
 * @param {any} map
 * @returns {{lng: number, lat: number, zoom: number}|null}
 */
export function defaultPose(map) {
  const st = POSE.get(map);
  return st && st.pose ? { ...st.pose } : null;
}

/**
 * The canonical fit: `map.fitBounds()` plus the bookkeeping that keeps
 * cameraParamsIfDefault() honest. Use it anywhere an app would otherwise call
 * map.fitBounds() to return to the full extent — a "reset view" button, a
 * re-frame after new geometry decodes.
 *
 * @param {any} map
 * @param {{bounds?: any, fitOpts?: any, animate?: boolean}} [opts]
 *        bounds and fitOpts may each be a value or a function returning one.
 *        animate defaults to the live reduced-motion gate, read AT CALL TIME
 *        (WCAG 2.3.3 — the user can flip the OS setting mid-session).
 */
export function fitDefault(map, { bounds = COMPOSITE_BOUNDS, fitOpts, animate } = {}) {
  const st = poseState(map);
  // The moveend that concludes THIS fit is the default pose, whatever the cage
  // did to it on the way.
  st.rearm = true;
  map.fitBounds(boundsOf(bounds), {
    ...fitOptsOf(fitOpts),
    animate: (animate === undefined) ? !reducedMotion() : animate,
  });
}

/* ── Camera ↔ URL ────────────────────────────────────────────────────────────
   The shared convention: ?lng&lat&zoom, 4 dp position / 2 dp zoom, and a
   camera at the default extent emits NOTHING so an all-defaults view has a
   clean URL. Read once at boot, mirror back on moveend with
   core's replaceUrlState(). */

/**
 * Spread into the Map constructor: an explicit camera when all three params
 * parse, otherwise a fit of `bounds`.
 * @param {URLSearchParams|null|undefined} searchParams
 * @param {{bounds: any, fitOpts: any}} opts
 * @returns {{center: [number, number], zoom: number}|{bounds: any, fitBoundsOptions: any}}
 */
export function initialCamera(searchParams, { bounds = COMPOSITE_BOUNDS, fitOpts } = {}) {
  const get = (k) => (searchParams && typeof searchParams.get === 'function')
    ? searchParams.get(k) : null;
  const lng = parseFloat(get('lng'));
  const lat = parseFloat(get('lat'));
  const zoom = parseFloat(get('zoom'));
  // All three or none: a half-specified camera is a stale/hand-edited URL, and
  // honoring part of it lands the user somewhere nobody chose.
  if (Number.isFinite(lng) && Number.isFinite(lat) && Number.isFinite(zoom)) {
    return { center: [lng, lat], zoom };
  }
  return { bounds: boundsOf(bounds), fitBoundsOptions: fitOptsOf(fitOpts) };
}

/**
 * Camera → URL params at the canonical precision. Strings, because they go
 * straight into a query string and toFixed() is what pins the precision.
 * @param {any} map
 * @returns {{lng: string, lat: string, zoom: string}}
 */
export function cameraParams(map) {
  const c = map.getCenter();
  return {
    lng: c.lng.toFixed(4),
    lat: c.lat.toFixed(4),
    zoom: map.getZoom().toFixed(2),
  };
}

/**
 * cameraParams(), or `{}` when the camera is still at the default pose — merge
 * the result into your app's params so the default view has no camera in its
 * URL at all. Collapses the old atDefaultExtent()+emit pair into one call.
 *
 * WHICH default pose: the one the kit REMEMBERED from the last fit it saw land
 * (§ Default pose), because that pose is the constrained one and
 * map.cameraForBounds() ignores the maxBounds cage createCompositeMap()
 * installs. Only when no pose has ever been recorded — a map built by hand
 * with no cage, or one whose reader arrived on a ?lng&lat&zoom camera — does
 * this fall back to comparing against cameraForBounds().
 *
 * @param {any} map
 * @param {{bounds?: any, fitOpts?: any, eps?: number, centerEps?: number,
 *          defaultPose?: object|(() => object)}} opts
 *        eps: zoom tolerance (0.02 ≈ the smallest zoom step a user can leave
 *        behind by scrolling). centerEps defaults to eps/2 in DEGREES.
 *        defaultPose: an explicit `{lng, lat, zoom}` (or a getter for one) to
 *        compare against, for an app that tracks the pose itself; it wins over
 *        the remembered one.
 * @returns {{}|{lng: string, lat: string, zoom: string}}
 */
export function cameraParamsIfDefault(map, {
  bounds = COMPOSITE_BOUNDS, fitOpts, eps = 0.02, centerEps, defaultPose: given,
} = {}) {
  const cEps = (centerEps == null) ? eps / 2 : centerEps;

  const explicit = (typeof given === 'function') ? given() : given;
  const remembered = explicit || defaultPose(map);
  if (remembered) {
    const rc = remembered.center;
    const rlng = (rc && typeof rc.lng === 'number') ? rc.lng
      : (rc && rc[0] != null) ? rc[0] : remembered.lng;
    const rlat = (rc && typeof rc.lat === 'number') ? rc.lat
      : (rc && rc[1] != null) ? rc[1] : remembered.lat;
    return poseMatches(readPose(map), { lng: rlng, lat: rlat, zoom: remembered.zoom }, eps, cEps)
      ? {} : cameraParams(map);
  }

  let want;
  try { want = map.cameraForBounds(boundsOf(bounds), fitOptsOf(fitOpts)); } catch (e) { want = null; }
  if (want) {
    // cameraForBounds returns a LngLat in some versions and a [lng,lat] in
    // others; accept both rather than pinning to one MapLibre minor.
    const wc = want.center;
    const wlng = (wc && typeof wc.lng === 'number') ? wc.lng : (wc && wc[0]);
    const wlat = (wc && typeof wc.lat === 'number') ? wc.lat : (wc && wc[1]);
    const c = map.getCenter();
    if (Number.isFinite(wlng) && Number.isFinite(wlat)
        && Math.abs(map.getZoom() - want.zoom) < eps
        && Math.abs(c.lng - wlng) < cEps
        && Math.abs(c.lat - wlat) < cEps) {
      return {};
    }
  }
  return cameraParams(map);
}

/* ── Controls ────────────────────────────────────────────────────────────── */

/**
 * House default: zoom buttons, no compass. Rotation is off in these apps and a
 * compass that never turns is noise.
 * @param {{showCompass?: boolean, position?: string}} [opts]
 * @returns {any} the NavigationControl (pass to map.removeControl to drop it)
 */
export function addNavigation(map, { showCompass = false, position = 'top-right' } = {}) {
  const gl = maplibre();
  const control = new gl.NavigationControl({ showCompass: showCompass === true });
  map.addControl(control, position);
  return control;
}

/**
 * "Zoom to full extent" — an IControl that FUSES into the navigation control
 * group when one already exists in the same corner, so it reads as a third
 * zoom button rather than a second floating box. NavigationControl renders its
 * DOM synchronously inside addControl(), so calling addNavigation() first is
 * enough to get the fused layout.
 *
 * The glyph is a CSS background-image (.maplibregl-ctrl-fit in
 * theme/ridr-theme.css), matching how the vendor draws its own buttons, so it
 * inherits --ctrl-icon-filter with them.
 *
 * @param {{bounds?: any, fitOpts?: any, title?: string, position?: string,
 *          group?: HTMLElement, onBeforeFit?: () => void}} [opts]
 *        bounds and fitOpts may each be a value or a function returning one —
 *        an app whose extent follows the loaded vintage can hand a getter here
 *        once. onBeforeFit runs before the camera moves — apps use it to close
 *        a detail surface or clear a selection first.
 * @returns {any} the control, with `.button` and `.setBounds(next)` exposed.
 *          setBounds() re-points a control that was installed against an older
 *          extent (the boot stand-in, last year's vintage) without removing and
 *          re-adding it, and invalidates the remembered default pose with it.
 */
export function addFitControl(map, {
  bounds = COMPOSITE_BOUNDS, fitOpts, title = 'Zoom to full extent',
  position = 'top-right', group, onBeforeFit,
} = {}) {
  maplibre();   // assert early: the failure should name the missing script tag

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'maplibregl-ctrl-fit';
  button.title = title;
  // Named for AT as well as on hover: an icon-only control with no accessible
  // name is a hard a11y stop (HOUSE-STYLE §5).
  button.setAttribute('aria-label', title);
  button.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';

  const onClick = () => {
    if (onBeforeFit) onBeforeFit();
    // fitDefault(), not map.fitBounds(): pressing this button is the user
    // asking for the default view back, so the pose it lands on IS the default
    // pose and the URL must go clean again (§ Default pose). Reduced motion is
    // read inside, at click time, not at install time (WCAG 2.3.3 — the user
    // can flip the OS setting mid-session).
    fitDefault(map, { bounds, fitOpts });
  };
  button.addEventListener('click', onClick);

  const control = {
    button,
    /** Re-point at a new extent. `bounds` is the destructured parameter, so
        this is the control's one piece of mutable state. */
    setBounds(next) {
      bounds = next;
      // The remembered pose was measured against the extent we just replaced.
      invalidateDefaultPose(map);
    },
    onAdd(m) {
      this._map = m;
      const corner = m.getContainer().querySelector('.maplibregl-ctrl-' + position);
      const host = group || (corner && corner.querySelector('.maplibregl-ctrl-group'));
      if (host) {
        // Fused: the button joins the existing group and this control's own
        // element is an empty, non-painting placeholder. It carries no
        // .maplibregl-ctrl class, so it draws no second glass box.
        host.appendChild(button);
        this._fusedInto = host;
        this._el = document.createElement('div');
        this._el.style.display = 'none';
        return this._el;
      }
      this._el = document.createElement('div');
      this._el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      this._el.appendChild(button);
      return this._el;
    },
    onRemove() {
      button.removeEventListener('click', onClick);
      if (button.parentNode) button.parentNode.removeChild(button);
      if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
      this._map = undefined;
    },
  };

  map.addControl(control, position);
  return control;
}

/* ── Zoom floor ──────────────────────────────────────────────────────────────
   Keeps the composite filling the viewport: when the user zooms out past the
   zoom that fits `bounds`, the camera springs back, and the fit zoom is
   recomputed after (debounced) resizes.

   Why not setMinZoom? It was tried in mesonet-explorer and was wrong twice
   over: zooming out did nothing at all, and MapLibre disables its own zoom-out
   button at minZoom, so the control greyed out with no explanation. */

// Tolerance on the zoom comparison. A settled fitBounds lands a hair below
// fitZoom often enough that a bare `<` re-fires forever.
const SPRING_EPS = 0.01;

// Height-only resize smaller than this is chrome, not layout: a mobile URL bar
// showing/hiding, or the app's own navbar re-wrapping.
const CHROME_RESIZE_PX = 120;

/**
 * @param {any} map
 * @param {{bounds?: any, fitOpts?: any, resizeDebounceMs?: number,
 *          onBeforeSnap?: () => boolean|void}} [opts]
 *        bounds and fitOpts may each be a value or a function returning one —
 *        pass a getter and the floor follows the app's live extent with no
 *        refresh at all. onBeforeSnap returning EXACTLY false vetoes the snap.
 *        App policy lives there — "don't yank the camera while a county detail
 *        is open", "a sidebar toggle IS the user asking to re-fit".
 * @returns {{refresh: (newBounds?: any) => void, fitZoom: () => number|undefined,
 *            dispose: () => void}}
 *        refresh() recomputes the fit zoom for the CURRENT container, and
 *        re-reads the remembered default pose when the camera is still sitting
 *        on it. Call it from map.on('load') (cameraForBounds needs a laid-out
 *        container).
 *
 *        refresh(newBounds) ALSO replaces the extent the floor is armed
 *        against — that is the call to make after the first vintage decode
 *        swaps COMPOSITE_BOUNDS for counties.bounds. It invalidates the
 *        remembered default pose with it (the old pose framed the old extent);
 *        the next fitDefault() — or a press of the fit control — records the
 *        new one. A bare refresh() never changes the extent.
 */
export function installZoomFloor(map, {
  bounds = COMPOSITE_BOUNDS, fitOpts, resizeDebounceMs = 200, onBeforeSnap,
} = {}) {
  let fitZoom;
  let timer = null;
  let lastSize = containerSize();
  // Hardening 1 of 3 (mco-0.7.0): an ANIMATED fitBounds raises further zoomend
  // events while the flight is still in progress. Each one re-tests
  // `getZoom() < fitZoom`, which is still true mid-flight, so without this
  // latch the snap re-fires re-entrantly and the camera stutters.
  let springingBack = false;

  function containerSize() {
    const c = map.getContainer && map.getContainer();
    return c ? { w: c.clientWidth, h: c.clientHeight } : null;
  }

  function compute() {
    let cam = null;
    try { cam = map.cameraForBounds(boundsOf(bounds), fitOptsOf(fitOpts)); } catch (e) { cam = null; }
    if (cam && Number.isFinite(cam.zoom)) fitZoom = cam.zoom;
    lastSize = containerSize() || lastSize;
  }

  /** @param {any} [newBounds] the extent to arm against from here on. */
  function refresh(newBounds) {
    if (newBounds !== undefined) {
      bounds = newBounds;
      // A pose measured against the extent we just replaced is not this map's
      // default pose any more (§ Default pose).
      invalidateDefaultPose(map);
    }
    compute();
    // Same extent, possibly a new container: if the camera is still sitting on
    // the remembered pose, the cage may have quietly re-framed it since, so
    // read it back rather than leave a stale one behind.
    if (newBounds === undefined && poseState(map).atDefault) recordDefaultPose(map);
  }

  function below() {
    return fitZoom !== undefined && map.getZoom() < fitZoom - SPRING_EPS;
  }

  function snapBack() {
    // Hardening 3 of 3: app policy can veto. Only an explicit `false` does —
    // a hook that forgets to return still snaps.
    if (onBeforeSnap && onBeforeSnap() === false) return;
    springingBack = true;
    map.once('moveend', () => { springingBack = false; });
    // A spring-back lands on the default framing by definition, so it records
    // the default pose like any other kit fit.
    fitDefault(map, { bounds, fitOpts });
  }

  function onZoomEnd() {
    if (springingBack || fitZoom === undefined) return;
    if (!below()) return;
    snapBack();
  }

  function onResize() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const size = containerSize();
      // Hardening 2 of 3: a height-only change under CHROME_RESIZE_PX is a
      // mobile URL bar, not the user asking for a new framing. The fit zoom is
      // still recomputed (it genuinely changed), but the camera is left alone.
      const chromeOnly = !!(size && lastSize && size.w === lastSize.w
        && Math.abs(size.h - lastSize.h) < CHROME_RESIZE_PX);
      compute();
      if (chromeOnly) return;
      if (below()) snapBack();
    }, resizeDebounceMs);
  }

  map.on('zoomend', onZoomEnd);
  map.on('resize', onResize);
  // The default-pose tracker is the map's, not this handle's: dispose() below
  // drops only what was added here. Touching it now means a hand-built map
  // (one that never went through createCompositeMap) is tracked from install.
  poseState(map);

  return {
    refresh,
    fitZoom: () => fitZoom,
    dispose() {
      clearTimeout(timer);
      timer = null;
      map.off('zoomend', onZoomEnd);
      map.off('resize', onResize);
    },
  };
}
