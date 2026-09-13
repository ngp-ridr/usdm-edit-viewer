/* ══ The comparison engine, under Node ════════════════════════════════════════
   USDM Edit Viewer · tools/compare.test.mjs

   `js/proposal.js`, `js/session.js`, `js/compare.js`, `js/seams.js`,
   `js/brief.js` and `js/published.js` are the half of this app that decides
   WHAT IS TRUE. They are DOM-free on purpose, so they can be run here — over
   the twelve real example packages, with the same vendored turf the browser
   loads — instead of only through a browser suite that costs minutes and
   cannot assert an area.

   ── THE FIXTURES ARE REAL, AND ONE OF THEM IS NOT ─────────────────────────
   The twelve `demo/*.json.gz` are the corpus this engine was tuned against:
   real archive geometry, real clipper residue, real unsimplified FSA state
   boundaries, and two proposals written specifically to disagree with two
   others. Every number asserted below was MEASURED on them, and the tolerance
   beside it is the one the measurement earns — a test that pins a number it
   invented is a test that fails when the code gets better.

   The synthetic pair (§ 5, tools/synthetic.mjs) is the one fixture whose
   answer is known on paper, and it is there because on the real corpus there
   is no right answer written down anywhere: only what the code says, which is
   what this file is supposed to be checking.

   Run: `node tools/compare.test.mjs`. No install, no network — turf and
   topojson come from the vendored UMD builds the app itself ships, loaded the
   way the editor's tools/topology.test.mjs loads them.
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── turf, first: every module below reads it through `T()` at call time, and
      `js/topology.js` throws a named error if it is not there. The vendored
      UMD build, not an npm copy, so this exercises the bytes production
      does. ─────────────────────────────────────────────────────────────────── */
const turfSrc = readFileSync(join(ROOT, 'vendor/usdm-editor/vendor/turf-7.4.0/turf.min.js'), 'utf8');
const turfModule = { exports: {} };
new Function('module', 'exports', turfSrc)(turfModule, turfModule.exports);
globalThis.turf = turfModule.exports;
const turf = globalThis.turf;

const { parseProposal, ProposalError, classAt, publishedClassAt, ord, LEVELS,
  proposalKey, worstDeltaFor, pointInParts } = await import(join(ROOT, 'js/proposal.js'));
const { createSession, SessionError, resolveFindingIds, rankFindings } =
  await import(join(ROOT, 'js/session.js'));
const { compareProposals, compareGroup, rankRegions } = await import(join(ROOT, 'js/compare.js'));
const { findSeams, sharedLine, SEAM_SPACING_KM, SEAM_OFFSET_KM } =
  await import(join(ROOT, 'js/seams.js'));
const { buildRegionBrief, buildSeamBrief, buildSessionBrief } = await import(join(ROOT, 'js/brief.js'));
const { createPublishedProvider } = await import(join(ROOT, 'js/published.js'));
const { areaKm2, asMulti, asFeature, deriveBands, deriveContours } =
  await import(join(ROOT, 'vendor/usdm-editor/js/topology.js'));
const { syntheticPair } = await import(join(ROOT, 'tools/synthetic.mjs'));

/* ── the harness ──────────────────────────────────────────────────────────── */

let failures = 0, checks = 0, skipped = 0;
const ok = (m) => { checks++; console.log(`    ok   ${m}`); };
const bad = (m) => { checks++; failures++; console.log(`    FAIL ${m}`); };
const skip = (m) => { skipped++; console.log(`    skip ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
const section = (n, title) => console.log(`\n── § ${n} ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const within = (a, lo, hi) => a >= lo && a <= hi;
const ms = (t0) => Math.round(performance.now() - t0);

/* ── the corpus ───────────────────────────────────────────────────────────── */

const DEMO = join(ROOT, 'demo');
const EDITOR = join(ROOT, '..', 'usdm-editor', 'examples', 'proposals');
const FIXTURE_DIR = [DEMO, EDITOR].find((d) =>
  existsSync(d) && readdirSync(d).some((n) => n.endsWith('.json.gz')));

if (!FIXTURE_DIR) {
  console.log('\n✗ no fixtures: neither demo/ nor ../usdm-editor/examples/proposals holds a .json.gz');
  process.exit(1);
}

/** `usdm-proposal-2026-09-08-state-MT-06e8fb67.json.gz` → `MT-06e8fb67`. */
const keyOf = (name) => name.replace(/^usdm-proposal-[\d-]+-state-/, '').replace(/\.json\.gz$/, '');

const FIXTURES = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json.gz')).sort()
  .map((name) => ({
    name, key: keyOf(name),
    pkg: JSON.parse(gunzipSync(readFileSync(join(FIXTURE_DIR, name))).toString('utf8')),
  }));

/** The ten proposals that shipped before the two dissents were written. The
 *  plan's zero-conflict measurement is a claim about THESE, and adding the
 *  dissents to it would make the claim false on purpose. */
const DISSENTS = new Set(['MT-4ab1b4a8', 'NE-85cf87ba']);
const ORIGINALS = FIXTURES.filter((f) => !DISSENTS.has(f.key));

/** The five original pairs, one per state. */
const ORIGINAL_PAIRS = [
  ['MT-06e8fb67', 'MT-853adab3'], ['ND-2c885add', 'ND-8e4e4468'],
  ['NE-3f4c9136', 'NE-9d215f60'], ['SD-9c26907b', 'SD-f3f094e2'],
  ['WY-53bc5877', 'WY-ccbbfe2f'],
];

const NEIGHBORS = existsSync(join(ROOT, 'vendor/aoi/neighbors.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'vendor/aoi/neighbors.json'), 'utf8')) : null;

console.log(`USDM Edit Viewer · the comparison engine`);
console.log(`   fixtures: ${FIXTURES.length} packages from ${FIXTURE_DIR.replace(ROOT, '.')}`);

/* ══ § 0 · purity ═══════════════════════════════════════════════════════════ */

section(0, 'the engine is DOM-free');

/* docs/contracts.md § 16 decision 4: seven modules, and js/published.js is the
   ONE exception — allowed `fetch` and nothing else. The editor's § 14h pattern:
   grep the SOURCE TEXT, because an import that only runs in a browser still
   makes a module un-runnable here, and a test that imports it successfully
   proves nothing about the branch it never took.

   THE PATTERNS MATCH CODE, NOT PROSE. Comments are stripped first, and the two
   globals have to be USED — `window.` / `window[` / `typeof window` — rather
   than merely spelled: js/brief.js asks a reviewer "over what window?", which a
   bare `\bwindow\b` calls a DOM reference and a reader calls a good question. */
const DOM_PATTERNS = [
  ['window', /\bwindow\s*[.[]|\btypeof\s+window\b/],
  ['document', /\bdocument\s*[.[]|\btypeof\s+document\b/],
  ['fetch(', /\bfetch\s*\(/],
  ['dom.js', /from\s+['"][^'"]*dom\.js['"]/],
];
const ENGINE = ['proposal.js', 'session.js', 'compare.js', 'seams.js', 'brief.js',
  'marks.js', 'recheck.js'];
for (const file of ENGINE) {
  const path = join(ROOT, 'js', file);
  if (!existsSync(path)) { skip(`js/${file} is not written yet`); continue; }
  const code = stripComments(readFileSync(path, 'utf8'));
  const hits = DOM_PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => name);
  check(!hits.length, `js/${file} names no DOM and no network${hits.length ? ` — found ${hits.join(', ')}` : ''}`);
}
{
  const code = stripComments(readFileSync(join(ROOT, 'js/published.js'), 'utf8'));
  const hits = DOM_PATTERNS.filter(([name, re]) => name !== 'fetch(' && re.test(code)).map(([n]) => n);
  check(!hits.length,
    `js/published.js names no DOM either — its exception is \`fetch\` alone` +
    `${hits.length ? ` (found ${hits.join(', ')})` : ''}`);
}
{
  /* Import direction, one way: the brief may not reach turf or the DOM through
     anything, which is what keeps it a pure projection of numbers somebody
     else measured (docs/contracts.md § 7). */
  const code = stripComments(readFileSync(join(ROOT, 'js/brief.js'), 'utf8'));
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const allowed = imports.every((i) => /color\.js$|units\.js$|changes\.js$/.test(i));
  check(allowed, `js/brief.js imports only color, units and changes — found ${imports.join(', ')}`);
  check(!/\bT\s*\(\s*\)/.test(code) && !/globalThis\.turf/.test(code),
    'js/brief.js never calls turf');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ══ § 1 · parse ════════════════════════════════════════════════════════════ */

section(1, 'every fixture parses');

const parsed = new Map();
{
  const t0 = performance.now();
  let allWeek = true, allAoi = true;
  for (const f of FIXTURES) {
    try {
      const p = parseProposal(f.pkg, { fileName: f.name });
      parsed.set(f.key, p);
      if (p.week !== '2026-09-08') allWeek = false;
      if (!p.aoi.geometry || !p.aoi.id) allAoi = false;
    } catch (err) {
      bad(`${f.key} did not parse: ${err.message}`);
    }
  }
  check(parsed.size === FIXTURES.length, `all ${FIXTURES.length} packages parse (${ms(t0)} ms)`);
  check(allWeek, 'every fixture is the week of 2026-09-08');
  check(allAoi, 'every fixture carries a working area with an id and rings');
}
{
  const mt = parsed.get('MT-06e8fb67');
  check(mt.shortId === '06e8fb67', `shortId is eight hex of the package id (${mt.shortId})`);
  check(proposalKey(mt) === `state:MT@2026-09-08#06e8fb67`, `proposalKey is ${proposalKey(mt)}`);
  check(mt.source === null, 'a picked file has no source url — never baseline.source');
  check(mt.patches.length === 3 && mt.patches[0].key === mt.patches[0].id,
    'patches carry key === id');
}
{
  /* `classAt` distinguishes "inside, no drought" from "outside the working
     area", and callers must not collapse the two. */
  const mt = parsed.get('MT-06e8fb67');
  check(classAt(mt, [-90, 40]) === null, 'classAt is null OUTSIDE the working area');
  const inside = classAt(mt, [-108, 47]);
  check(LEVELS.includes(inside), `classAt inside Montana answers a level (${inside})`);
  /* CLEAR GROUND, found by sweeping the working area rather than by asking a
     centroid: a USDM region is wildly concave and `pointOnFeature` happily
     returns a point ON a ring, which hit-tests as the band next door
     (CLAUDE.md). The sweep finds one honestly; the partition then has to agree
     about it, which is the real check — `classAt` walks the bands with
     point-in-polygon and the `none` level is a boolean difference, so the two
     are independent computations of the same fact. */
  const nd = parsed.get('ND-8e4e4468');
  const [w, s, e, n] = nd.aoi.envelope;
  let clearPoint = null;
  for (let i = 1; i < 20 && !clearPoint; i++) {
    for (let j = 1; j < 20 && !clearPoint; j++) {
      const pt = [w + (e - w) * (i / 20), s + (n - s) * (j / 20)];
      if (classAt(nd, pt) === 'none') clearPoint = pt;
    }
  }
  check(!!clearPoint,
    `classAt answers 'none' on clear ground inside the working area ` +
    `(${clearPoint?.map((x) => x.toFixed(2)).join(', ') ?? 'none found'})`);
  check(!!clearPoint && !!nd.partition[0] && pointInParts(nd.partition[0].parts, clearPoint),
    "and the partition's `none` level agrees that point is clear");
  check(publishedClassAt(nd, [-90, 40]) === null, 'publishedClassAt is null outside too');
}
{
  check(ord('none') === -1 && ord('D0') === 0 && ord('D4') === 4,
    'the ordinal scale is delta.js\'s: none = −1 … D4 = 4');
}

/* ══ § 2 · the published week, from a package alone ═════════════════════════ */

section(2, 'two proposals reconstruct the same published week');

{
  const t0 = performance.now();
  let worst = 0, worstAt = '';
  const byAoi = groupByAoi([...parsed.values()]);
  for (const [aoiId, list] of byAoi) {
    for (let i = 1; i < list.length; i++) {
      for (const c of ['D0', 'D1', 'D2', 'D3', 'D4']) {
        const d = Math.abs(areaKm2(list[0].published.bands[c]) - areaKm2(list[i].published.bands[c]));
        if (d > worst) { worst = d; worstAt = `${aoiId} ${c}`; }
      }
    }
  }
  check(worst < 0.001,
    `every pair's reconstruction agrees per class to ${worst.toFixed(4)} km² ` +
    `(worst ${worstAt}; the bar is 0.001) — ${ms(t0)} ms for all twelve`);
}
{
  /* The reconstruction is only sound because `changes[]` names every class a
     verb touched. A class ABSENT from it must come back identical to the
     proposal's own contour, which is what makes the substitution legal. */
  const p = parsed.get('WY-ccbbfe2f');
  const named = new Set(p.changes.map((c) => c.class));
  const untouched = ['D0', 'D1', 'D2', 'D3', 'D4'].filter((c) => !named.has(c));
  const same = untouched.every((c) => near(areaKm2(p.published.contours[c]), areaKm2(p.contours[c]), 1e-9));
  check(untouched.length > 0 && same,
    `a class absent from changes[] reconstructs to the proposal's own contour ` +
    `(${untouched.join(', ')})`);
}

/* ══ § 3 · integrity, graded by magnitude ══════════════════════════════════ */

section(3, 'the re-check grades residue apart from a defect');

{
  const t0 = performance.now();
  const grades = new Map();
  for (const [key, p] of parsed) grades.set(key, p.integrity);
  const passes = [...grades].filter(([, g]) => g.grade === 'pass').map(([k]) => k).sort();
  const defects = [...grades].filter(([, g]) => g.grade === 'defect').map(([k]) => k).sort();
  const residues = [...grades].filter(([, g]) => g.grade === 'residue').map(([k]) => k);
  check(passes.join(',') === 'MT-06e8fb67,SD-9c26907b',
    `exactly MT-06e8fb67 and SD-9c26907b re-check clean (got ${passes.join(',') || 'none'})`);
  check(defects.length === 0, `no fixture grades 'defect' (got ${defects.join(',') || 'none'})`);
  const originalResidue = residues.filter((k) => !DISSENTS.has(k));
  check(originalResidue.length === 8,
    `eight of the ten ORIGINAL packages are residue (got ${originalResidue.length})`);
  check(residues.length === 10, `ten of the twelve are residue (got ${residues.length})`);

  let worstKm2 = 0, worstWidth = 0, worstKey = '';
  for (const [key, g] of grades) {
    for (const r of g.residue ?? []) {
      if (r.areaKm2 > worstKm2) { worstKm2 = r.areaKm2; worstKey = key; }
      worstWidth = Math.max(worstWidth, r.widthM);
    }
  }
  check(worstKm2 <= 1 && worstWidth <= 50,
    `the worst residue is ${worstKm2.toFixed(4)} km² at ${worstWidth.toFixed(1)} m wide ` +
    `(${worstKey}) — inside both bars`);
  check(near(worstKm2, 0.984, 0.01), `the worst escape is the measured 0.984 km²`);
  console.log(`         (integrity over twelve packages: ${ms(t0)} ms)`);
}
{
  /* A REAL defect, for contrast: shift one band half a kilometre. The escape is
     then a 500 m ribbon the whole length of the class — kilometres of it, far
     wider than any clipper residue — and the grade has to say so. */
  const src = FIXTURES.find((f) => f.key === 'WY-53bc5877');
  const broken = JSON.parse(JSON.stringify(src.pkg));
  const band = asMulti(broken.derivedBands.D3);
  const moved = turf.transformTranslate(asFeature(band), 0.5, 90, { units: 'kilometers' });
  broken.derivedBands.D3 = moved.geometry;
  const p = parseProposal(broken, { fileName: 'broken.json' });
  check(p.integrity.grade === 'defect',
    `a band translated 500 m grades 'defect' (${p.integrity.problems.length} problems, ` +
    `largest ${p.integrity.largestKm2.toFixed(1)} km²)`);
  check(p.integrity.largestKm2 > 1, 'and its largest escape is well over the residue bar');
}

/* ══ § 4 · the five original pairs ══════════════════════════════════════════ */

section(4, 'the five original pairs — all one-sided');

const comparisonsByPair = new Map();
{
  let totalMs = 0;
  for (const [a, b] of ORIGINAL_PAIRS) {
    const A = parsed.get(a), B = parsed.get(b);
    const c = compareProposals(A, B);
    comparisonsByPair.set(`${a}×${b}`, c);
    totalMs += c.ms;
    const conflicts = c.regions.filter((r) => r.kind === 'conflict');
    check(conflicts.length === 0,
      `${a} × ${b}: no conflict (${c.regions.length} regions, ${c.ms} ms)`);
  }
  console.log(`         (five pairs: ${totalMs} ms)`);
}
{
  /* THE ACCOUNTING IDENTITY. Every square kilometre a proposal changed inside
     its working area lands in exactly one bucket of a pairwise comparison:
     ground the other side also changed (a conflict) or ground it did not (a
     one-sided region attributed to this side). So for each side,
     conflictKm2 + oneSidedKm2[side] must be that side's own changed area —
     which is the sum of its patches, a number the editor measured
     independently and wrote into the file. */
  let worstPct = 0, worstAt = '';
  for (const [label, c] of comparisonsByPair) {
    for (const [side, p] of [['A', c.A], ['B', c.B]]) {
      const claimed = c.totals.conflictKm2 + c.totals.oneSidedKm2[side];
      const own = p.patches.reduce((a, x) => a + x.areaKm2, 0);
      const pct = Math.abs(claimed - own) / own * 100;
      if (pct > worstPct) { worstPct = pct; worstAt = `${label} side ${side}`; }
    }
  }
  check(worstPct < 2,
    `conflict + one-sided accounts for each side's own changed area to ` +
    `${worstPct.toFixed(3)}% (worst ${worstAt}; the bar is 2%)`);
}
{
  const c = comparisonsByPair.get('SD-9c26907b×SD-f3f094e2');
  const sizes = [...c.regions].sort((x, y) => y.areaKm2 - x.areaKm2).slice(0, 2)
    .map((r) => r.areaKm2);
  check(near(sizes[0], 5685, 60) && near(sizes[1], 5338, 60),
    `South Dakota's two largest regions are ${sizes.map((n) => n.toFixed(0)).join(' and ')} km² ` +
    `(measured 5685 and 5338)`);
  check(c.totals.publishedMismatchKm2 < 1,
    `and the two baselines disagree over ${c.totals.publishedMismatchKm2.toFixed(3)} km² — ` +
    `residue, not a finding`);
}
{
  /* Ids are the whole point of `?focus=`: they must not depend on the order the
     files were dropped in, and they must not depend on the run. */
  const A = parsed.get('SD-9c26907b'), B = parsed.get('SD-f3f094e2');
  const one = compareProposals(A, B).regions.map((r) => r.id).sort().join(',');
  const two = compareProposals(A, B).regions.map((r) => r.id).sort().join(',');
  const flipped = compareProposals(B, A).regions.map((r) => r.id).sort().join(',');
  check(one === two, 'region ids are stable across runs');
  check(one === flipped, 'region ids are stable across argument order');
  const sample = compareProposals(A, B).regions[0];
  check(/^disc:[0-9a-f]{8}$/.test(sample.id), `a region id looks like ${sample.id}`);
  check(sample.key.startsWith('disc|') && sample.key.includes('state:SD'),
    `and carries its readable key: ${sample.key}`);
}

/* ══ § 5 · the synthetic pair ══════════════════════════════════════════════ */

section(5, 'the synthetic pair — an answer known on paper');

{
  const S = syntheticPair();
  const A = parseProposal(S.A), B = parseProposal(S.B);
  check(A.integrity.grade === 'pass' && B.integrity.grade === 'pass',
    'both synthetic packages re-check clean');
  const c = compareProposals(A, B);
  const conflicts = c.regions.filter((r) => r.kind === 'conflict');
  const oneSided = c.regions.filter((r) => r.kind === 'one-sided');
  check(conflicts.length === 1, `exactly one conflict (got ${conflicts.length})`);
  check(oneSided.length === 1, `exactly one one-sided region (got ${oneSided.length})`);
  const k = conflicts[0];
  check(k.classA === 'D2' && k.classB === 'D0' && k.published === 'D1',
    `the conflict is D2 against D0 over published D1`);
  check(k.magnitude === 2, `magnitude 2 (got ${k.magnitude})`);
  check(k.changedBy === 'both' && k.directionA === 'grew' && k.directionB === 'shrank',
    'both sides moved it, in opposite directions');
  const halfPct = Math.abs(k.areaKm2 - S.squareKm2 / 2) / (S.squareKm2 / 2) * 100;
  check(halfPct < 1,
    `it covers half the square to ${halfPct.toFixed(4)}% (${k.areaKm2.toFixed(1)} of ` +
    `${S.squareKm2.toFixed(1)} km²)`);
  check(c.regions[0].kind === 'conflict', 'and it is ranked first');
  check(near(oneSided[0].areaKm2, S.blockKm2, 1),
    `the one-sided region is the east block (${oneSided[0].areaKm2.toFixed(1)} km²)`);
  check(oneSided[0].changedBy === 'A' && oneSided[0].patchesA.length === 1
    && oneSided[0].patchesB.length === 0,
    'attributed to A\'s second change, and to no change of B\'s');
  check(near(c.totals.publishedMismatchKm2, 0, 1e-6),
    'nothing is left over: the two baselines agree exactly');
}

/* ══ § 5b · the two dissenting proposals ═══════════════════════════════════ */

section('5b', 'the dissents disagree, and in the ways they were written to');

{
  /* MT-4ab1b4a8 (Ostrander) improves the Milk River Hi-Line block that
     MT-06e8fb67 (Reyes) degraded. Two readings of one week, opposite ways,
     over the same 5,665 km². */
  const A = parsed.get('MT-06e8fb67'), B = parsed.get('MT-4ab1b4a8');
  const c = compareProposals(A, B);
  const conflicts = c.regions.filter((r) => r.kind === 'conflict');
  check(conflicts.length >= 1, `MT-4ab1b4a8 × MT-06e8fb67: ${conflicts.length} conflict(s)`);
  const hiLine = conflicts.find((r) => r.areaKm2 > 5000);
  check(!!hiLine, 'one of them is the Hi-Line block');
  if (hiLine) {
    check(near(hiLine.areaKm2, 5665, 60),
      `over ${hiLine.areaKm2.toFixed(0)} km² (the block Reyes degraded is 5,665)`);
    check(hiLine.directionA !== hiLine.directionB
      && hiLine.directionA !== 'unchanged' && hiLine.directionB !== 'unchanged',
      `in OPPOSITE directions: ${hiLine.directionA} against ${hiLine.directionB}`);
    check(within(hiLine.anchor[1], 48, 49.1) && within(hiLine.anchor[0], -108, -106),
      `and it sits on the Hi-Line: ${hiLine.anchor.map((n) => n.toFixed(2)).join(', ')}`);
    check(hiLine.published === 'D0' && hiLine.magnitude === 2,
      `published D0, and the two answers are ${hiLine.magnitude} classes apart`);
  }
}
{
  /* NE-85cf87ba (Steffensmeier) degrades the central Platte strip NE-9d215f60
     (Whitcomb) improved — and the ground under it is three classes deep, so
     the conflict comes back as several class pairs rather than one. */
  const A = parsed.get('NE-85cf87ba'), B = parsed.get('NE-9d215f60');
  const c = compareProposals(A, B);
  const conflicts = c.regions.filter((r) => r.kind === 'conflict');
  check(conflicts.length >= 2, `NE-85cf87ba × NE-9d215f60: ${conflicts.length} conflicts`);
  const pairs = new Set(conflicts.map((r) => `${r.classA}/${r.classB}`));
  check(pairs.size >= 2,
    `over ${pairs.size} distinct class pairs: ${[...pairs].sort().join(', ')}`);
  const total = conflicts.reduce((a, r) => a + r.areaKm2, 0);
  check(near(total, 5592, 60),
    `totalling ${total.toFixed(0)} km² (the strip Whitcomb improved is 5,592)`);
  check(conflicts.every((r) => r.directionA === 'grew' && r.directionB === 'shrank'),
    'every piece has the two sides pulling opposite ways');
}

/* ══ § 6 · seams, both sides loaded ════════════════════════════════════════ */

section(6, 'seams along a shared border');

const session = createSession();
for (const f of FIXTURES) session.add(f.pkg, { fileName: f.name });
let SEAMS = [];
{
  const t0 = performance.now();
  SEAMS = await findSeams(session, { neighbors: NEIGHBORS });
  console.log(`         (${SEAMS.length} seams in ${ms(t0)} ms)`);
  check(SEAMS.length > 0, `the demo set produces ${SEAMS.length} seams`);
  check(SEAMS.every((s) => /^seam:[0-9a-f]{8}$/.test(s.id)), 'every seam id is eight hex');
  check(SEAMS.every((s) => s.geometry?.type === 'MultiLineString'),
    'every seam carries the line it was analysed over');
  check(SEAMS.every((s) => s.runs.every((r) => !r.geometry || r.geometry.type === 'LineString')),
    'and every run carries its own stretch of it');
}

const seamFor = (a, b) => SEAMS.find((s) => {
  const ids = [s.sideA.proposal?.shortId, s.sideB.proposal?.shortId];
  return ids.includes(a) && ids.includes(b);
});

{
  /* THE ONE RECIPROCAL SEAM in the original set: South Dakota and Nebraska
     both degraded up to their shared line, agreeing on the western half and
     differing by a class on the eastern. */
  const s = seamFor('9c26907b', '3f4c9136');
  if (!s) { bad('no SD-9c26907b × NE-3f4c9136 seam'); }
  else {
    check(within(s.lengthKm, 660, 700),
      `the SD/NE line is ${s.lengthKm.toFixed(1)} km (measured 681.5)`);
    check(s.indeterminate <= 2,
      `${s.indeterminate} indeterminate sample of ${s.samples} at a ${SEAM_OFFSET_KM} km offset`);
    check(s.reciprocal, 'both sides carry a proposal');
    const bySide = { A: 0, B: 0 };
    for (const r of s.runs) {
      if (['new', 'widened'].includes(r.kind) && (r.changedBy === 'A' || r.changedBy === 'B')) {
        bySide[r.changedBy] += r.lengthKm;
      }
    }
    check(within(bySide.A, 100, 106) && within(bySide.B, 100, 106),
      `new and widened runs total ${bySide.A.toFixed(0)} km on one side and ` +
      `${bySide.B.toFixed(0)} km on the other (measured 102 each)`);
    const twoClass = s.runs.filter((r) => Math.abs(r.step ?? 0) === 2 && r.kind !== 'pre-existing')
      .reduce((a, r) => a + r.lengthKm, 0);
    check(twoClass > 0 && twoClass <= 6,
      `a two-class step runs for ${twoClass.toFixed(1)} km (the bar is 6)`);
    const agreed = s.runs.filter((r) => r.kind === 'agree' && r.changedBy === 'both')
      .reduce((a, r) => a + r.lengthKm, 0);
    check(within(agreed, 14, 18),
      `and both sides changed and still line up over ${agreed.toFixed(1)} km`);
  }
}
{
  /* WY-53bc5877 pushed D3 up to the Montana line; the two ORIGINAL Montana
     proposals left that border alone. Its two edge effects toward Montana are
     11.5 and 73.7 km, and the seam has to find both. */
  const s = seamFor('06e8fb67', '53bc5877');
  if (!s) { bad('no MT-06e8fb67 × WY-53bc5877 seam'); }
  else {
    const oneSided = s.runs.filter((r) => ['new', 'widened'].includes(r.kind));
    const km = oneSided.reduce((a, r) => a + r.lengthKm, 0);
    check(within(km, 80, 92),
      `Wyoming steps up to the Montana line over ${km.toFixed(0)} km ` +
      `(its two edge effects are 11.5 + 73.7 = 85.2)`);
    check(oneSided.every((r) => r.changedBy === 'B'),
      'and Montana changed nothing along it — every run is one-sided');
    const pairs = new Set(oneSided.map((r) => `${r.classA}/${r.classB}`));
    check(pairs.has('D2/D3') && pairs.has('D1/D2'),
      `the steps are ${[...pairs].sort().join(' and ')}`);
  }
}
{
  /* ND-8e4e4468's D0 stops at the Montana meridian: 29 km of edge effect. */
  const s = seamFor('06e8fb67', '8e4e4468');
  if (!s) { bad('no MT × ND-8e4e4468 seam'); }
  else {
    const km = s.runs.filter((r) => ['new', 'widened'].includes(r.kind))
      .reduce((a, r) => a + r.lengthKm, 0);
    check(within(km, 26, 32), `North Dakota's D0 stops at the meridian over ${km.toFixed(0)} km`);
  }
}
{
  /* § 5b's third claim: the Montana dissent runs its improvement down to the
     45°N line, where Wyoming degraded up to it. Opposite directions across a
     state line, two classes apart. */
  const s = seamFor('4ab1b4a8', '53bc5877');
  if (!s) { bad('no MT-4ab1b4a8 × WY-53bc5877 seam'); }
  else {
    check(s.reciprocal, 'MT-4ab1b4a8 × WY-53bc5877 is reciprocal');
    const two = s.runs.filter((r) => Math.abs(r.step ?? 0) === 2 && r.kind === 'new');
    check(two.length > 0,
      `with ${two.length} new run(s) two classes apart, ` +
      `${two.reduce((a, r) => a + r.lengthKm, 0).toFixed(0)} km in all`);
    const both = two.filter((r) => r.changedBy === 'both');
    check(both.length > 0, 'and both sides moved the ground they abut');
    const opposed = both.every((r) =>
      ord(r.classA) < ord(r.publishedA) && ord(r.classB) > ord(r.publishedB));
    check(opposed,
      'in opposite directions — Montana improved its side while Wyoming degraded theirs');
  }
}
{
  /* `sharedLine` is symmetric: the same border measured from either ring. */
  const mt = parsed.get('MT-06e8fb67').aoi, wy = parsed.get('WY-53bc5877').aoi;
  const a = sharedLine(mt, wy), b = sharedLine(wy, mt);
  const la = turf.length({ type: 'Feature', properties: {}, geometry: a }, { units: 'kilometers' });
  const lb = turf.length({ type: 'Feature', properties: {}, geometry: b }, { units: 'kilometers' });
  check(near(la, lb, 0.5), `sharedLine is symmetric: ${la.toFixed(1)} km either way round`);
  const ne = parsed.get('NE-3f4c9136').aoi;
  check(sharedLine(mt, ne) === null, 'and answers null for two AOIs that do not touch');
}

/* ══ § 7 · a neighbour nobody loaded ═══════════════════════════════════════ */

section(7, 'the far side, when there is no proposal for it');

{
  const unloaded = SEAMS.filter((s) => s.sideB.kind !== 'proposal');
  check(unloaded.length > 0, `${unloaded.length} seams face a jurisdiction nobody loaded`);
  const mn = SEAMS.find((s) => s.neighbourId === 'state:MN');
  check(!!mn && mn.sideB.kind === 'unknown',
    'ND-2c885add → Minnesota comes back with the far side unknown (no provider)');
  check(!!mn && mn.runs.length > 0 && mn.runs.every((r) => r.kind === 'unknown'),
    'and its runs carry what North Dakota says, with nulls on the far side');
  const pineRidge = SEAMS.find((s) => s.neighbourId === 'aiannh:01263144-86');
  check(!!pineRidge, 'Pine Ridge is named as an unloaded neighbour');
  check(!!pineRidge && pineRidge.sideB.aoi.name && pineRidge.sideB.aoi.name !== pineRidge.neighbourId,
    `and named in words: "${pineRidge?.sideB.aoi.name}"`);
  check(SEAMS.every((s) => s.reciprocal === (s.sideA.kind === 'proposal' && s.sideB.kind === 'proposal')),
    'reciprocal means both sides carry a proposal, and nothing else');
}
{
  /* A REJECTING provider must not lose the seam: the side goes unknown and the
     line, its length and one author's classes still reach the reviewer. */
  const rejecting = createPublishedProvider({
    fetchWeek: () => Promise.reject(new Error('no network')),
  });
  const s2 = await findSeams(session, { neighbors: NEIGHBORS, provider: rejecting });
  const mn = s2.find((s) => s.neighbourId === 'state:MN');
  check(!!mn && mn.sideB.kind === 'unknown', 'a rejecting provider leaves the far side unknown');
  check(s2.length === SEAMS.length, 'and costs not one seam');
  check(rejecting.status().weeks.length === 0,
    'the rejection is EVICTED from the cache, so a retry is a real retry');
}
{
  /* The provider's own arithmetic, with a synthetic week rather than the
     network: clip to the corridor, then derive. Same code path the browser
     takes with js/archive.js's fetchWeek. */
  let calls = 0;
  const provider = createPublishedProvider({
    fetchWeek: async (week) => {
      calls++;
      return {
        week,
        /* D1 sits INSIDE the corridor asked for below, so the D0 band it
           leaves behind is not empty — a fixture where the inner contour
           covers the whole corridor would test `deriveBands` returning null
           and call it a pass. */
        contours: {
          D0: rectGeom(-101, 44, -99, 46), D1: rectGeom(-100.1, 44.9, -99.9, 45.1),
          D2: null, D3: null, D4: null,
        },
      };
    },
  });
  const bands = await provider.bandsNear('2026-09-08', [-100.2, 44.8, -99.8, 45.2]);
  await provider.bandsNear('2026-09-08', [-100.2, 44.8, -99.8, 45.2]);
  check(calls === 1, 'the provider fetches a week once and caches the corridor');
  check(!!bands.D1 && !!bands.D0, 'and derives bands over the clipped contours');
  check(areaKm2(bands.D0) < areaKm2(rectGeom(-101, 44, -99, 46)),
    'clipped to the corridor, not the nation');
  check(provider.status().weeks.length === 1, 'status() names the week it holds');
}
{
  const cached = join(ROOT, 'tools/.cache/parquet_unclipped/USDM_2026-09-08.parquet');
  if (!existsSync(cached)) {
    skip(`no ${cached.replace(ROOT, '.')} — the real-archive far side is not exercised`);
  } else {
    const { compressors } = await import(join(ROOT, 'vendor/usdm-editor/js/archive.js'));
    const { parquetReadObjects } = await import(join(ROOT, 'vendor/usdm-editor/vendor/hyparquet-1.28.2/hyparquet.esm.js'));
    const { healContours } = await import(join(ROOT, 'vendor/usdm-editor/js/topology.js'));
    const provider = createPublishedProvider({
      fetchWeek: async () => {
        const buf = readFileSync(cached);
        const rows = await parquetReadObjects({
          file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          compressors, columns: ['date', 'usdm_class', 'geometry'],
        });
        const raw = { D0: null, D1: null, D2: null, D3: null, D4: null };
        for (const r of rows) if (r.usdm_class in raw) raw[r.usdm_class] = r.geometry;
        return { contours: healContours(raw) };
      },
    });
    const s3 = await findSeams(session, { neighbors: NEIGHBORS, provider });
    const mn = s3.find((s) => s.neighbourId === 'state:MN');
    check(!!mn && mn.sideB.kind === 'published',
      'with the cached archive the far side is the published week');
    check(!!mn && mn.runs.some((r) => r.kind !== 'unknown'),
      'and its runs carry a real step');
  }
}

/* ══ § 8 · the briefs ══════════════════════════════════════════════════════ */

section(8, 'briefs a reviewer can argue from');

const VIEWER = 'https://ngp-ridr.github.io/usdm-edit-viewer/';
{
  const A = parsed.get('MT-06e8fb67'), B = parsed.get('MT-4ab1b4a8');
  const c = compareProposals(A, B);
  const region = c.regions.find((r) => r.kind === 'conflict');
  const md = buildRegionBrief(region, c, { viewerUrl: VIEWER });
  check(md === buildRegionBrief(region, c, { viewerUrl: VIEWER }), 'a region brief is deterministic');
  check(md.includes(A.author.name) && md.includes(B.author.name), 'it names both authors');
  check(md.includes(A.author.email) && md.includes(B.author.email), 'with both emails');
  check(md.includes(A.author.affiliation) && md.includes(B.author.affiliation),
    'and both affiliations');
  check(md.includes(A.author.onBehalfOf), `and "on behalf of ${A.author.onBehalfOf}"`);
  const touching = [...A.patches.filter((p) => region.patchesA.includes(p.key)),
    ...B.patches.filter((p) => region.patchesB.includes(p.key))];
  check(touching.length > 0 && touching.every((p) => !p.rationale || md.includes(p.rationale.trim())),
    `every touching rationale appears IN FULL (${touching.length} of them)`);
  const urls = [...A.justification.evidence, ...B.justification.evidence]
    .map((e) => e.url).filter(Boolean);
  check(urls.length > 0 && urls.every((u) => md.includes(u)),
    `every evidence url appears (${urls.length} of them)`);
  check(md.includes(`?focus=${encodeURIComponent(region.id)}`), 'and the link back carries ?focus=');
  check(!md.includes('km²') && md.includes('mi²'), 'MILES, never km² — not once');
  const questions = md.split('## Questions for discussion')[1]?.split('\n')
    .filter((l) => l.startsWith('- ')) ?? [];
  check(questions.length >= 3 && questions.length <= 5,
    `${questions.length} questions, chosen by case`);
  check(md.includes('OPPOSITE directions'),
    'and the opposite-directions case is the one it chose');
  check(md.includes(A.baselineSha256), 'it closes on the baseline checksum');
}
{
  const s = seamFor('9c26907b', '3f4c9136');
  const md = buildSeamBrief(s, { viewerUrl: VIEWER });
  check(md === buildSeamBrief(s, { viewerUrl: VIEWER }), 'a seam brief is deterministic');
  check(md.includes('South Dakota') && md.includes('Nebraska'), 'it names both jurisdictions');
  check(md.includes('| Stretch |'), 'it carries a run table');
  check(!md.includes('km²') && !/\d\s?km\b/.test(md), 'in miles, with no km anywhere');
  check(md.includes(`?focus=${encodeURIComponent(s.id)}`), 'and links back');
  const notes = s.borderNotes.A ?? s.borderNotes.B;
  check(!notes || md.includes(notes.trim().slice(0, 60)), 'a border note is printed when there is one');
}
{
  const s = SEAMS.find((x) => x.maxStep >= 2 && x.reciprocal);
  const md = buildSeamBrief(s, { viewerUrl: VIEWER });
  check(md.includes('almost never physical'),
    'a two-class step at a jurisdiction line gets the question it deserves');
}
{
  const comparisons = session.groups()
    .flatMap((g) => compareGroup(g.proposals, { ground: g.ground, crossAoi: g.crossAoi }));
  const t0 = performance.now();
  const md = buildSessionBrief(session, comparisons, SEAMS, { viewerUrl: VIEWER });
  check(md.includes('## Not compared'), `the session brief says what it did NOT compare (${ms(t0)} ms)`);
  check(md.includes('## The proposals') && md.includes('## What was found'),
    'and carries the index before the briefs');
  check((md.match(/^---$/gm) ?? []).length >= comparisons.length,
    'with every individual brief under a rule');
  check(!md.includes('km²'), 'miles throughout');
  check(md === buildSessionBrief(session, comparisons, SEAMS, { viewerUrl: VIEWER }),
    'and it too is deterministic');
}

/* ══ § 9 · the gates ═══════════════════════════════════════════════════════ */

section(9, 'what the session refuses, and what it merely warns about');

{
  const other = JSON.parse(JSON.stringify(FIXTURES[0].pkg));
  other.baseline.week = '2026-09-01';
  other.id = 'other-week';
  const s = createSession();
  s.add(FIXTURES[0].pkg, { fileName: 'a' });
  try {
    s.add(other, { fileName: 'b' });
    bad('a different week was accepted');
  } catch (err) {
    check(err instanceof SessionError && err.reason === 'differentWeek',
      'a different week is refused');
    check(err.message.includes('2026-09-01') && err.message.includes('2026-09-08'),
      `naming BOTH weeks: "${err.message}"`);
  }
}
{
  const s = createSession();
  const first = s.add(FIXTURES[0].pkg, { fileName: 'a' });
  const again = s.add(FIXTURES[0].pkg, { fileName: 'a-again' });
  check(s.size === 1, 'the same proposal twice is one proposal');
  check(again.proposal === first.proposal, 'and the second add hands back the first');
  check(again.warnings.some((w) => w.reason === 'alreadyLoaded'), 'with an alreadyLoaded warning');
}
{
  const reissued = JSON.parse(JSON.stringify(FIXTURES[1].pkg));
  reissued.baseline.sha256 = 'a'.repeat(64);
  reissued.id = 'reissued';
  const s = createSession();
  s.add(FIXTURES[0].pkg, { fileName: 'a' });
  const r = s.add(reissued, { fileName: 'b' });
  check(s.size === 2, 'the same week under a different checksum is ACCEPTED');
  check(r.warnings.some((w) => w.reason === 'reissuedBaseline'), 'with a reissuedBaseline warning');
  check(r.warnings[0].sentence.includes('re-issued'), `and a sentence that says so`);
}
{
  const A = parsed.get('MT-06e8fb67');
  const twin = JSON.parse(JSON.stringify(FIXTURES.find((f) => f.key === 'MT-06e8fb67').pkg));
  twin.id = '06e8fb67-0000-4000-8000-000000000000';
  const B = parseProposal(twin, { fileName: 'twin' });
  const c = compareProposals(A, B);
  check(c.sameAuthor === true, 'two files by one author are compared with sameAuthor');
  const s = createSession();
  s.add(FIXTURES.find((f) => f.key === 'MT-06e8fb67').pkg, {});
  s.add(twin, {});
  const ids = s.list().map((p) => p.shortId);
  check(ids.every((i) => i.length === 12) && new Set(ids).size === 2,
    `colliding shortIds widen to twelve: ${ids.join(', ')}`);
  check(s.list()[0].key.includes(ids[0]), 'and the proposal key follows the widened id');
}
{
  const empty = JSON.parse(JSON.stringify(FIXTURES[0].pkg));
  empty.derivedBands = { D0: null, D1: null, D2: null, D3: null, D4: null };
  empty.changes = [];
  empty.proposedChanges = [];
  let p = null;
  try { p = parseProposal(empty, { fileName: 'empty' }); } catch (err) {
    bad(`all-null bands were refused: ${err.message}`);
  }
  if (p) {
    check(true, 'a proposal with all-null bands is TOLERATED — it is a clear working area');
    const partition = p.partition;
    check(!!partition[0] && partition.slice(1).every((x) => x === null),
      "its partition is all 'none' and nothing else");
    const inside = turf.pointOnFeature(asFeature(p.aoi.geometry)).geometry.coordinates;
    check(classAt(p, inside) === 'none',
      "and every point inside it answers 'none' rather than throwing");
  }
}
{
  for (const [reason, mutate] of [
    ['schemaV1', (x) => { x.schema = 'usdm-edit-proposal/1'; }],
    ['notAProposal', (x) => { x.schema = 'something-else/3'; }],
    ['missingGeometry', (x) => { delete x.aoi.geometry; }],
    ['missingBands', (x) => { delete x.derivedBands; }],
    ['missingWeek', (x) => { delete x.baseline.week; }],
  ]) {
    const broken = JSON.parse(JSON.stringify(FIXTURES[0].pkg));
    mutate(broken);
    try {
      parseProposal(broken, { fileName: 'broken' });
      bad(`${reason} was accepted`);
    } catch (err) {
      check(err instanceof ProposalError && err.reason === reason,
        `${reason} is refused by name: "${err.message.slice(0, 64)}…"`);
    }
  }
}
{
  /* Finding ids collide rarely and must resolve deterministically — and must
     survive being resolved twice, because js/app.js runs it on every
     recompute. */
  const fake = [{ id: 'disc:aaaaaaaa' }, { id: 'disc:aaaaaaaa' }, { id: 'seam:bbbbbbbb' }];
  const once = resolveFindingIds(fake).map((f) => f.id);
  const twice = resolveFindingIds(resolveFindingIds(fake)).map((f) => f.id);
  check(once.join(',') === 'disc:aaaaaaaa,disc:aaaaaaaa-2,seam:bbbbbbbb',
    `a collision resolves by rank: ${once.join(', ')}`);
  check(once.join(',') === twice.join(','), 'and resolving twice suffixes once');
  const regions = [...comparisonsByPair.values()].flatMap((c) => c.regions);
  const findings = resolveFindingIds(rankFindings(regions, SEAMS));
  check(new Set(findings.map((f) => f.id)).size === findings.length,
    `all ${findings.length} findings of the original pairs have distinct ids`);
  const kinds = findings.map((f) => f.kind);
  check(kinds.indexOf('seam') === -1 || kinds.indexOf('seam') > kinds.lastIndexOf('one-sided'),
    'and seams come after the regions, which is the concatenation rankFindings promises');
}
{
  const p = parsed.get('MT-4ab1b4a8');
  const d = worstDeltaFor(p, p.patches[0]);
  check(d && d.delta === -1 && d.label === '1-class improvement',
    `worstDeltaFor reads the change map: ${d?.label}`);
}

/* ══ § 10 · the budget ═════════════════════════════════════════════════════ */

section(10, 'a whole twelve-proposal session, end to end');

{
  const t0 = performance.now();
  const s = createSession();
  for (const f of FIXTURES) s.add(f.pkg, { fileName: f.name });
  const tParse = ms(t0);

  const t1 = performance.now();
  const comparisons = s.groups()
    .flatMap((g) => compareGroup(g.proposals, { ground: g.ground, crossAoi: g.crossAoi }));
  const regions = comparisons.flatMap((c) => c.regions);
  const tCompare = ms(t1);

  const t2 = performance.now();
  const seams = await findSeams(s, { neighbors: NEIGHBORS });
  const tSeams = ms(t2);

  /* INTEGRITY BEFORE THE BRIEFS, because a brief reads it: a region brief asks
     whether either side's package re-checks cleanly before it writes the
     question about it, so measuring the briefs first would bill the whole
     re-check to them and report the re-check as free. */
  const t3 = performance.now();
  for (const p of s.list()) void p.integrity;
  const tIntegrity = ms(t3);

  const t4 = performance.now();
  const findings = resolveFindingIds(rankFindings(regions, seams));
  const briefs = findings.map((f) => (f.kind === 'seam'
    ? buildSeamBrief(f, { viewerUrl: VIEWER })
    : buildRegionBrief(f, comparisons.find((c) => c.regions.includes(f)), { viewerUrl: VIEWER })));
  const tBriefs = ms(t4);

  const total = ms(t0);
  console.log(`         parse ${tParse} · compare ${tCompare} · seams ${tSeams} · ` +
    `integrity ${tIntegrity} · briefs ${tBriefs} = ${total} ms`);
  console.log(`         ${comparisons.length} comparisons · ${regions.length} regions · ` +
    `${seams.length} seams · ${briefs.length} briefs`);
  check(total < 15000,
    `the whole session is ${(total / 1000).toFixed(1)} s — the catcher is 15 s`);
  check(briefs.every((b) => b.length > 400), 'and every finding produced a brief with something in it');
}

/* ── the tally ────────────────────────────────────────────────────────────── */

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks} check(s), ${failures} failure(s)` +
  `${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures === 0 ? 0 : 1);

/* ── small helpers ────────────────────────────────────────────────────────── */

function groupByAoi(proposals) {
  const out = new Map();
  for (const p of proposals) {
    if (!out.has(p.aoi.id)) out.set(p.aoi.id, []);
    out.get(p.aoi.id).push(p);
  }
  return out;
}

function rectGeom(w, s, e, n) {
  return { type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] };
}
