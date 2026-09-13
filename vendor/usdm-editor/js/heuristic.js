/* ============================================================================
   USDM Editor · js/heuristic.js
   The "one class per week" change-magnitude check (project handoff §3b).
   DOM-free, like js/topology.js; Turf from `globalThis.turf`. Node coverage:
   tools/topology.test.mjs §§ 11o (source scan) and 11p (runs it — including
   the claim that a ONE-class op flags zero points).

   An EDITORIAL NORM, not a rule: authors very rarely move ground more than one
   class per week, but a flash-drought week legitimately does — so this WARNS,
   never blocks, and nothing here is wired into the submission gate. The output
   rides in the proposal package so a reviewer sees the same flag the author
   saw, with the geometry that triggered it.

   Method: (1) the CHANGED region only — the symmetric difference between
   baseline and proposed contours (sampling the whole extent would dilute the
   percentage with untouched ground); (2) a fixed grid over it (default 0.05°
   ≈ 5 km); (3) each sample's class LAST WEEK vs UNDER THE PROPOSAL; (4) flag
   |proposed − previous| > 1.

   Comparison is against the PREVIOUS PUBLISHED WEEK, not the draft being
   edited from — "did this jump two classes since the last published map" is
   the reviewer's actual question. The package records both weeks.
   ========================================================================== */

import { T, CLASSES, asFeature, indexParts, bboxOverlaps, areaKm2 } from './topology.js';
import { changedExtentRegion } from './changeset.js';

/** Grid step in degrees. ~5 km at mid-latitudes. */
export const DEFAULT_STEP_DEG = 0.05;

/** Below this many samples the percentage is noise; report the count instead. */
export const MIN_SAMPLES_FOR_FRACTION = 25;

/* ── point classification ─────────────────────────────────────────────────── */

/**
 * A point-in-polygon oracle over one class's geometry, with a per-part bbox
 * prefilter.
 *
 * The prefilter is what makes grid sampling viable: without it every sample
 * costs a full ray cast against up to a thousand parts, and a state-sized
 * change region runs to tens of thousands of samples.
 */
function makeHitTester(geometry) {
  const turf = T();
  const parts = indexParts(geometry);
  if (!parts.length) return () => false;
  return (lng, lat) => {
    const pt = [lng, lat];
    const box = [lng, lat, lng, lat];
    for (const p of parts) {
      if (!bboxOverlaps(p.bbox, box)) continue;
      if (turf.booleanPointInPolygon(pt, { type: 'Polygon', coordinates: p.rings })) return true;
    }
    return false;
  };
}

/**
 * Severity oracle: the ordinal of the WORST class containing a point, or -1
 * for no drought. ONE walk serves both shapes this module compares: over
 * NESTED CONTOURS (a proposal) worst-first-stop-at-first-hit IS the answer;
 * over DISJOINT BANDS (an archive week) at most one class contains the point,
 * so any order returns the same class. The two differ only in how soon the
 * loop exits, never in what it returns — one implementation, not two.
 */
export function makeSeverityOracle(classGeometries) {
  const testers = CLASSES.map((c) =>
    (classGeometries[c] ? makeHitTester(classGeometries[c]) : null));
  return (lng, lat) => {
    for (let n = CLASSES.length - 1; n >= 0; n--) {
      if (testers[n] && testers[n](lng, lat)) return n;
    }
    return -1;
  };
}

/* ── the check ────────────────────────────────────────────────────────────── */

/**
 * Run the §3b heuristic.
 *
 * @param {object}  opts
 * @param {object}  opts.proposedContours  {D0..D4} nested contours as edited
 * @param {object}  opts.baselineContours  {D0..D4} the same week before editing
 * @param {object}  opts.previousContours  LAST WEEK's archive contours (nested;
 *                                         the oracle is equally correct over
 *                                         disjoint bands — see its doc)
 * @param {number} [opts.stepDeg]          grid step, degrees
 * @param {number} [opts.maxSamples]       hard ceiling, so a national-scale
 *                                         change cannot hang the UI thread
 * @returns {{code, flagged, sampled, fraction, geometry, samples, message, ranAt}}
 */
export function checkChangeMagnitude({
  proposedContours, baselineContours, previousContours,
  stepDeg = DEFAULT_STEP_DEG, maxSamples = 40000,
} = {}) {
  const turf = T();
  const ranAt = new Date().toISOString();
  /* `changedExtentRegion` with a null third argument IS the symmetric difference
     this check wants: the argument only adds the clip to the working area, which
     the national gate needs and a heuristic sampling the changed ground does
     not. This module carried a second copy of that arithmetic for a while, and
     two implementations of "where does the proposal disagree with its baseline"
     is one more than a reviewer can be asked to keep in step. No import cycle:
     js/changeset.js imports js/topology.js and nothing else. */
  const region = changedExtentRegion(baselineContours, proposedContours, null);
  if (!region) {
    return { code: 'class-jump', flagged: 0, sampled: 0, fraction: 0, geometry: null,
             samples: [], message: 'No geometry changed.', ranAt };
  }

  const [x0, y0, x1, y1] = turf.bbox(asFeature(region));
  const cols = Math.max(1, Math.ceil((x1 - x0) / stepDeg));
  const rows = Math.max(1, Math.ceil((y1 - y0) / stepDeg));
  /* Coarsen rather than truncate if the region is huge: a truncated grid would
     silently sample only the region's western edge and report a percentage of
     the wrong denominator. */
  const scale = Math.sqrt((cols * rows) / maxSamples);
  const step = scale > 1 ? stepDeg * scale : stepDeg;

  const inRegion = makeHitTester(region);
  const now = makeSeverityOracle(proposedContours);
  /* Last week's archive contours, healed at fetch (js/archive.js); the
     oracle would read disjoint bands the same way — see its doc. */
  const then = makeSeverityOracle(previousContours ?? {});

  const samples = [];
  let sampled = 0, flagged = 0;
  for (let lat = y0 + step / 2; lat <= y1; lat += step) {
    for (let lng = x0 + step / 2; lng <= x1; lng += step) {
      if (!inRegion(lng, lat)) continue;
      sampled++;
      const a = then(lng, lat);
      const b = now(lng, lat);
      /* -1 means "no drought", which is a real class for this comparison:
         going from no-drought straight to D1 is a two-step move and is exactly
         what the norm is about. */
      if (Math.abs(b - a) > 1) {
        flagged++;
        if (samples.length < 500) {
          samples.push({ lng: +lng.toFixed(5), lat: +lat.toFixed(5),
                         from: a < 0 ? null : CLASSES[a], to: b < 0 ? null : CLASSES[b],
                         jump: Math.abs(b - a) });
        }
      }
    }
  }

  const fraction = sampled ? flagged / sampled : 0;
  return {
    code: 'class-jump',
    flagged, sampled, fraction,
    stepDeg: step,
    areaKm2: areaKm2(region),
    geometry: flagged ? region : null,
    samples,
    message: describe({ flagged, sampled, fraction }),
    ranAt,
  };
}

function describe({ flagged, sampled, fraction }) {
  if (!sampled) return 'No geometry changed.';
  if (!flagged) {
    return `No part of the edited area moves more than one drought class ` +
           `(${sampled} sample${sampled === 1 ? '' : 's'}).`;
  }
  const where = sampled >= MIN_SAMPLES_FOR_FRACTION
    ? `${(fraction * 100).toFixed(0)}% of the edited area`
    : `${flagged} of ${sampled} sampled points in the edited area`;
  return `${where} moves two or more drought classes from last week's published map. ` +
         `That is unusual — confirm it is intentional before submitting.`;
}
