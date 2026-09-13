/* ============================================================================
   NGP RIDR house-style kit · ui/legend.js · v0.2.0
   Legends that are accessible surfaces, not pictures: a continuous colorbar
   and a categorical swatch list.

   ES module, no build step, no imports — every caller string lands in
   textContent, so there is no HTML parsing anywhere in this file and nothing
   to escape.

     import { colorbar, swatches }
       from '../vendor/style/ui/legend.js';

     const bar = colorbar(document.getElementById('legend-body'), batlow, {
       title:   'Grazing period length',
       ticks:   [{ at: 0, label: '30 d' }, { at: 0.5, label: '150 d' },
                 { at: 1, label: '270 d' }],
       textKey: 'Darker counties graze longer. Exact days are in the county card.',
       noData:  { color: '#cccccc', label: 'No reported grazing period' },
     });
     bar.update(nextRamp, { ticks: nextTicks });

   Three rules this module exists to enforce (HOUSE-STYLE §5.11, §6):

     1. COLOUR IS NEVER THE SOLE CHANNEL. The swatches are `aria-hidden`
        decoration; the labels, the tick labels, and the `textKey` sentence
        are the real content. A hue-only categorical scheme has NO information
        left in grayscale, so its category names must be printed — which is
        what `swatches()` does by construction.
     2. "NO DATA" IS A CATEGORY, not an absence. If a map draws counties in
        --no-data, the legend says so in words, and the chip is OUTLINED so it
        survives the high-contrast theme (where the fill is nearly the page
        ground).
     3. RAMPS ARE DATA, NOT CHROME. Every colour here is a literal CSS string
        the caller passes in — the kit does not tokenize them, does not
        theme-swap them, and does not have an opinion beyond §6's approved
        ramps (Crameri `batlow` / `romaO`, the CVD-safe ColorBrewer set;
        `Spectral` is banned). Tokens are for chrome; data gets its own
        palette.

   The cyclic MONTH-WHEEL legend for day-of-year (`romaO`) is deliberately NOT
   here: it has one consumer so far (fsa-normal-grazing-period) and stays
   app-local until a second one needs it — the kit's ≥2-property admission
   rule (AGENTS.md §5).

   Geometry note: the kit ships no legend CSS, so the few layout-critical
   declarations (chip size, row flex, bar height) are written as inline styles
   and everything else is a class an app or the theme can style later. Colours
   in those inline styles are either caller data or a `var(--token)` — never a
   literal hex.
   ========================================================================== */

/* ── Constants ───────────────────────────────────────────────────────────── */

/** Rects overlap by a hair so sub-pixel scaling can't open seams between
    adjacent ramp stops. In viewBox units of 100, this is 0.05%. */
const SEAM = 0.05;

/** viewBox width of the bar. Percent-like units: a tick at 0.5 sits at 50. */
const BAR_UNITS = 100;

/* ── Pure geometry (exported underscored for tests) ───────────────────────── */

/**
 * Rect geometry for an n-stop ramp, in bar viewBox units.
 * @param {number} n
 * @returns {Array<{x: number, width: number}>} the last rect is trimmed to the
 *          right edge exactly, so the bar can never overrun its own viewBox.
 */
export function _barRects(n) {
  const count = Math.max(0, Math.floor(n));
  const w = count ? BAR_UNITS / count : 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = i * w;
    out.push({ x, width: i === count - 1 ? BAR_UNITS - x : w + SEAM });
  }
  return out;
}

/**
 * Where a tick's label goes. A tick at either end must not hang off the bar,
 * so the end labels align to the bar's edges and only the interior ones
 * centre. `translate` is applied on the tick element, `align` positions the
 * label text and the mark inside it.
 * @param {number} at  0..1 along the bar (clamped; non-finite → 0)
 * @returns {{pct: number, translate: string, align: 'left'|'center'|'right'}}
 */
export function _tickPos(at) {
  const v = Number.isFinite(at) ? Math.min(1, Math.max(0, at)) : 0;
  const pct = v * 100;
  if (v <= 0.001) return { pct: 0, translate: '0', align: 'left' };
  if (v >= 0.999) return { pct: 100, translate: '-100%', align: 'right' };
  return { pct, translate: '-50%', align: 'center' };
}

/* ── Shared row builders ─────────────────────────────────────────────────── */

function makeTitle(text) {
  const p = document.createElement('p');
  // Reuses the theme's panel-title treatment (the ochre eyebrow) so a legend
  // title inside a panel body matches the panel's own head.
  p.className = 'ridr-panel-title ridr-legend-title';
  p.textContent = String(text);
  return p;
}

/**
 * One colour chip + its label. The chip is decoration (`aria-hidden`); the
 * label is the content. `outlined` adds an inset ring for the no-data chip,
 * whose fill is close to the page ground in both themes.
 */
function makeRow(color, label, outlined) {
  const li = document.createElement('li');
  li.className = 'ridr-legend-item';
  li.style.cssText = 'display:flex;align-items:center;gap:0.45rem;';

  const chip = document.createElement('span');
  chip.className = 'ridr-legend-chip';
  chip.setAttribute('aria-hidden', 'true');
  chip.style.cssText =
    'flex:0 0 auto;width:14px;height:14px;border-radius:var(--radius-sm);' +
    (outlined ? 'box-shadow:inset 0 0 0 1px var(--ctrl-border);' : '');
  // Caller data, assigned as a style value — never interpolated into markup.
  if (color) chip.style.background = String(color);

  const text = document.createElement('span');
  text.className = 'ridr-legend-label';
  text.textContent = String(label == null ? '' : label);

  li.append(chip, text);
  return li;
}

function makeList() {
  const ul = document.createElement('ul');
  ul.className = 'ridr-legend-items';
  ul.style.cssText =
    'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0.3rem;';
  return ul;
}

function makeKey(text) {
  const p = document.createElement('p');
  p.className = 'ridr-legend-key';
  p.style.cssText = 'margin-top:0.4rem;font-size:0.78rem;line-height:1.45;';
  p.textContent = String(text);
  return p;
}

/* ── Continuous colorbar ─────────────────────────────────────────────────── */

/**
 * A horizontal ramp bar with tick labels and a plain-language key.
 *
 * @param {HTMLElement} el  container; its contents are replaced
 * @param {string[]} colors ordered ramp stops, as literal CSS colour strings
 * @param {object} [opts]
 * @param {Array<{at: number, label: string}>} [opts.ticks]  `at` is 0..1 along
 *        the bar. A diverging ramp MUST label its midpoint (§6).
 * @param {{color: string, label: string}} [opts.noData]  the no-data category,
 *        drawn as an outlined chip row under the bar.
 * @param {string} [opts.title]
 * @param {string} [opts.textKey]  the accessible meaning of the ramp in a
 *        sentence — "darker counties graze longer", "blue is earlier". This is
 *        the redundancy channel that makes the bar legible in grayscale, to a
 *        CVD reader, and to a screen reader. Supply it.
 * @returns {{update: (colors: string[], opts?: object) => void, element: HTMLElement}}
 */
export function colorbar(el, colors, { ticks = [], noData, title, textKey } = {}) {
  if (!el) {
    console.warn('[ridr] colorbar: no container element');
    return { update() {}, element: null };
  }

  // Built ONCE. update() mutates these nodes; it never re-creates the tree,
  // so a legend that repaints on every year change costs no DOM churn.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + BAR_UNITS + ' 10');
  // Non-uniform scaling is fine for rectangles and would distort text — which
  // is exactly why the tick labels live in the HTML row below, not in here.
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');       // decoration; the key carries it
  svg.setAttribute('focusable', 'false');        // legacy IE/Edge tab-stop guard
  svg.setAttribute('class', 'ridr-legend-bar');
  svg.style.cssText = 'display:block;width:100%;height:14px;border-radius:var(--radius-sm);';

  const tickRow = document.createElement('div');
  tickRow.className = 'ridr-legend-ticks';
  tickRow.style.cssText = 'position:relative;height:1.4rem;margin-top:3px;';

  const state = { ticks, noData, title, textKey };

  let titleEl = null;
  let keyEl = null;
  let noDataList = null;

  function drawBar(stops) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const list = Array.isArray(stops) ? stops : [];
    _barRects(list.length).forEach((geom, i) => {
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(geom.x));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', String(geom.width));
      rect.setAttribute('height', '10');
      rect.setAttribute('fill', String(list[i]));   // caller data, verbatim
      svg.appendChild(rect);
    });
  }

  function drawTicks(list) {
    tickRow.replaceChildren();
    const items = Array.isArray(list) ? list : [];
    tickRow.hidden = !items.length;
    items.forEach((t) => {
      if (!t) return;
      const pos = _tickPos(t.at);
      const tick = document.createElement('span');
      tick.className = 'ridr-legend-tick';
      tick.style.cssText =
        'position:absolute;top:0;left:' + pos.pct + '%;' +
        'transform:translateX(' + pos.translate + ');' +
        'text-align:' + pos.align + ';white-space:nowrap;' +
        'font-size:0.68rem;color:var(--text-muted);';

      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.style.cssText =
        'display:block;width:1px;height:5px;margin-bottom:2px;' +
        'background:var(--ctrl-border);' +
        (pos.align === 'center' ? 'margin-left:auto;margin-right:auto;'
          : pos.align === 'right' ? 'margin-left:auto;' : 'margin-right:auto;');

      const label = document.createElement('span');
      label.textContent = String(t.label == null ? '' : t.label);

      tick.append(mark, label);
      tickRow.appendChild(tick);
    });
  }

  function drawNoData(nd) {
    if (noDataList) { noDataList.remove(); noDataList = null; }
    if (!nd) return;
    noDataList = makeList();
    noDataList.style.marginTop = '0.4rem';
    noDataList.appendChild(makeRow(nd.color, nd.label, true));
    el.appendChild(noDataList);
  }

  function build() {
    el.replaceChildren();
    titleEl = state.title ? makeTitle(state.title) : null;
    if (titleEl) el.appendChild(titleEl);
    el.appendChild(svg);
    el.appendChild(tickRow);
    keyEl = state.textKey ? makeKey(state.textKey) : null;
    if (keyEl) el.appendChild(keyEl);
    drawNoData(state.noData);
  }

  build();
  drawBar(colors);
  drawTicks(state.ticks);

  return {
    element: el,
    /**
     * Repaint. Pass only what changed; anything omitted stands.
     * @param {string[]} nextColors
     * @param {{ticks?: Array, noData?: object, title?: string, textKey?: string}} [nextOpts]
     */
    update(nextColors, nextOpts) {
      const o = nextOpts || {};
      const structural = ('title' in o) || ('textKey' in o) || ('noData' in o);
      if ('ticks' in o) state.ticks = o.ticks;
      if ('noData' in o) state.noData = o.noData;
      if ('title' in o) state.title = o.title;
      if ('textKey' in o) state.textKey = o.textKey;
      if (structural) build();                    // title/key/no-data changed shape
      if (nextColors !== undefined) drawBar(nextColors);
      drawTicks(state.ticks);
    },
  };
}

/* ── Categorical swatches ────────────────────────────────────────────────── */

/**
 * A list of colour-chip + label rows. The labels ARE the legend: a categorical
 * scheme is hue-only, so in grayscale the chips carry nothing at all (§6).
 *
 * @param {HTMLElement} el  container; its contents are replaced
 * @param {Array<{color: string, label: string}>} items
 * @param {object} [opts]
 * @param {{color: string, label: string}} [opts.noData]  appended last, with
 *        the outlined chip — "no data" is a category, and it is always last.
 * @param {string} [opts.title]
 * @returns {{update: (items: Array<object>, opts?: object) => void, element: HTMLElement}}
 */
export function swatches(el, items, { noData, title } = {}) {
  if (!el) {
    console.warn('[ridr] swatches: no container element');
    return { update() {}, element: null };
  }

  const state = { noData, title, items };
  const ul = makeList();

  function build() {
    el.replaceChildren();
    if (state.title) el.appendChild(makeTitle(state.title));
    el.appendChild(ul);
  }

  function draw(list) {
    state.items = list;
    ul.replaceChildren();
    (Array.isArray(list) ? list : []).forEach((item) => {
      if (!item) return;
      ul.appendChild(makeRow(item.color, item.label, false));
    });
    if (state.noData) ul.appendChild(makeRow(state.noData.color, state.noData.label, true));
  }

  build();
  draw(items);

  return {
    element: el,
    update(nextItems, nextOpts) {
      const o = nextOpts || {};
      if ('noData' in o) state.noData = o.noData;
      if ('title' in o) { state.title = o.title; build(); }
      draw(nextItems === undefined ? state.items : nextItems);
    },
  };
}
