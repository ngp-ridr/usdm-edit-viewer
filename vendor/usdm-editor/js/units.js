/* ══ js/units.js — the units an author READS ═════════════════════════════════
   Every measurement in this app is computed in SI (turf measures the sphere in
   metres and square metres; `areaKm2` divides by 1e6; the proposal JSON carries
   `areaKm2` and `lengthKm`, whose key names say so). The people who read the
   sentences are US drought authors, who think in miles and square miles — so
   the conversion happens at the FORMAT layer, here, and nowhere else. The JSON
   keys and numbers stay metric on purpose: renaming a key is a schema change
   for every reader of a proposal file, and a number whose unit is in its key
   cannot be misread.

   DOM-free: this module is imported by the rules engine (js/topology.js,
   js/changes.js, js/geojson.js) and runs under Node; no window, no document,
   no turf. Precision follows the old `fmtArea`: one decimal under 100, none
   above — a proposal's areas are drawn freehand and do not know more.
   ══════════════════════════════════════════════════════════════════════════ */

/** Square kilometres in one square mile (international mile, exactly). */
export const KM2_PER_MI2 = 2.589988110336;
/** Miles in one kilometre. */
export const MI_PER_KM = 0.621371192237334;
/** Feet in one metre. */
export const FT_PER_M = 3.280839895013123;

/** The unit strings, so no caller spells one itself. */
export const MI2 = 'mi²';
export const SQUARE_MILES = 'square miles';

export function km2ToMi2(km2) { return km2 / KM2_PER_MI2; }
export function kmToMi(km) { return km * MI_PER_KM; }
export function mToFt(m) { return m * FT_PER_M; }

/** A bare area in square miles, from km² — locale-formatted, no unit. */
export function fmtMi2(km2) {
  if (!Number.isFinite(km2)) return 'not measured';
  const mi2 = km2ToMi2(km2);
  return mi2.toLocaleString(undefined, { maximumFractionDigits: mi2 < 100 ? 1 : 0 });
}

/**
 * A bare area in square miles at a FINER precision, for the small numbers the
 * advice rows carry (a thread can be a fraction of a square mile, and two
 * notices that both say "0.1" read as the same notice).
 */
export function fmtMi2Fine(km2) {
  if (!Number.isFinite(km2)) return 'not measured';
  return km2ToMi2(km2).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** A bare distance in miles, from km — one decimal under 10 miles. */
export function fmtMi(km) {
  if (!Number.isFinite(km)) return 'not measured';
  const mi = kmToMi(km);
  return mi.toLocaleString(undefined, { maximumFractionDigits: mi < 10 ? 1 : 0 });
}

/** A bare length in feet, from metres — for the residue-width sentence. */
export function fmtFt(m) {
  if (!Number.isFinite(m)) return 'not measured';
  return mToFt(m).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
