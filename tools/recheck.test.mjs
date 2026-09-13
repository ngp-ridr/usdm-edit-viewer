/* ============================================================================
   USDM Edit Viewer · tools/recheck.test.mjs
   The re-check's MAGNITUDE GRADING, over the twelve bundled packages.

     node tools/recheck.test.mjs

   ── What this gate is for ──────────────────────────────────────────────────
   `js/recheck.js` exists because `verifyPackage`'s mutual-containment rule
   fails EIGHT OF THE TEN original example proposals — every failure a fraction
   of a square mile of clipper residue along a shared edge, none of it an edit.
   A tool that reported those eight as "hand-edited or produced by a different
   version" would be worse than no tool.

   So this file pins the answer on the reference corpus, in both directions:

     · every one of the twelve grades `pass` or `residue`, NONE `defect` —
       otherwise the viewer cries wolf on the app's own output;
     · a band translated 500 m grades `defect` — otherwise it cries nothing at
       all, and the grading has quietly become a way of ignoring problems.

   The two clean ones are named rather than counted: SD-9c26907b and
   MT-06e8fb67 are the packages whose `deriveBands` round trip happens to drop
   nothing, and if a third joins them something upstream changed.

   ── Where the packages come from ───────────────────────────────────────────
   `demo/` first (the bundled set, which is what the app itself reads), then
   the editor's `examples/proposals/` beside this repo. Neither present is a
   SKIP, not a failure: the grading maths above still runs on synthetic input,
   and a checkout without the demo set is a checkout, not a bug.

   turf is loaded onto `globalThis` from the vendored UMD before any module
   import, exactly as the editor's tools/topology.test.mjs does it — the
   vendored `topology.js` reads `globalThis.turf` through `T()` and throws a
   named error if it is missing.
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── turf, first: the modules below read it at import time through `T()`. ── */
const turfSrc = readFileSync(
  join(ROOT, 'vendor/usdm-editor/vendor/turf-7.4.0/turf.min.js'), 'utf8');
const turfModule = { exports: {} };
new Function('module', 'exports', turfSrc)(turfModule, turfModule.exports);
globalThis.turf = turfModule.exports;

const { recheckPackage, recheckSentence, gradeEscape, RESIDUE_MAX_KM2 } =
  await import(join(ROOT, 'js/recheck.js'));
const { RESIDUE_WIDTH_M, CONTAINMENT_TOLERANCE_M2 } =
  await import(join(ROOT, 'vendor/usdm-editor/js/topology.js'));

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const skip = (m) => console.log(`  skip ${m}`);
const check = (c, m) => (c ? ok(m) : bad(m));

/* ── the corpus ───────────────────────────────────────────────────────────── */

/** Every bundled package, newest source first. `[]` when neither exists. */
function loadCorpus() {
  const dirs = [
    join(ROOT, 'demo'),
    join(ROOT, '..', 'usdm-editor', 'examples', 'proposals'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir).filter((n) => n.endsWith('.json.gz')).sort();
    if (!names.length) continue;
    return names.map((name) => ({
      name,
      /* The short id is the last field of the filename and the thing every
         sentence in this repo calls a proposal by. */
      key: name.replace(/^usdm-proposal-[\d-]+-state-/, '').replace(/\.json\.gz$/, ''),
      pkg: JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString('utf8')),
      from: dir,
    }));
  }
  return [];
}

/* ── § 1. The grading maths, with no geometry at all ──────────────────────── */

console.log('── § 1  the two channels ──────────────────────────────────────');

check(gradeEscape(0, 0) === 'ignore', 'nothing escaped is not a problem');
check(gradeEscape(CONTAINMENT_TOLERANCE_M2 / 1e6, 1000) === 'ignore',
  `${CONTAINMENT_TOLERANCE_M2} m² is under the containment tolerance, whatever its shape`);
check(gradeEscape(0.5, 9.1) === 'residue',
  'the measured worst case — 0.949 km² at 9.1 m wide — is residue');
check(gradeEscape(RESIDUE_MAX_KM2 - 0.001, RESIDUE_WIDTH_M) === 'residue',
  `just inside both bars (${RESIDUE_MAX_KM2} km², ${RESIDUE_WIDTH_M} m) is residue`);
check(gradeEscape(RESIDUE_MAX_KM2 + 0.001, 1) === 'defect',
  'over the area bar is a defect however narrow — a ribbon that long is not residue');
check(gradeEscape(0.2, RESIDUE_WIDTH_M + 1) === 'defect',
  'over the width bar is a defect however small — 50 m of ground is ground');

/* ── § 2. The sentences ───────────────────────────────────────────────────── */

console.log('\n── § 2  the sentences (docs/contracts.md § 15) ────────────────');

const passSentence = recheckSentence({ grade: 'pass', problems: [] });
check(/agrees with itself/.test(passSentence), `pass: "${passSentence}"`);

const residueSentence = recheckSentence({ grade: 'residue', problems: [], residueKm2: 0.949 });
check(/agrees to within/.test(residueSentence) && /shared edges/.test(residueSentence),
  `residue: "${residueSentence}"`);
check(!/hand-edited|different version|problem/i.test(residueSentence),
  'and it never calls residue a problem, an edit, or another version');
check(/mi²/.test(residueSentence) && !/km/.test(residueSentence),
  'and it is in miles — everything a reader sees is');

const tiny = recheckSentence({ grade: 'residue', problems: [], residueKm2: 1e-9 });
check(/0\.01/.test(tiny),
  `an escape under the formatter's resolution floors rather than claiming zero: "${tiny}"`);

/* `checkIntegrity`'s shape (docs/contracts.md § 2) says `escapedKm2`; one
   sentence serves both or the two drift. */
const viaIntegrity = recheckSentence({ grade: 'residue', problems: [], escapedKm2: 0.949 });
check(viaIntegrity === residueSentence,
  'and `escapedKm2` from checkIntegrity produces the same sentence as `residueKm2`');

const defectSentence = recheckSentence({ grade: 'defect', problems: [1, 2], largestKm2: 106 });
check(/2 problems, largest/.test(defectSentence) && /mi²/.test(defectSentence),
  `defect: "${defectSentence}"`);
check(/1 problem,/.test(recheckSentence({ grade: 'defect', problems: [1], largestKm2: 5 })),
  'and one problem is singular');

/* ── § 3. The twelve bundled packages ─────────────────────────────────────── */

console.log('\n── § 3  the bundled corpus ────────────────────────────────────');

/** The two packages whose round trip drops nothing. Named, not counted. */
const EXPECT_PASS = new Set(['SD-9c26907b', 'MT-06e8fb67']);

const corpus = loadCorpus();
if (!corpus.length) {
  skip('no demo/ and no ../usdm-editor/examples/proposals — corpus checks not run');
} else {
  console.log(`  (${corpus.length} package(s) from ${corpus[0].from})`);
  const graded = [];
  for (const item of corpus) {
    const t0 = Date.now();
    const r = recheckPackage(item.pkg);
    graded.push({ ...item, r, ms: Date.now() - t0 });
  }

  for (const g of graded) {
    console.log(`  ·    ${g.key.padEnd(12)} ${g.grade ?? g.r.grade}`.padEnd(28) +
      `${g.r.problems.length} problem(s), ${g.r.residue.length} residue ` +
      `(${g.r.residueKm2.toFixed(4)} km² total, widest ${g.r.residueWidestM.toFixed(2)} m) ` +
      `${g.ms} ms`);
  }

  const defects = graded.filter((g) => g.r.grade === 'defect');
  check(defects.length === 0,
    'NOT ONE of the bundled packages grades `defect`' +
    (defects.length ? ` — ${defects.map((g) => `${g.key}: ${g.r.problems[0]?.message}`).join(' | ')}` : ''));

  const passed = graded.filter((g) => g.r.grade === 'pass').map((g) => g.key).sort();
  const wantPass = [...EXPECT_PASS].sort();
  check(passed.join(',') === wantPass.join(','),
    `exactly ${wantPass.join(' and ')} re-check clean (got ${passed.join(', ') || 'none'})`);

  const residual = graded.filter((g) => g.r.grade === 'residue');
  check(residual.length === graded.length - wantPass.length,
    `every other package grades \`residue\` (${residual.length} of ${graded.length})`);

  /* The whole point of the width channel: what is left is SLIVERS. If one of
     these ever measures metres wide, the grading is hiding something. */
  const widest = Math.max(0, ...graded.map((g) => g.r.residueWidestM));
  check(widest <= RESIDUE_WIDTH_M,
    `the widest residue anywhere in the corpus is ${widest.toFixed(2)} m ` +
    `(the bar is ${RESIDUE_WIDTH_M} m)`);

  const largest = Math.max(0, ...graded.flatMap((g) => g.r.residue.map((x) => x.areaKm2)));
  check(largest <= RESIDUE_MAX_KM2,
    `and the largest single escape is ${largest.toFixed(3)} km² (the bar is ${RESIDUE_MAX_KM2})`);

  /* Every residue verdict has to READ as agreement. This is the sentence eight
     of ten reference proposals put in front of a reviewer. */
  const misread = residual.filter((g) => !/agrees to within/.test(g.r.sentence));
  check(misread.length === 0,
    'and every residue verdict says the two blocks AGREE, to within a measured number');

  /* ── § 4. A band moved 500 m is a defect ───────────────────────────────── */

  console.log('\n── § 4  a corrupted band still fails ──────────────────────────');

  /* 500 m is the smallest move that is unambiguously GROUND rather than a
     clipper artefact: the residue this grading forgives is 9 m at its widest,
     and a whole band shifted half a kilometre leaves a half-kilometre-wide
     escape down its entire length. The corrupt case in the editor's verify
     § 7j is a 1° triangle — this is the subtler half of the same test. */
  const victim = graded.find((g) => g.r.grade !== 'defect' && g.pkg?.derivedBands);
  const moved = JSON.parse(JSON.stringify(victim.pkg));
  /* An EDITED class, deliberately: the mutual-containment loop only compares
     classes that `changes[]` names, so moving an unedited band would be caught
     by the band-overlap rule alone — a defect, but not the one under test, and
     it would carry no geometry for the card's "Show me". */
  const band = (moved.changes ?? [])
    .map((ch) => ch?.class)
    .find((c) => moved.derivedBands?.[c]?.coordinates?.length);
  moved.derivedBands[band] = globalThis.turf.transformTranslate(
    globalThis.turf.feature(moved.derivedBands[band]), 0.5, 90, { units: 'kilometers' },
  ).geometry;

  const corrupted = recheckPackage(moved);
  check(corrupted.grade === 'defect',
    `${victim.key} with its ${band} band translated 500 m grades \`defect\` ` +
    `(${corrupted.problems.length} problem(s), largest ${corrupted.largestKm2.toFixed(1)} km²)`);
  check(corrupted.ok === false, 'and `ok` is false');
  check(corrupted.largestKm2 > RESIDUE_MAX_KM2,
    'and the escape it reports is far over the residue bar, not a borderline call');
  check(corrupted.problems.some((p) => p.geometry),
    'and at least one problem carries GEOMETRY, so the card can offer "Show me"');
  check(/problems, largest/.test(corrupted.sentence),
    `and the verdict names the count and the size: "${corrupted.sentence}"`);
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
