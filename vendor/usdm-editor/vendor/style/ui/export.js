/* ============================================================================
   NGP RIDR house-style kit · ui/export.js · v0.2.0
   Branded PNG export: render the map off-screen at poster resolution, then
   compose the house chrome (header, credit line, both logos, the app's legend)
   around it on a canvas.

   ES module, no build step. Imports core/core.js; requires the vendored
   MapLibre GL UMD global (`window.maplibregl`) for the capture half only —
   composeBranded() works on any canvas.

     import { captureCompositeMap, composeBranded }
       from '../vendor/style/ui/export.js';

     const { canvas, dispose } = await captureCompositeMap({
       bounds: conusBounds,
       build: async (map) => { await addCountyLayer(map, year); },
     });
     const blob = await composeBranded(canvas, {
       title:    'Normal grazing period · 2023',
       subtitle: 'FSA county determinations · start day of year',
       credit:   'NGP RIDR · sustainable-fsa.com · CC BY 4.0',
       drawLegend: (ctx, rect) => drawRampLegend(ctx, rect),
     });
     dispose();

   Pairs with the `?export=` convention (HOUSE-STYLE §4): a URL param that
   forces a theme and triggers this path, so poster generation stays
   headless-scriptable from CI or a screenshot job.

   ── Attribution ────────────────────────────────────────────────────────────
   NEW in this kit — mco-web-style has no export module; MCO apps export by
   screenshot. The off-screen-map technique is the standard MapLibre recipe
   (a throwaway map in a fixed-size detached container with
   preserveDrawingBuffer); everything about the composition — the band
   geometry, the token resolution, the two logos, the legend contract — is
   house style.
   ========================================================================== */

import { kitUrl, getTheme } from '../core/core.js';

/* ── Off-screen capture ──────────────────────────────────────────────────── */

/** How long to wait for the throwaway map to go idle before shipping what it
    has. These maps draw GeoJSON with no basemap and no tile server, so idle
    normally arrives in well under a second; the ceiling exists so a headless
    export job fails loudly-but-completes instead of hanging forever. */
const IDLE_TIMEOUT_MS = 20000;

/** Fraction of the shorter side left as padding around the fitted bounds. */
const FIT_PADDING = 24;

/**
 * Render a map off-screen at an exact pixel size and hand back its pixels.
 *
 * @param {object} opts
 * @param {import('maplibre-gl').LngLatBoundsLike} opts.bounds  fitted at load
 * @param {number} [opts.width=1600]   CSS px of the off-screen container
 * @param {number} [opts.height=1000]
 * @param {number} [opts.pixelRatio=2] device pixels per CSS px — the output
 *        canvas is width*pixelRatio × height*pixelRatio
 * @param {string} [opts.background]   defaults to the live `--map-bg` token
 * @param {(map: object) => (void|Promise<void>)} [opts.build]  add the app's
 *        sources, layers, and feature-states. Awaited before the idle wait, so
 *        an async fetch inside it is fine.
 * @returns {Promise<{canvas: HTMLCanvasElement, dispose: () => void}>}
 *          `canvas` is a DETACHED copy — safe to keep after dispose().
 */
export async function captureCompositeMap({
  bounds, width = 1600, height = 1000, pixelRatio = 2, background, build,
} = {}) {
  const gl = typeof window !== 'undefined' ? window.maplibregl : null;
  if (!gl || typeof gl.Map !== 'function') {
    throw new Error('[ridr] captureCompositeMap: window.maplibregl is not loaded — ' +
      'add the vendored maplibre-gl script tag before calling this.');
  }

  // Off-screen but LAID OUT. display:none or visibility:hidden would give the
  // GL context a zero-sized drawing buffer (and on some drivers no context at
  // all); moving it far off the left edge keeps it real.
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-10000px;top:0;pointer-events:none;' +
    'width:' + Math.round(width) + 'px;height:' + Math.round(height) + 'px;';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  // The map ground comes from the live --map-bg token so an export matches
  // what is on screen in either theme. The literal is a last-resort fallback
  // for a page that hasn't loaded the theme stylesheet: it is the light
  // theme's --map-bg / --bg-deep value (brand cream), not a new colour.
  const bg = background || readToken('--map-bg') || '#faf7f2';

  let map = null;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    try { if (map) map.remove(); } catch (e) { /* already gone */ }
    container.remove();
  }

  try {
    map = new gl.Map({
      container,
      // The kit's blank style: no basemap, no tiles, no glyph host — the FSA
      // county composite IS the map (HOUSE-STYLE §7). Kept in sync with
      // map/map.js's blankStyle by hand; there is no import here on purpose,
      // so an export can be composed from a page that never loaded map.js.
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': bg } }],
      },
      // preserveDrawingBuffer keeps the WebGL back buffer readable after the
      // frame is presented, which is the only way drawImage/toDataURL sees
      // anything but black. It costs a full-buffer copy every frame, so it
      // belongs HERE ONLY — on a throwaway export map that renders a handful
      // of frames. NEVER set it on a live interactive map: it taxes every
      // pan and zoom for a feature the user isn't using.
      preserveDrawingBuffer: true,
      pixelRatio,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,          // no cross-fade left half-done when idle fires
    });

    await once(map, 'load');
    if (bounds) map.fitBounds(bounds, { padding: FIT_PADDING, duration: 0, animate: false });
    if (typeof build === 'function') await build(map);
    // Guarantee at least one more render cycle, so 'idle' is certain to fire
    // even for the degenerate export (no bounds, no build) where nothing the
    // caller did invalidated the frame.
    map.triggerRepaint();
    await idle(map);

    // Copy the GL canvas into a plain 2D canvas so the caller's pixels
    // outlive map.remove() — otherwise dispose() would have to wait for the
    // whole compose step, holding a GL context open the entire time.
    const src = map.getCanvas();
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    out.getContext('2d').drawImage(src, 0, 0);
    return { canvas: out, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

function once(map, event) {
  return new Promise((resolve) => map.once(event, resolve));
}

function idle(map) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut) {
        console.warn('[ridr] captureCompositeMap: map never went idle in ' +
          IDLE_TIMEOUT_MS + 'ms — exporting the frame as drawn.');
      }
      resolve();
    };
    const timer = setTimeout(() => finish(true), IDLE_TIMEOUT_MS);
    map.once('idle', () => finish(false));
  });
}

/* ── Branded composition ─────────────────────────────────────────────────── */

/* Chrome is authored in ONE logical coordinate system — 1600 units wide, and
   the map occupies 1000 of them at the default capture size — then scaled to
   whatever resolution the map canvas actually came back at. Change a number
   here and it means the same thing at 1× and at 4×. */
const LOGICAL_W = 1600;
const HEADER_H = 124;     // title + subtitle band
const RULE_H = 4;         // brand gradient hairline under the header
const FOOTER_H = 104;     // logos + credit line
const LEGEND_H = 120;     // reserved for drawLegend, when one is supplied
const PAD = 48;           // page margin
const BANNER_H = 44;      // 1225×350 intrinsic → 154 wide at this height
const MCO_H = 40;

/* The three weights the kit itself draws with. An app's drawLegend() may use
   others — it must load them itself (see the drawLegend contract below). */
const FONT_TITLE = '900 34px Roboto';
const FONT_SUB = '500 22px Roboto';
const FONT_CREDIT = '400 16px Roboto';

/**
 * Compose the house chrome around a captured map canvas.
 *
 * @param {HTMLCanvasElement} mapCanvas  from captureCompositeMap()
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.credit]  the attribution line. Not optional in
 *        practice: every export credits the project and its sources
 *        (HOUSE-STYLE §1).
 * @param {(ctx: CanvasRenderingContext2D, rect: {x, y, width, height}) => void}
 *        [opts.drawLegend]
 *        DRAWLEGEND CONTRACT — read this before writing one:
 *          • The rect is in the SAME logical units as the rest of the chrome
 *            (1600 wide), already scaled and already clipped: draw inside it
 *            and you cannot scribble on the map.
 *          • CANVAS PRIMITIVES ONLY — fillRect, fillText, arc, gradients. Do
 *            NOT try to rasterize the live DOM legend (no foreignObject-SVG
 *            round trip, no html2canvas): a foreignObject blob taints the
 *            canvas in Safari and silently drops web fonts everywhere else,
 *            and `toBlob` on a tainted canvas throws SecurityError. Draw the
 *            legend twice — once in DOM, once here — on purpose.
 *          • Any font weight/size beyond the kit's three (900 34px, 500 22px,
 *            400 16px Roboto) must be `await document.fonts.load(...)`-ed by
 *            the app BEFORE it calls composeBranded, or the first draw silently
 *            falls back to the system sans.
 * @param {'light'|'high-contrast'} [opts.theme=getTheme()]
 * @param {{banner?: string|false, mco?: string|false}} [opts.logos] URLs of the
 *   images to draw in the footer, left and right. FORK CHANGE: upstream takes
 *   booleans and reads two files from the kit's assets/; this fork has none, so
 *   a caller passes its own paths and anything falsy draws nothing.
 * @returns {Promise<Blob>} image/png
 */
export async function composeBranded(mapCanvas, {
  title, subtitle, credit, drawLegend,
  theme = getTheme(), logos = { banner: true, mco: true },
} = {}) {
  if (!mapCanvas || !mapCanvas.width) {
    throw new Error('[ridr] composeBranded: mapCanvas is empty');
  }

  const c = resolveThemeColors(theme);
  const scale = mapCanvas.width / LOGICAL_W;        // device px per logical unit
  const mapH = mapCanvas.height / scale;            // map height in logical units
  const legendH = typeof drawLegend === 'function' ? LEGEND_H : 0;
  const logicalH = HEADER_H + mapH + legendH + FOOTER_H;

  const out = document.createElement('canvas');
  out.width = Math.round(LOGICAL_W * scale);
  out.height = Math.round(logicalH * scale);
  const ctx = out.getContext('2d');
  ctx.scale(scale, scale);                          // everything below is logical

  // Load the kit's own text styles BEFORE the first fillText. A canvas does
  // not wait for a font the way the DOM does: draw early and the glyphs are
  // permanently the system fallback, with no error anywhere.
  await loadFonts([FONT_TITLE, FONT_SUB, FONT_CREDIT]);

  // Ground. Painted first so any rounding gap between bands is surface, not
  // transparent (a transparent PNG dropped into a slide deck goes black).
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, 0, LOGICAL_W, logicalH);

  /* Header */
  ctx.textBaseline = 'alphabetic';
  if (title) {
    ctx.font = FONT_TITLE;
    ctx.fillStyle = c.textPrimary;
    ctx.fillText(fitText(ctx, String(title), LOGICAL_W - PAD * 2), PAD, 58);
  }
  if (subtitle) {
    ctx.font = FONT_SUB;
    ctx.fillStyle = c.textMuted;
    ctx.fillText(fitText(ctx, String(subtitle), LOGICAL_W - PAD * 2), PAD, 94);
  }

  // The navbar's brand gradient, as a rule under the header.
  const grad = ctx.createLinearGradient(0, 0, LOGICAL_W, 0);
  grad.addColorStop(0, c.accentDk);
  grad.addColorStop(0.25, c.accent);
  grad.addColorStop(0.5, c.accentLight);
  grad.addColorStop(0.75, c.accent);
  grad.addColorStop(1, c.accentDk);
  ctx.fillStyle = grad;
  ctx.fillRect(0, HEADER_H - RULE_H, LOGICAL_W, RULE_H);

  /* Map */
  ctx.drawImage(mapCanvas, 0, HEADER_H, LOGICAL_W, mapH);

  /* Legend band */
  if (legendH) {
    const rect = { x: PAD, y: HEADER_H + mapH + 12, width: LOGICAL_W - PAD * 2, height: legendH - 24 };
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    try {
      drawLegend(ctx, rect);
    } catch (err) {
      console.error('[ridr] composeBranded: drawLegend threw; exporting without it.', err);
    }
    ctx.restore();
  }

  /* Footer */
  const footY = HEADER_H + mapH + legendH;
  ctx.fillStyle = c.border;
  ctx.fillRect(0, footY, LOGICAL_W, 1);

  const mid = footY + FOOTER_H / 2;
  let textLeft = PAD;
  let textRight = LOGICAL_W - PAD;

  /* FORK CHANGE: `logos.banner` and `logos.mco` accept a URL as well as a
     boolean. Upstream hard-codes two files in the kit's own assets/ directory;
     this fork ships no such directory, because the brand lives with the app
     (brand/) and duplicating a logo into the vendored kit would give it two
     copies to drift apart. A boolean `true` still means "the default", which
     here is simply nothing — there is no kit-owned logo to fall back to. */
  const bannerUrl = typeof logos?.banner === 'string' ? logos.banner : null;
  const mcoUrl = typeof logos?.mco === 'string' ? logos.mco : null;

  if (bannerUrl) {
    // Same-origin (or ACAO:* GitHub Pages) + crossOrigin='anonymous' keeps the
    // canvas UNTAINTED, which is what makes toBlob() legal below.
    const banner = await loadImage(bannerUrl);
    if (banner) {
      const w = scaledWidth(banner, BANNER_H, banner.naturalWidth / banner.naturalHeight);
      ctx.drawImage(banner, PAD, mid - BANNER_H / 2, w, BANNER_H);
      textLeft = PAD + w + 24;
    }
  }
  if (mcoUrl) {
    const mco = await loadImage(mcoUrl);
    if (mco) {
      const w = scaledWidth(mco, MCO_H, mco.naturalWidth / mco.naturalHeight);
      ctx.drawImage(mco, LOGICAL_W - PAD - w, mid - MCO_H / 2, w, MCO_H);
      textRight = LOGICAL_W - PAD - w - 24;
    }
  }

  if (credit) {
    ctx.font = FONT_CREDIT;
    ctx.fillStyle = c.textMuted;
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, String(credit), Math.max(80, textRight - textLeft)), textLeft, mid);
  }

  return toPngBlob(out);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function readToken(name, el) {
  if (typeof getComputedStyle !== 'function') return '';
  const target = el || document.documentElement;
  return getComputedStyle(target).getPropertyValue(name).trim();
}

/**
 * Resolve the theme tokens a canvas needs. GL paints and canvas contexts can't
 * read CSS custom properties, so they have to be resolved to literals — but
 * they are still resolved FROM the tokens, never hard-coded (AGENTS.md §2).
 *
 * The trick: the theme's high-contrast block is a plain `[data-theme=…]`
 * attribute selector, so a throwaway <div data-theme="high-contrast"> resolves
 * that theme's values even while the page is showing the other one. That
 * matters because `?export=` may force a theme the document isn't wearing.
 * The fallbacks are the light-theme token values, used only when the theme
 * stylesheet hasn't loaded at all.
 */
function resolveThemeColors(theme) {
  let probe = null;
  try {
    probe = document.createElement('div');
    probe.setAttribute('data-theme', theme);
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;';
    (document.body || document.documentElement).appendChild(probe);
    const pick = (name, fallback) => readToken(name, probe) || fallback;
    return {
      surface: pick('--bg-surface', '#ffffff'),
      border: pick('--border', '#e5e7eb'),
      textPrimary: pick('--text-primary', '#1f2937'),
      textMuted: pick('--text-muted', '#4b5563'),
      accent: pick('--accent', '#B7410E'),
      accentDk: pick('--accent-dk', '#8f320a'),
      accentLight: pick('--accent-light', '#cf5a26'),
    };
  } finally {
    if (probe) probe.remove();
  }
}

async function loadFonts(specs) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => {})));
}

/**
 * Load an image for the canvas. crossOrigin='anonymous' is deliberate: the kit
 * assets are same-origin for a sustainable-fsa.com page, but a *.github.io
 * preview serves the page from a different origin than kitUrl() resolves to.
 * GitHub Pages sends `access-control-allow-origin: *`, so the anonymous
 * request comes back CORS-clean and the canvas stays UNTAINTED either way —
 * without that, toBlob() would throw SecurityError on the preview origin only,
 * which is the worst possible place to discover it.
 * Never fatal: a missing logo costs a logo, not the export.
 */
async function loadImage(url) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) {
      // An SVG with a viewBox and no intrinsic width/height rasterizes at zero
      // in Safari and Firefox — silently, with no error. The kit's banner is
      // patched to carry both (HOUSE-STYLE §1); this catches a re-export that
      // dropped them.
      console.warn('[ridr] composeBranded: image has no intrinsic size, skipping:', url);
      return null;
    }
    return img;
  } catch (err) {
    console.warn('[ridr] composeBranded: could not load', url, err);
    return null;
  }
}

function scaledWidth(img, targetH, fallbackAspect) {
  const aspect = (img.naturalWidth && img.naturalHeight)
    ? img.naturalWidth / img.naturalHeight
    : fallbackAspect;
  return targetH * aspect;
}

/** Trim to fit, with an ellipsis. A title long enough to run off the poster is
    a truncated title on paper either way; better a clean one. */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const midIdx = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, midIdx) + ell).width <= maxWidth) lo = midIdx;
    else hi = midIdx - 1;
  }
  return text.slice(0, lo) + ell;
}

function toPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('[ridr] composeBranded: canvas.toBlob returned null'));
    }, 'image/png');
  });
}
