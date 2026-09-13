/* ══ USDM Edit Viewer · tools/synthetic.mjs ═══════════════════════════════════
   Two proposals over one square degree that disagree on purpose.

   ── WHY A SYNTHETIC PAIR EXISTS AT ALL ────────────────────────────────────
   The twelve bundled examples are the corpus this engine is TUNED against:
   real archive geometry, real clipper residue, real unsimplified state
   boundaries, and answers nobody knew in advance. They are exactly the wrong
   fixture for asking "does the comparison arithmetic give the right number",
   because on that corpus there is no right number written down anywhere — only
   what the code says, which is what a test is supposed to be checking.

   So this builds a pair whose answer can be worked out on paper:

       the working area   a 1° × 1° square
       published          D1 over the whole of it
       proposal A         DEGRADES the west half to D2, plus a small block in
                          the east half
       proposal B         IMPROVES the west half to D0

   which must produce EXACTLY:

       · one CONFLICT over the west half — A says D2, B says D0, the published
         week said D1, so neither side's answer is the published one. Magnitude
         2, and its area is half the square to within the clipper's noise.
       · one ONE-SIDED region over the east block — A moved it, B left it as
         published.
       · nothing anywhere else: over the rest of the east half both proposals
         say D1, and a partition cannot disagree with itself.

   The packages are shaped like real ones down to the key order, so they go
   through `parseProposal`, `verifyPackage` and the whole engine on the same
   path a picked file does — a fixture that skips the parser tests only the
   half of the code a real file would already have passed.

   Not a fixture FILE: it is built here, in seven boolean ops, so nothing has
   to be regenerated when the shape of a package changes.
   ========================================================================== */

/* This module is turf-only through `T()`, like the engine it feeds; the caller
   assigns `globalThis.turf` before importing it (tools/compare.test.mjs). */
import {
  T, asFeature, asMulti, deriveBands, areaKm2,
} from '../vendor/usdm-editor/js/topology.js';

const WEEK = '2026-09-08';
const SHA = 'f'.repeat(64);

/** The square, somewhere with no coastline and no antimeridian in sight. */
export const SQUARE = Object.freeze([-100, 40, -99, 41]);

/**
 * Build the pair.
 *
 * @param {object} [opts]
 * @param {number[]} [opts.bbox]  the working area, `[w, s, e, n]`
 * @returns {{A: object, B: object, square: object, west: object, east: object,
 *            block: object, squareKm2: number, westKm2: number, blockKm2: number}}
 */
export function syntheticPair({ bbox = SQUARE } = {}) {
  const [w, s, e, n] = bbox;
  const mid = (w + e) / 2;
  const square = rect(w, s, e, n);
  const west = rect(w, s, mid, n);
  const east = rect(mid, s, e, n);
  /* A block inside the EAST half, well clear of the midline, so the one-sided
     region cannot touch the conflict and be dissolved into it. */
  const block = rect(mid + 0.25, s + 0.25, mid + 0.45, s + 0.45);

  const aoi = {
    kind: 'state', id: 'state:ZZ', name: 'Square', bbox: [...bbox], geometry: square,
  };

  /* Published: D1 everywhere, which as CONTOURS is D0 ⊇ D1 = the square and
     nothing severer. */
  const publishedContours = { D0: square, D1: square, D2: null, D3: null, D4: null };

  /* A degrades: D2 appears over the west half and the block. The D0 and D1
     contours do not move — a degradation from D1 to D2 is entirely inside
     them — which is why `changes[]` names D2 alone, exactly as the editor's
     own package would. */
  const aD2 = union(west, block);
  const aContours = { D0: square, D1: square, D2: aD2, D3: null, D4: null };

  /* B improves: the D1 contour retreats to the east half. The D0 contour does
     not move (the ground is still D0-or-worse), so `changes[]` names D1. */
  const bContours = { D0: square, D1: east, D2: null, D3: null, D4: null };

  const A = pkg({
    id: '11111111-1111-4111-8111-111111111111',
    aoi,
    contours: aContours,
    changes: [{ cls: 'D2', before: publishedContours.D2, after: aContours.D2 }],
    published: publishedContours,
    changedRegion: aD2,
    patches: [
      patch(1, west, ['D2'], 'grew',
        'The west half has been dry for sixty days and reads D2 on every short-term index.'),
      patch(2, block, ['D2'], 'grew',
        'A block east of the midline that dried with the west half and should read the same.'),
    ],
    author: {
      name: 'Avery Nash', email: 'avery.nash@example.org',
      affiliation: 'Square County Extension', role: 'Extension', onBehalfOf: '',
    },
    rationale: 'The west half of this working area has been in D1 since July and every ' +
      'short-term index has fallen since. We ask for D2 across it, and for the block east ' +
      'of the midline that dried with it.',
    impacts: 'Stock water is being hauled across the west half and the block.',
  });

  const B = pkg({
    id: '22222222-2222-4222-8222-222222222222',
    aoi,
    contours: bContours,
    changes: [{ cls: 'D1', before: publishedContours.D1, after: bContours.D1 }],
    published: publishedContours,
    changedRegion: west,
    patches: [
      patch(1, west, ['D1'], 'shrank',
        'Two inches of rain fell on the west half in the last ten days and the D1 ' +
        'signature is gone; D0 is the honest class.'),
    ],
    author: {
      name: 'Blair Okonkwo', email: 'blair.okonkwo@example.org',
      affiliation: 'Square Basin Irrigation District', role: 'Producer / land manager',
      onBehalfOf: 'the district board',
    },
    rationale: 'We read the same week the other way. The rain of the last ten days landed ' +
      'on the west half and the profile has recovered; D0 is the class that describes it.',
    impacts: 'The class decides programme eligibility for every operation on the west half.',
  });

  return {
    A, B, square, west, east, block,
    squareKm2: areaKm2(square),
    westKm2: areaKm2(west),
    blockKm2: areaKm2(block),
  };
}

/* ── the package shape ────────────────────────────────────────────────────── */

/**
 * A package with the /2 key order of `buildPackageCore`, so a fixture and a
 * real file differ in their geometry and in nothing else.
 */
function pkg({ id, aoi, contours, changes, published, changedRegion, patches, author, rationale, impacts }) {
  const bands = deriveBands(contours);
  const publishedBands = deriveBands(published);
  return {
    schema: 'usdm-edit-proposal/2',
    id,
    created: '2026-09-09T00:00:00.000Z',
    app: { name: 'ngp-ridr/usdm-editor', version: '0.1.0' },
    baseline: {
      week: WEEK,
      source: `https://data.sustainable-fsa.com/usdm/data/parquet_unclipped/USDM_${WEEK}.parquet`,
      sha256: SHA,
      nesting: { healed: false, leaksM2: { D0: 0, D1: 0, D2: 0, D3: 0 } },
    },
    priorWeek: null,
    aoi,
    author,
    changes: changes.map(({ cls, before, after }) => ({
      class: cls,
      label: cls,
      before,
      after,
      areaKm2: {
        before: areaKm2(publishedBands[cls]),
        after: areaKm2(bands[cls]),
        delta: areaKm2(bands[cls]) - areaKm2(publishedBands[cls]),
      },
      parts: {
        before: publishedBands[cls] ? publishedBands[cls].coordinates.length : 0,
        after: bands[cls] ? bands[cls].coordinates.length : 0,
      },
    })),
    proposedChanges: patches,
    /* Nothing reaches a border here: the square's neighbours do not exist, and
       a seam fixture would be a different fixture. */
    edgeEffects: [],
    changedRegion,
    derivedBands: Object.fromEntries(['D0', 'D1', 'D2', 'D3', 'D4'].map((c) => [c, bands[c] ?? null])),
    justification: {
      format: 'markdown',
      rationale,
      impacts,
      evidence: [{ url: 'https://drought.gov/states', label: 'Drought.gov — state dashboard' }],
      borderNotes: {},
    },
    edgeBrief: null,
    heuristic: { skipped: 'no-prior-week' },
    warnings: [],
    validation: { scope: 'national', contours: null, derivedBands: null, passed: true },
    reproduce: { method: 'changeset.applyToNational', note: 'synthetic', nationalBandTally: {} },
  };
}

function patch(seq, geometry, classes, direction, rationale) {
  const turf = T();
  const feature = asFeature(geometry);
  return {
    id: `patch-${seq}-${classes.join('')}`,
    seq,
    name: `Change ${seq}`,
    geometry: geometry.coordinates ? { type: 'Polygon', coordinates: geometry.coordinates[0] } : geometry,
    anchor: turf.pointOnFeature(feature).geometry.coordinates,
    bbox: turf.bbox(feature),
    areaKm2: areaKm2(geometry),
    classes: classes.map((c) => ({
      class: c, label: c, direction,
      category: direction === 'grew' ? 'edge-advanced' : 'edge-retreated',
      phrase: direction === 'grew' ? `${c}'s edge advanced` : `${c}'s edge retreated`,
    })),
    rationale,
    groupId: null,
    reviewed: false,
    annotated: true,
  };
}

/* ── geometry ─────────────────────────────────────────────────────────────── */

/** A rectangle as a MultiPolygon, wound the way the archive winds its rings. */
function rect(w, s, e, n) {
  return {
    type: 'MultiPolygon',
    coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]],
  };
}

function union(a, b) {
  const turf = T();
  return asMulti(turf.union(turf.featureCollection([asFeature(a), asFeature(b)])));
}
