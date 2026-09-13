/* ============================================================================
   USDM Editor · js/color.js
   The US Drought Monitor color encoding, and the rules for using it safely.

   THESE COLORS ARE NOT BRANDING (see CLAUDE.md): D0–D4 are the USDM's own
   published encoding — never from vendor/style/theme/ridr-theme.css, never
   varying by theme, never harmonised with the NGP RIDR palette. The brand owns
   the chrome; the USDM owns the data. Source: the ramp used by the
   sustainable-fsa/usdm archive pipeline.

   The ramp is hue-only (yellow → orange → red → dark red); D1/D2 and D3/D4
   converge under deuteranopia/protanopia, so colour is never the only channel
   (HOUSE-STYLE §6): the legend always prints the class name, the editor names
   the class in text, selection uses --selection-ring (the one hue that stays
   distinguishable against the whole ramp), and anything drawn ON a class fill
   uses labelInk().

   `labelInk()` is measured, not guessed. Black-on vs white-on, sRGB WCAG 2.x:

     D0 #ffff00   black 19.56   white  1.07   → black
     D1 #fcd37f   black 14.76   white  1.42   → black
     D2 #ffaa00   black 11.00   white  1.91   → black
     D3 #e60000   black  4.36   white  4.81   → white  (both marginal; white wins)
     D4 #730000   black  1.73   white 12.15   → white
   ========================================================================== */

/** Ordinal severity, worst last. Matches the archive's `usdm_class` values. */
export const CLASSES = Object.freeze(['D0', 'D1', 'D2', 'D3', 'D4']);

/**
 * The scope one step milder than D0: ground the archive paints no class over.
 *
 * It is `contour[−1]` in the two primitives' algebra (js/topology.js) — the
 * working area itself — and it is a real, choosable scope for the tool palette,
 * because "drought-free ground became D0" is the commonest degradation there is.
 * It is NOT a class: it never appears in `CLASSES`, has no colour in
 * `USDM_COLORS` and no label in `USDM_LABELS`, and `isClass()` in js/app.js must
 * go on refusing it. It lives here rather than in js/editor.js so that the
 * palette (js/app.js) and the verbs (js/editor.js) spell it the same way.
 */
export const NO_DROUGHT = 'none';

/** Every scope the two verbs accept, mildest first. `all` reads no band. */
export const SCOPES = Object.freeze(['all', NO_DROUGHT, ...CLASSES]);

/** What a scope is called on screen. The swatch never appears without one. */
export const SCOPE_LABELS = Object.freeze({
  all: 'Every class',
  [NO_DROUGHT]: 'No drought',
});

/** The USDM's published fill for each class. Do not edit. */
export const USDM_COLORS = Object.freeze({
  D0: '#ffff00',
  D1: '#fcd37f',
  D2: '#ffaa00',
  D3: '#e60000',
  D4: '#730000',
});

/** The USDM's own class names. Used wherever a swatch appears — §6. */
export const USDM_LABELS = Object.freeze({
  D0: 'Abnormally Dry',
  D1: 'Moderate Drought',
  D2: 'Severe Drought',
  D3: 'Extreme Drought',
  D4: 'Exceptional Drought',
});

/** Short descriptions, for the legend's expanded state and the help modal. */
export const USDM_DESCRIPTIONS = Object.freeze({
  D0: 'Going into drought: short-term dryness slowing planting or growth. ' +
      'Coming out of drought: lingering water deficits.',
  D1: 'Some damage to crops and pasture; streams, reservoirs or wells low; ' +
      'some water shortages developing.',
  D2: 'Crop or pasture losses likely; water shortages common; ' +
      'water restrictions imposed.',
  D3: 'Major crop and pasture losses; widespread water shortages or restrictions.',
  D4: 'Exceptional and widespread crop and pasture losses; ' +
      'shortages of water creating water emergencies.',
});

/** Ink to put ON a class fill so text or a symbol clears AA-small. See header. */
export function labelInk(usdmClass) {
  return (usdmClass === 'D3' || usdmClass === 'D4') ? '#ffffff' : '#000000';
}

/**
 * Legend items, worst-first — the order USDM legends print, and the order the
 * map draws in reverse. Every item carries its name, so the legend can never
 * degrade to color alone.
 */
export function legendItems({ order = 'worst-first' } = {}) {
  const list = CLASSES.map((c) => ({
    id: c,
    color: USDM_COLORS[c],
    label: `${c} · ${USDM_LABELS[c]}`,
    name: USDM_LABELS[c],
    description: USDM_DESCRIPTIONS[c],
    ink: labelInk(c),
  }));
  return order === 'worst-first' ? list.reverse() : list;
}

/* ══ The CHANGE palette ═════════════════════════════════════════════════════
   NDMC's second published encoding: the weekly CHANGE map — yellows through
   browns for DEGRADATION, greens through blues for IMPROVEMENT. Data, not
   brand, by the same argument as D0–D4; tools/tokens.test.mjs asserts both
   directions — these ten hexes must be HERE and not in the token blocks.

   Source: pixel-sampled from NDMC's published CONUS 1-week change map for
   2026-08-25 —
   droughtmonitor.unl.edu/data/chng/png/20260825/20260825_conus_chng_1W.png
   — the NDMC publishes the ramp only as a rendered legend, so a sampled pixel
   is the only citable form of it.

   NO SWATCH FOR "NO CHANGE": NDMC paints unchanged ground #cccccc because a
   PNG has nothing beneath it; this app does (terrain, basemap, the published
   classes), so the zero band is left DELIBERATELY UNPAINTED and every painted
   pixel means "this moved". The grey is recorded in prose, not a constant — a
   constant would invite someone to paint with it (see CLAUDE.md).

   The middle steps still converge under CVD simulation, so every surface
   carries the LABEL: `changeLegendItems()` never returns a bare swatch.

   Ink for text drawn ON a change swatch, sRGB WCAG 2.x, black-on vs white-on:

      5 #543005   black  1.80   white 11.65   → white
      4 #a87000   black  4.98   white  4.21   → black  (both marginal)
      3 #ff9900   black  9.81   white  2.14   → black
      2 #ffd438   black 14.73   white  1.43   → black
      1 #ffff73   black 19.80   white  1.06   → black
     -1 #cdffd4   black 18.85   white  1.11   → black
     -2 #8ad48c   black 11.88   white  1.77   → black
     -3 #359766   black  5.77   white  3.64   → black
     -4 #016678   black  3.17   white  6.62   → white
     -5 #003d75   black  1.92   white 10.91   → white
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * How many classes a place moved: `+n` degraded by n classes, `-n` improved by
 * n. Keys are STRINGS because they index a record and because `'-1'` and `'1'`
 * must both be spellable; the numeric value lives in `changeLegendItems()`.
 *
 * ±5 is the full range: "no drought" through D4 is six states, so the largest
 * possible move is five steps in either direction. Do not edit — see above.
 */
export const USDM_CHANGE_COLORS = Object.freeze({
  '1': '#ffff73',
  '2': '#ffd438',
  '3': '#ff9900',
  '4': '#a87000',
  '5': '#543005',
  '-1': '#cdffd4',
  '-2': '#8ad48c',
  '-3': '#359766',
  '-4': '#016678',
  '-5': '#003d75',
});

/** What each step is called in a sentence. Printed wherever a swatch is. */
export const USDM_CHANGE_LABELS = Object.freeze({
  '1': '1-class degradation',
  '2': '2-class degradation',
  '3': '3-class degradation',
  '4': '4-class degradation',
  '5': '5-class degradation',
  '-1': '1-class improvement',
  '-2': '2-class improvement',
  '-3': '3-class improvement',
  '-4': '4-class improvement',
  '-5': '5-class improvement',
});

/**
 * Worst first — the deepest degradation, down through the ramp, out to the
 * deepest improvement. Spelled out rather than derived from `Object.keys`,
 * which puts '1'–'5' before '-1'–'-5' because integer-like keys sort first.
 */
export const CHANGE_STEPS = Object.freeze(['5', '4', '3', '2', '1', '-1', '-2', '-3', '-4', '-5']);

/** Ink to put ON a change swatch so text clears AA-small. See the table above. */
export function changeInk(step) {
  const n = Number(step);
  return (n >= 5 || n <= -4) ? '#ffffff' : '#000000';
}

/**
 * Legend items for the change map, worst-first — the mirror of `legendItems()`,
 * and carrying the same guarantee: every item has its name on it, so the legend
 * can never degrade to colour alone.
 *
 * The zero step is absent by construction. There is no swatch for it — see the
 * header — so a legend that listed it would have to invent one.
 */
export function changeLegendItems({ order = 'worst-first' } = {}) {
  const list = CHANGE_STEPS.map((step) => ({
    id: step,
    delta: Number(step),
    color: USDM_CHANGE_COLORS[step],
    label: USDM_CHANGE_LABELS[step],
    name: USDM_CHANGE_LABELS[step],
    ink: changeInk(step),
  }));
  return order === 'worst-first' ? list : list.reverse();
}
