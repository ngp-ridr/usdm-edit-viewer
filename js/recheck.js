/* ============================================================================
   USDM Edit Viewer · js/recheck.js
   Re-check a proposal package against itself, and GRADE WHAT IT FINDS.

   DOM-FREE. No `window`, no `document`, no `fetch`; turf arrives through the
   vendored topology.js's `T()` shim. `tools/recheck.test.mjs` runs it under
   Node over the twelve bundled packages, and docs/contracts.md § 16.4 puts this
   module in the engine's DOM-free set.

     import { recheckPackage } from './recheck.js';
     const { grade, problems, largestKm2, sentence } = recheckPackage(pkg);

   ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
   `verifyPackage` answers one question — does this file re-derive? — with a
   boolean, and on the reference corpus that boolean is WRONG in the way that
   matters most: EIGHT OF THE TEN original example packages fail its
   `derivedBands ⇔ changes[].after` mutual-containment rule, every failure
   0–0.4 mi², worst 0.984 km² at 9.1 m mean width.

   None of that is an edit. `derivedBands` went through `deriveBands` (a
   difference per class, then `dropResidueParts`) and comes back through
   `deriveContours` (a suffix union), while `changes[].after` is the contour
   itself, untouched. On the archive's nested product those two paths part
   company along every shared edge, and what `deriveBands` dropped the round
   trip cannot put back. A tool that told a reviewer eight of ten reference
   proposals were "hand-edited or produced by a different version" would be
   worse than no tool at all.

   So every escape is measured on TWO CHANNELS — the same two
   `validateDerivedBands` already uses for band overlap — and graded:

     ≤ CONTAINMENT_TOLERANCE_M2 (100 m²)         ignored; never a problem
     ≤ RESIDUE_MAX_KM2 (1 km²) AND ≤ 50 m wide   `residue`
     anything else                               `defect`

   `meanWidthM = 2 · area / perimeter`. A corrupted band is KILOMETRES wide and
   still fails: verify § 7j's corrupt case replaces D2 with a 1° triangle, and
   `tools/recheck.test.mjs` translates a whole band 500 m for the same reason.

   ── WORKING AGAINST TWO COPIES OF verifyPackage ────────────────────────────
   The editor is making its own `verifyPackage` residue-aware; the pinned copy
   under vendor/usdm-editor/ may be either version, and this module must give
   the same answer against both. So:

     · a `residue` array on the result is USED when it is there (the new copy
       has already applied the width channel, and a clean file then costs no
       geometry work at all);
     · the mutual-containment loop is RE-RUN here whenever there is a
       containment problem to attach geometry to, or whenever the copy has no
       `residue` field — `ruleContainedIn` hands back WHERE the escape is, and
       the card's "Show me" needs that geometry. When it is re-run its answer
       is authoritative and the copy's own `residue` is not consulted, so
       nothing is ever counted twice.

   Containment messages produced by that loop are filtered out of
   `verifyPackage`'s own `problems` before the two are merged — by exact string
   AND by the shape of the sentence, because the two computations are the same
   code over the same bytes and the strings agree.

   ── COMPLETENESS IS NOT GEOMETRY, AND THE GRADE IS GEOMETRIC ───────────────
   `verifyPackage` also re-runs `validateJustification` over a finished package
   and pushes ITS report into the same `problems` array. Those sentences are the
   editor's FORM HINTS, written to an author in front of the form — "Say why
   this edit is right — a reviewer cannot act on a blank.", "Your name travels
   with the proposal." Passed through here they made a geometrically perfect
   package read "Re-check: 4 problems" and printed four imperatives at a
   reviewer who cannot act on any of them.

   So this module re-runs `validateJustification` ITSELF (the same call
   `verifyPackage` makes, over `{...justification, author}`), takes its
   sentences out of `problems` by exact string, and reports them as a separate
   `completeness` list of KEYS with ONE reader-facing sentence beside it:
   "This proposal carries no rationale and no author." The GRADE
   (pass/residue/defect) never sees them — it is a statement about geometry,
   and a missing email is not a defect in the ground.

   ── ITS PLACE IN THE ENGINE ────────────────────────────────────────────────
   docs/contracts.md § 2 gives `js/proposal.js` a `checkIntegrity(p)` with this
   grading in it. THE IMPLEMENTATION LIVES HERE, once: `checkIntegrity` is
   `recheckPackage` over the proposal's own package, and `containmentEscapes`
   is exported so it can be run against a `{ derivedBands, changes }` pair
   without a whole package. Two copies of a magnitude bar drift.
   ========================================================================== */

import { verifyPackage } from '../vendor/usdm-editor/js/submit.js';
/* The SAME call `verifyPackage` makes over a finished package — see the header.
   It is a pure function in a module the graph already loads (js/submit.js
   imports it), so this costs no new dependency and cannot drift from the
   sentences it is filtering. */
import { validateJustification } from '../vendor/usdm-editor/js/justify.js';
import {
  areaKm2, deriveContours, meanWidthM, ruleContainedIn,
  CONTAINMENT_TOLERANCE_M2, RESIDUE_WIDTH_M,
} from '../vendor/usdm-editor/js/topology.js';
import { CLASSES } from '../vendor/usdm-editor/js/color.js';
import { fmtMi, fmtMi2, fmtMi2Fine, km2ToMi2, MI2 } from '../vendor/usdm-editor/js/units.js';

/**
 * The area bar for residue, in km².
 *
 * Measured, not chosen: the worst escape over the ten original examples is
 * 0.984 km², and the widest is 9.1 m. One square kilometre is the round number
 * just above the measurement, and the WIDTH channel is what actually does the
 * separating — a 1 km² defect would have to be a 20 m × 50 km ribbon to pass,
 * and the clipper does not draw those.
 */
export const RESIDUE_MAX_KM2 = 1;

/** The three grades, worst last. Exported so a caller can sort or compare. */
export const GRADES = Object.freeze(['pass', 'residue', 'defect']);

/* ── the two channels ─────────────────────────────────────────────────────── */

/**
 * Grade ONE escape by its size and its shape.
 *
 * @param {number} km2 escaped area
 * @param {number} widthM mean width, `2 · area / perimeter`
 * @returns {'ignore'|'residue'|'defect'}
 */
export function gradeEscape(km2, widthM) {
  if (!(km2 > 0) || km2 * 1e6 <= CONTAINMENT_TOLERANCE_M2) return 'ignore';
  if (km2 <= RESIDUE_MAX_KM2 && widthM <= RESIDUE_WIDTH_M) return 'residue';
  return 'defect';
}

/**
 * Every place `derivedBands` and `changes[].after` disagree, WITH GEOMETRY.
 *
 * The loop is `verifyPackage`'s (vendored js/submit.js), run here so the
 * offending geometry survives: `ruleContainedIn` returns where the escape is,
 * and that is the only reason the width — and the card's "Show me" — are
 * available without a second boolean op.
 *
 * Both directions, per edited class: the rebuilt contour must sit inside
 * `changes[].after` and `changes[].after` inside the rebuilt contour. Either
 * block altered alone fails one of them.
 *
 * @param {object} pkg a `usdm-edit-proposal/2` package
 * @returns {Array<{class:string, message:string, geometry:object|null,
 *          areaKm2:number, widthM:number, grade:string}>}
 */
export function containmentEscapes(pkg) {
  const out = [];
  const bands = pkg?.derivedBands;
  if (!bands) return out;
  const rebuilt = deriveContours(bands);
  for (const ch of Array.isArray(pkg?.changes) ? pkg.changes : []) {
    const c = ch?.class;
    if (!CLASSES.includes(c) || !ch.after) continue;
    const a = ruleContainedIn(ch.after, rebuilt[c], {
      innerLabel: `changes[].after (${c})`, outerLabel: `derivedBands ⇒ ${c}` });
    const b = ruleContainedIn(rebuilt[c], ch.after, {
      innerLabel: `derivedBands ⇒ ${c}`, outerLabel: `changes[].after (${c})` });
    for (const r of [a, b]) {
      if (r.ok) continue;
      const geometry = r.geometry ?? null;
      const km2 = areaKm2(geometry);
      const widthM = meanWidthM(geometry);
      out.push({
        class: c, message: r.message, geometry,
        areaKm2: km2, widthM, grade: gradeEscape(km2, widthM),
      });
    }
  }
  return out;
}

/**
 * Is this problem sentence one the mutual-containment loop wrote?
 *
 * Both forms `ruleContainedIn` can produce, with the two labels this loop hands
 * it. Used to take the containment problems out of `verifyPackage`'s list
 * before this module's own graded ones go back in — the copy may be the old
 * one (which reports every escape) or the new one (which reports only the wide
 * ones), and the answer has to be the same either way.
 */
function isMutualContainmentMessage(message) {
  return /(?:changes\[\]\.after \(D\d\)|derivedBands ⇒ D\d)/.test(String(message ?? ''))
    && /(?:falls outside|exists where there is no)/.test(String(message ?? ''));
}

/* ── completeness: the paperwork, which is not the ground ─────────────────── */

/**
 * What a reader is told about each missing piece of paperwork.
 *
 * The KEYS are `validateJustification`'s; the phrases are written to a READER
 * rather than to the author in front of the form — nobody looking at somebody
 * else's proposal can act on "Your name travels with the proposal."
 */
const COMPLETENESS_PHRASES = Object.freeze({
  rationale: 'no rationale',
  'author-name': 'no author',
  'author-email': 'no contact address',
  'author-role': 'no stated role',
  evidence: 'a piece of evidence that could not be read',
});

/**
 * `validateJustification`'s report over a finished package.
 *
 * Byte-for-byte the call `verifyPackage` makes (vendored js/submit.js), so the
 * sentences this returns are exactly the ones in its `problems` array and the
 * filter below is an identity rather than a guess.
 *
 * @param {object} pkg
 * @returns {Record<string,string>} field key → the editor's own author-facing
 *          sentence
 */
export function justificationReport(pkg) {
  try {
    return validateJustification(pkg?.justification
      ? { ...pkg.justification, author: pkg.author } : {}) ?? {};
  } catch {
    /* A package is arbitrary bytes somebody chose. A throw here means nothing
       could be said about the paperwork, which is not the same as saying the
       paperwork is complete — but it is not a geometry defect either, and the
       geometry is what this module grades. */
    return {};
  }
}

/**
 * The ONE sentence a reader gets for a package missing its paperwork.
 *
 * `['rationale', 'author-name', 'author-email', 'author-role']` →
 * "This proposal carries no rationale and no author." The three author fields
 * collapse to ONE phrase when all three are missing: a stripped justification
 * is one fact about the file, not three, and a reader who is told "no author,
 * no contact address and no stated role" has been told the same thing three
 * times.
 *
 * @param {string[]} keys `validateJustification` keys
 * @returns {string} the sentence, or `''` when nothing is missing
 */
export function completenessSentence(keys) {
  const set = new Set(keys ?? []);
  if (!set.size) return '';
  const authorKeys = ['author-name', 'author-email', 'author-role'];
  const phrases = [];
  if (set.has('rationale')) phrases.push(COMPLETENESS_PHRASES.rationale);
  if (authorKeys.every((k) => set.has(k))) {
    phrases.push(COMPLETENESS_PHRASES['author-name']);
  } else {
    for (const k of authorKeys) if (set.has(k)) phrases.push(COMPLETENESS_PHRASES[k]);
  }
  if ([...set].some((k) => k.startsWith('evidence'))) phrases.push(COMPLETENESS_PHRASES.evidence);
  if (!phrases.length) return '';
  const joined = phrases.length === 1
    ? phrases[0]
    : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
  return `This proposal carries ${joined}.`;
}

/* ── the vendored sentences, in the units a reader reads ──────────────────── */

/**
 * A verifier sentence, in miles.
 *
 * `validateDerivedBands` writes its overlap failure with `fmtMi2Fine` and
 * `fmtFt` (vendored js/topology.js), which on a real defect prints
 * "7,605.49 mi² (mean width 61,460 ft)" — two decimal places on a number the
 * size of Massachusetts, and a width in feet that is eleven miles. The numbers
 * are right; the RESOLUTION is written for a sliver. This rewrites the two
 * spellings in place rather than touching the vendored copy, which is
 * byte-pinned and may never be edited.
 *
 * Both rules are one-way and lossy on purpose: a foot measurement under a mile
 * stays in feet (that is what residue is measured in) and a fine area under
 * 100 mi² keeps its decimals (`fmtMi2`'s own rule).
 */
export function readableMessage(message) {
  return String(message ?? '')
    .replace(/([\d,]+(?:\.\d+)?)\s*ft\b/g, (whole, num) => {
      const ft = Number(String(num).replace(/,/g, ''));
      if (!Number.isFinite(ft) || ft < 5280) return whole;
      /* fmtMi takes km; feet → km is the same constant js/units.js carries. */
      return `${fmtMi((ft * 0.3048) / 1000)} mi`;
    })
    .replace(/([\d,]+\.\d+)\s*mi²/g, (whole, num) => {
      const mi2 = Number(String(num).replace(/,/g, ''));
      if (!Number.isFinite(mi2) || mi2 < 100) return whole;
      return `${mi2.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${MI2}`;
    });
}

/* ── the verdict ──────────────────────────────────────────────────────────── */

/**
 * Re-check a package and grade what comes back.
 *
 * @param {object} pkg a parsed `usdm-edit-proposal/2` package
 * @returns {{grade:'pass'|'residue'|'defect', ok:boolean,
 *   problems:Array<{message:string, areaKm2:number|null, widthM:number|null,
 *                   geometry:object|null, class:string|null}>,
 *   residue:Array<{class:string|null, areaKm2:number, widthM:number, message:string}>,
 *   largestKm2:number, residueKm2:number, residueWidestM:number,
 *   sentence:string, gates:object|null}}
 *
 * `problems` is always an array of OBJECTS — never bare strings — so a caller
 * never has to ask which shape it got. `areaKm2`/`geometry` are null on a
 * problem that is about shape rather than ground (a missing id, an unparseable
 * justification); the card offers "Show me" only where there is geometry.
 *
 * `completeness` is the PAPERWORK, partitioned out (see the header): a list of
 * `validateJustification` keys with one reader-facing sentence in
 * `completenessSentence`. It never moves the grade — `ok` and `grade` are
 * statements about geometry, and a proposal with no email re-derives exactly.
 */
export function recheckPackage(pkg) {
  const v = safeVerify(pkg);

  /* THE PAPERWORK, out of the geometry's way. `verifyPackage` pushes
     `validateJustification`'s whole report into `problems`; the same call made
     here gives the exact strings to take back out. */
  const report = justificationReport(pkg);
  const completeness = Object.keys(report);
  const authoringSentences = new Set(Object.values(report));

  /* Split the copy's own problems: containment sentences are re-derived here
     with their geometry, everything else passes through as it was written. */
  const others = v.problems.filter((m) =>
    !isMutualContainmentMessage(m) && !authoringSentences.has(m));
  const containmentProblems = v.problems.filter((m) => isMutualContainmentMessage(m));

  /* The fast path is the new copy on a clean or residue-only file: its
     `residue` array has already applied the width channel, and there is no
     geometry to fetch because nothing failed. */
  const hasResidueField = Array.isArray(v.residue);
  const escapes = (!hasResidueField || containmentProblems.length)
    ? containmentEscapes(pkg)
    : null;

  const problems = [];
  const residue = [];

  if (escapes) {
    for (const e of escapes) {
      if (e.grade === 'ignore') continue;
      if (e.grade === 'residue') {
        residue.push({ class: e.class, areaKm2: e.areaKm2, widthM: e.widthM, message: e.message });
      } else {
        problems.push({
          message: e.message, class: e.class,
          areaKm2: e.areaKm2, widthM: e.widthM, geometry: e.geometry,
        });
      }
    }
  } else {
    for (const r of v.residue) {
      residue.push({
        class: r.class ?? null,
        areaKm2: Number.isFinite(r.km2) ? r.km2 : 0,
        widthM: Number.isFinite(r.widthM) ? r.widthM : 0,
        message: r.message ?? '',
      });
    }
  }

  for (const m of others) {
    problems.push({
      message: readableMessage(m), class: null, areaKm2: null, widthM: null, geometry: null,
    });
  }

  /* Largest first: a reviewer reads two problems and stops, so the two they
     read have to be the two that matter. A problem with no area sorts last —
     it is a claim about shape, and there is nothing to weigh it by. */
  problems.sort((a, b) => (b.areaKm2 ?? -1) - (a.areaKm2 ?? -1));

  const largestKm2 = problems.reduce((m, p) => Math.max(m, p.areaKm2 ?? 0), 0);
  /* The SUM, not the maximum: the sentence says what the two blocks agree to
     WITHIN, and a bound over several edges is their total. Same reading the
     editor's own report uses. */
  const residueKm2 = residue.reduce((a, r) => a + (r.areaKm2 ?? 0), 0);
  const residueWidestM = residue.reduce((m, r) => Math.max(m, r.widthM ?? 0), 0);

  /* GEOMETRIC, and `completeness` is deliberately not in it. */
  const grade = problems.length ? 'defect' : (residue.length ? 'residue' : 'pass');
  const result = {
    grade, ok: problems.length === 0, problems, residue,
    largestKm2, residueKm2, residueWidestM,
    completeness,
    completenessSentence: completenessSentence(completeness),
    gates: v.gates ?? null,
  };
  result.sentence = recheckSentence(result);
  return result;
}

/**
 * Either grading's result, in THIS module's shape, with the sentence written.
 *
 * Two things grade a package: `recheckPackage` here, and `js/proposal.js`'s
 * `checkIntegrity` (docs/contracts.md § 2), whose memo the drawer reads because
 * it is already built. They agree on the bars and differ on the shape —
 * `checkIntegrity` returns ONE `problems` list with a `grade` on every entry
 * (residue rows included) plus `escapedKm2`, while this module keeps the two
 * lists apart. A panel that read the wrong one would count ten slivers as ten
 * problems and paint the row amber.
 *
 * So the split happens HERE, once, and js/panels.js and js/cards.js both come
 * through it.
 *
 * @param {object|null} r either shape, or null
 * @returns {object|null} this module's shape, with `sentence`
 */
export function normalizeRecheck(r) {
  if (!r) return null;
  /* Already ours: `residue` split out and a sentence written. An older shape
     may predate the completeness split, so the two keys are FILLED IN rather
     than assumed — a panel reading `undefined.length` is the whole row gone. */
  if (Array.isArray(r.residue) && typeof r.sentence === 'string') {
    if (Array.isArray(r.completeness) && typeof r.completenessSentence === 'string') return r;
    const completeness = Array.isArray(r.completeness) ? r.completeness : [];
    return { ...r, completeness, completenessSentence: completenessSentence(completeness) };
  }

  const rows = (Array.isArray(r.problems) ? r.problems : []).map((p) => (typeof p === 'string'
    ? { message: p, class: null, areaKm2: null, widthM: null, geometry: null, grade: 'defect' }
    : p));
  const residue = rows.filter((p) => p.grade === 'residue').map((p) => ({
    class: p.class ?? null,
    areaKm2: p.areaKm2 ?? 0,
    widthM: p.widthM ?? 0,
    message: p.message ?? '',
  }));
  const problems = rows.filter((p) => p.grade !== 'residue');
  const completeness = Array.isArray(r.completeness) ? r.completeness : [];
  const out = {
    grade: r.grade ?? (problems.length ? 'defect' : residue.length ? 'residue' : 'pass'),
    ok: problems.length === 0,
    problems,
    residue,
    completeness,
    completenessSentence: r.completenessSentence ?? completenessSentence(completeness),
    largestKm2: problems.reduce((m, p) => Math.max(m, p.areaKm2 ?? 0), 0),
    residueKm2: r.escapedKm2 ?? residue.reduce((a, x) => a + (x.areaKm2 ?? 0), 0),
    residueWidestM: residue.reduce((m, x) => Math.max(m, x.widthM ?? 0), 0),
    gates: r.gates ?? null,
  };
  out.sentence = recheckSentence(out);
  return out;
}

/**
 * The author-facing line — docs/contracts.md § 15.
 *
 * A `residue` verdict NEVER says "hand-edited": it says what the two blocks
 * agreed to within, in miles, and names the cause. Eight of ten reference
 * proposals land here, and a warning that fires on eight of ten is not a
 * warning.
 *
 * Tolerant of `js/proposal.js`'s `checkIntegrity` shape as well as this
 * module's own (docs/contracts.md § 2 calls the escaped total `escapedKm2`),
 * so the sentence is written once wherever the grading ran.
 *
 * @param {{grade:string, problems:Array, largestKm2:number,
 *          residueKm2?:number, escapedKm2?:number}} r
 */
export function recheckSentence(r) {
  if (!r) return '';
  /* WRITTEN TO A REVIEWER, not to the file. "The package's own geometry agrees
     with itself" reads as a tautology to the person holding somebody else's
     proposal; what they want to know is whether this app re-derived the same
     map from the bytes they were sent. */
  if (r.grade === 'pass') return 'Re-check: re-derived from this file and it matches exactly.';
  if (r.grade === 'residue') {
    const total = r.residueKm2 ?? r.escapedKm2 ?? 0;
    /* `fmtMi2Fine` resolves to a hundredth of a square mile and most of these
       escapes are orders under it. "to within 0 mi²" would claim an exactness
       the round trip does not have, so the sentence floors at the formatter's
       own resolution — it is a BOUND, and a bound stays true when it is
       loosened. */
    const within = km2ToMi2(total) < 0.01 ? '0.01' : fmtMi2Fine(total);
    return `Re-check: agrees to within ${within} ${MI2} along shared edges — ` +
      'clipper residue, not an edit.';
  }
  const n = r.problems?.length ?? 0;
  const plural = n === 1 ? 'problem' : 'problems';
  if (!(r.largestKm2 > 0)) return `Re-check: ${n} ${plural}.`;
  return `Re-check: ${n} ${plural}, largest ${fmtMi2(r.largestKm2)} ${MI2}.`;
}

/**
 * `verifyPackage`, guarded, and always in the shape this module reads.
 *
 * A package is arbitrary bytes somebody chose. `verifyPackage` runs boolean ops
 * over geometry it did not write, and a throw out of a re-check would take the
 * whole proposal row down with it — so a throw becomes one problem that says
 * what happened, which is the answer a reviewer can act on.
 */
function safeVerify(pkg) {
  try {
    const v = verifyPackage(pkg);
    return {
      problems: Array.isArray(v?.problems) ? v.problems : [],
      residue: Array.isArray(v?.residue) ? v.residue : null,
      gates: v?.gates ?? null,
    };
  } catch (err) {
    return {
      problems: [`This file could not be re-checked — ${err?.message ?? 'unknown error'}.`],
      /* An empty array, not null: a throw is not an invitation to run the
         containment loop over the same geometry and throw again. */
      residue: [],
      gates: null,
    };
  }
}
