/* ============================================================================
   USDM Editor · js/dom.js
   The shared DOM helpers — one copy instead of per-file drift.

   ── The `style` throw is the load-bearing part ─────────────────────────────
   This page runs under `style-src 'self'` with no `'unsafe-inline'`, so a
   `style` ATTRIBUTE is dropped by the browser silently and reads as a CSS bug.
   `el()` refuses one at the call site instead. Setting `.style.foo` through
   the CSSOM is a different mechanism and is fine — it is how the USDM legend
   and class swatches get their colour.

   ── DOM-ONLY. The rules engine must never import this ──────────────────────
   js/topology.js, js/changeset.js, js/changes.js, js/delta.js, js/geojson.js,
   js/heuristic.js and js/session.js run under Node in tools/ and stay free of
   `window`, `document` and `fetch` — which means free of this file.
   tools/topology.test.mjs §§ 11n, 14h and 15i assert that against the source.
   ========================================================================== */

/**
 * Element helper: tag, attributes, children.
 *
 * It REFUSES a `style` attribute, deliberately — see the header. Attributes
 * whose value is `null` or `undefined` are skipped rather than stringified, so
 * `{ required: cond ? '' : null }` reads the way it looks. `null` children are
 * dropped for the same reason.
 */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') {
      throw new Error('[usdm/dom] inline style attributes are blocked by this ' +
        'page\'s CSP — add a class to css/app.css instead.');
    }
    if (v != null) n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}

/**
 * The app's ordinary button.
 *
 * `type="button"` always, because a `<button>` with no type is a SUBMIT button,
 * and several of these live inside the drawer's forms.
 */
export function button(label, onClick) {
  const b = el('button', { type: 'button', class: 'nav-btn' }, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** Secondary explanatory text under a control. */
export function hint(text) {
  return el('p', { class: 'hint' }, text);
}

/**
 * A section heading.
 *
 * A plain `<h3>` on purpose: `.info-section h3` in the kit already styles these
 * as the brand's uppercase eyebrow, so a local class here would only fight it.
 */
export function heading(text) {
  return el('h3', {}, text);
}

/**
 * Read a design token off the document root, with a fallback.
 *
 * The fallback is not decoration. A custom property that does not exist is not
 * an error in CSS: `getPropertyValue` returns the empty string, and whatever
 * consumes it — a MapLibre paint property, a canvas `fillStyle` — gets nothing
 * and then fails in its own way, far from the cause. That is the failure
 * tools/tokens.test.mjs exists to catch; this is the seatbelt for the one that
 * gets through.
 */
export function cssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Hand a Blob to the user as a download.
 *
 * The anchor has to be IN the document for the synthetic click to count in
 * every browser, and the object URL has to outlive the click — revoking it
 * synchronously afterwards cancels the download in some of them. Ten seconds is
 * long enough for any browser to have started reading it and short enough that
 * a long session does not accumulate blobs.
 */
export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
