/* ============================================================================
   USDM Editor · js/submit.js
   Packaging and transport: builds the `usdm-edit-proposal/2` package,
   re-verifies one (`verifyPackage` — the same gate a future server-side check
   would run; the rules engine is DOM-free so it moves to Node unchanged),
   owns the transport registry, and exports the renderers a package needs
   wherever it is shown (`renderDeltaTable`, `transportControl`). The wizard
   imports those; nothing here imports the wizard or touches a `#selector`.
   Destinations are a SEAM: each new one is one `registerTransport` call.

   The package pins its baseline bytes (week + manifest sha256) and carries
   the WORKING AREA WITH ITS RINGS — a reviewer without this repo's boundary
   data cannot reproduce the clip; a few hundred KB against a 2 MB ceiling
   (the session archive ships an identity instead, js/session.js) — plus the
   per-class contour diff, one `proposedChanges` row per contiguous patch
   (rationale, `groupId`), `edgeEffects` and the `edgeBrief` Markdown, the
   working area's disjoint bands derived from the proposal, every rule result,
   whether the archive's rows had to be nested (`baseline.nesting`), the §3b change-magnitude
   result, and the justification. /1 is refused by name, never partially
   read; `groupId` and `edgeBrief` are additive and null-by-default, so the
   schema id holds.

   buildPackage = buildPackageCore (~15 s: the national fold and both national
   gates — every fact about GEOMETRY) + finishPackage (microseconds: author,
   justification, edgeBrief). They go stale for different reasons, so the
   wizard caches the CORE and re-stamps the envelope (js/wizard.js § The
   package cache); buildPackage stays as the one-call path (tools/verify.mjs
   § 7, tools/a11y-audit.mjs) and writes a byte-identical file — see
   `finishPackage` for the key-order guarantee. The NATIONAL geometry is NOT
   shipped: measured 9.84 MB (3.91 MB gzipped), 99.4% of the file, vs 0.06 MB
   for everything else — and it rebuilds exactly from the pinned baseline +
   aoi + edited contours via deterministic `changeset.applyToNational()`
   (tools/topology.test.mjs § 7c).
   ========================================================================== */

import { CLASSES, USDM_LABELS, USDM_COLORS } from './color.js';
import { el, hint, saveFile } from './dom.js';
import {
  areaKm2, tally, validateContours, validateDerivedBands, deriveBands, deriveContours, ruleContainedIn,
  meanWidthM, RESIDUE_WIDTH_M,
} from './topology.js';
import { checkChangeMagnitude } from './heuristic.js';
import { priorWeek, weekUrl } from './archive.js';
import { validateJustification } from './justify.js';
import { changeName, deriveEdgeEffects } from './changes.js';
import { loadNeighborGeometries } from './aoi.js';
/* Only `buildEdgeBrief` is needed here — it stamps the cross-border note into
   the package. `buildProposalGeoJSON` stays exported from js/geojson.js and
   directly Node-tested; nothing in this file needs the RFC 7946 shape. */
import { buildEdgeBrief } from './geojson.js';
import { fmtMi2, MI2 } from './units.js';
import { gzipText } from './gzip.js';

export const PACKAGE_SCHEMA = 'usdm-edit-proposal/2';
export const APP_VERSION = '0.1.0';

/** The schema this tool used to write. Recognised only to refuse it by name. */
const LEGACY_PACKAGE_SCHEMA = 'usdm-edit-proposal/1';

/* ══ transports ═════════════════════════════════════════════════════════════
   Two shapes, decided by what the browser needs from the gesture (CLAUDE.md):

     send(pkg)      a function → the renderer draws a BUTTON and awaits it.
                    Everything that produces bytes — a download, a POST.
     hrefFor(pkg)   a string → the renderer draws an ANCHOR. `mailto:` is a
                    NAVIGATION, and a button assigning `location.href` is a
                    link with middle-click and open-in-new-tab taken away.

   `applies(pkg)` is optional, default true. `listTransports()` stays static —
   the list is a property of the app, not of a package — so the RENDERER
   applies the predicate, being the only place a package exists. Nothing
   registered uses it today; the mechanism stays for the next transport that
   is conditional on what the package says.
   ═══════════════════════════════════════════════════════════════════════════ */

const transports = new Map();

/**
 * Register a way of getting a package somewhere.
 * @param {{id:string, label:string, description?:string,
 *          send?:(pkg:object)=>Promise<void>, hrefFor?:(pkg:object)=>string,
 *          applies?:(pkg:object)=>boolean}} t
 */
export function registerTransport(t) {
  if (!t?.id || (typeof t.send !== 'function' && typeof t.hrefFor !== 'function')) {
    throw new Error('[usdm/submit] a transport needs an id and either send() or hrefFor()');
  }
  transports.set(t.id, t);
}

export function listTransports() { return [...transports.values()]; }

/** Does this transport have anything to offer for this package? */
export function transportApplies(t, pkg) {
  return typeof t.applies === 'function' ? t.applies(pkg) === true : true;
}

/**
 * The filename stem every export shares: week, working area, proposal.
 *
 * The AOI id is kind-qualified — `state:MT` — and a colon cannot go in a
 * filename: it is illegal on Windows and is the old HFS path separator on
 * macOS, so the browser silently rewrites or refuses the name. Swapped for a
 * hyphen rather than dropped, because `usdm-proposal-…-30063` does not say what
 * 30063 is.
 */
function fileStem(pkg) {
  const aoiId = (pkg.aoi?.id ?? 'no-area').replace(/:/g, '-');
  return `usdm-proposal-${pkg.baseline.week}-${aoiId}-${String(pkg.id ?? '').slice(0, 8)}`;
}

registerTransport({
  id: 'download',
  label: 'Download the proposal',
  description: 'One compressed JSON file (.json.gz). It carries the geometry, the ' +
    'checks and your justification — attach it to an email, and this tool can load ' +
    'it back without you unpacking it.',
  async send(pkg) {
    const stem = fileStem(pkg);
    const json = JSON.stringify(pkg, null, 2);
    /* COMPRESSED, because this file exists to be ATTACHED. A pretty-printed
       package is coordinates and indentation, the most compressible thing this
       app produces — a real one measures 694 KB → ~128 KB (verify § 6; the
       ratio is a measurement, never a promise — see js/gzip.js) — and mail
       systems put a ceiling on attachments. gzip rather than zip: same bytes,
       a name that says what it holds, no container code of ours (js/gzip.js
       header). `openFile` (js/wizard.js) reads it directly, by magic bytes,
       which is what keeps the description's "load it back" true.

       WHERE THE BROWSER CANNOT COMPRESS, the same JSON goes out uncompressed
       under a `.json` name — a bigger attachment, not an error, and the
       reader treats both alike. */
    const gz = await gzipText(json);
    if (gz) saveFile(gz, `${stem}.json.gz`);
    else saveFile(new Blob([json], { type: 'application/json' }), `${stem}.json`);
  },
});

/* ── the GeoJSON and edge-brief transports are both REMOVED (WP-D) ───────────
   Removed, not disabled — a transport that never applies teaches the lesson a
   permanently-disabled button does (see the deferred-upload section). The
   GeoJSON was a second file saying what the proposal JSON already says
   (`buildProposalGeoJSON` is a PROJECTION of the package, js/geojson.js); the
   brief MOVED into the package as `edgeBrief`, stamped once per envelope, so
   a reviewer opens ONE file. Both builders stay exported and Node-tested. */

/* ══ email ══════════════════════════════════════════════════════════════════
   NDMC publishes no submission address, so `SUBMIT_EMAIL` names the person who
   maintains this tool and forwards what arrives. That is the whole rule it was
   empty to protect: an address must be a mailbox somebody READS, never a
   plausible-looking ndmc.unl.edu one that would lose proposals silently. When
   NDMC names a destination, this constant is the only line that changes.

   The recipient is the ONLY thing the author cannot see before they press
   send: `mailto:` opens their own client with the compose window filled in, and
   nothing leaves the browser until they send it themselves.

   `mailto:` needs NO CSP change — following it is a NAVIGATION, not
   connect-src (see CLAUDE.md; the S3 stub below is the opposite case). The
   length ceiling is real: Windows' ShellExecute has truncated around 2 KB and
   some clients drop the body past it, so the whole href is held under ~1800
   bytes AFTER encoding, and the per-class delta list — recomputable from the
   attachment — is the only thing ever dropped.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Where a finished proposal is emailed. A real, read mailbox — see above. */
export const SUBMIT_EMAIL = 'kyle.bocinsky@umontana.edu';

/** Bytes of `mailto:` href this app is willing to hand the operating system. */
const MAILTO_MAX_BYTES = 1800;

/** At most this many per-class delta lines, before the ceiling even applies. */
const MAILTO_MAX_DELTAS = 5;

registerTransport({
  id: 'email',
  label: 'Email the proposal',
  description: `Opens your mail program, addressed to ${SUBMIT_EMAIL}, with a ` +
    'summary already written. Download the proposal first and attach it — an ' +
    'email link cannot attach a file.',
  hrefFor: (pkg) => mailtoFor(pkg),
});

/**
 * The compose window, as a URL. Exported for the harness and for tests.
 *
 * IT READS NO ENVELOPE FIELD — load-bearing: `transportControl` builds an
 * anchor's `href` at RENDER time, so reading the author or justification here
 * would freeze whatever was typed at that moment into a link pressed minutes
 * later. Everything used (id, week, sha256, area, deltas, verdict) is CORE;
 * anything that needs the envelope has to become a `send`.
 */
export function mailtoFor(pkg) {
  const week = pkg?.baseline?.week ?? 'an unrecorded week';
  const aoiName = pkg?.aoi?.name ?? pkg?.aoi?.id ?? 'an unnamed area';
  const subject = `USDM edit proposal — ${week} — ${aoiName}`;

  const head = [
    `Proposal ${pkg?.id ?? '(no id)'}`,
    `Baseline week ${week}` +
      (pkg?.baseline?.sha256 ? ` (sha256 ${String(pkg.baseline.sha256).slice(0, 12)}…)` : ''),
    `Working area ${aoiName}${pkg?.aoi?.id ? ` (${pkg.aoi.id})` : ''}`,
    '',
  ];

  const deltas = (pkg?.changes ?? []).slice(0, MAILTO_MAX_DELTAS).map((c) => {
    const d = c.areaKm2?.delta ?? 0;
    return `  ${c.class} ${c.label ?? USDM_LABELS[c.class] ?? ''}: ` +
      `${d >= 0 ? '+' : '−'}${fmtMi2(Math.abs(d))} ${MI2}`;
  });

  const tail = [
    '',
    pkg?.validation?.passed
      ? 'Checks: every topology check passes on the full national geometry.'
      : 'Checks: the national checks did NOT pass — see the attached file.',
    '',
    "1. Click 'Download the proposal' and save the .json.gz file.",
    '2. Attach that file to this email — email links cannot attach files.',
  ];

  /* Shed the deltas one at a time until it fits. They are the only lines a
     reader can rebuild from the attachment, so they are the only lines that
     may go. */
  let list = deltas.length ? ['Per-class change inside the working area:', ...deltas] : [];
  let href = compose(subject, [...head, ...list, ...tail]);
  while (list.length && byteLength(href) > MAILTO_MAX_BYTES) {
    list = list.slice(0, -1);
    if (list.length === 1) list = [];         // the heading alone says nothing
    href = compose(subject, [...head, ...list, ...tail]);
  }
  return href;
}

function compose(subject, lines) {
  return `mailto:${SUBMIT_EMAIL}?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(lines.join('\n'))}`;
}

/** UTF-8 bytes, not characters — the ceiling is an OS one. */
function byteLength(s) {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length;
}

/* ══ the deferred upload ════════════════════════════════════════════════════
   `SUBMIT_ENDPOINT` is null, and while it is null NO TRANSPORT IS REGISTERED —
   a control that can never be pressed teaches an author this app has dead
   controls, and the genuinely-disabled download under a failing gate then
   reads as the same furniture.

   The contract, when it lands, is a presigned handoff — metadata first so the
   server can refuse before several hundred KB cross the wire:
     1. POST ${SUBMIT_ENDPOINT} with { schema, id, bytes, sha256 } (no
        geometry); the answer is a presigned PUT URL scoped to
        `${week}/${aoiId}/${id}.json` and that content-length.
     2. PUT the package bytes; the bucket policy allows nothing else.
     3. A 200 is the receipt — its object key goes into the toast.

   Enabling it is a TWO-file change, on purpose: the endpoint's AND the
   bucket's origins go into index.html's `connect-src` and into
   tools/verify.mjs § 1, which pins the list exactly (the review checkpoint).
   Without both, `fetch` rejects with a bare TypeError — the quietest possible
   failure for a submission (see CLAUDE.md).
   ═══════════════════════════════════════════════════════════════════════════ */

/** Where a package is POSTed. Null until the destination exists — see above. */
export const SUBMIT_ENDPOINT = null;

if (SUBMIT_ENDPOINT) {
  registerTransport({
    id: 'upload',
    label: 'Submit the proposal',
    description: 'Sends the proposal directly. You will get a receipt id back.',
    async send(pkg) {
      const body = JSON.stringify(pkg, null, 2);
      const bytes = byteLength(body);
      const sha256 = await sha256Hex(body);
      const res = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: pkg.schema, id: pkg.id, bytes, sha256 }),
      });
      if (!res.ok) throw new Error(`the submission service answered ${res.status}`);
      const { url } = await res.json();
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!put.ok) throw new Error(`the upload answered ${put.status}`);
    },
  });
}

/** Hex sha256 of a string, via WebCrypto. Only the upload path needs it. */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ── package assembly ─────────────────────────────────────────────────────── */

/**
 * Everything in a proposal that is a fact about the GEOMETRY. Slow on purpose
 * — the national union/difference pair runs here (~15 s) so editing never pays
 * for it; call with a progress callback and show it.
 *
 * The result has THREE holes — `author`, `justification`, `edgeBrief` — held
 * as `null` in their FINAL positions; `finishPackage` fills them (`edgeBrief`
 * last: it is derived from what the other two become). Not a file yet. `id`
 * and `created` are minted HERE, so they stay stable across every envelope
 * stamped onto one core. TREAT THE RESULT AS FROZEN: `finishPackage` spreads
 * rather than clones (copying hundreds of KB per keystroke is the cost this
 * split avoids), so every envelope shares one core's arrays — mutate a built
 * core and you have edited every package made from it.
 */
export async function buildPackageCore(ctx, { onProgress = () => {} } = {}) {
  const cs = ctx.changeset;
  if (!cs) throw new Error('[usdm/submit] nothing to package');

  /* FIRST, before anything reads the change list: `flushChanges` is a
     comparison when the list is current for `changeset.version` and the
     recompute otherwise (js/app.js) — a package must never carry a previous
     commit's patches under fresh geometry, whatever path led here. */
  ctx.flushChanges?.();

  onProgress('Folding your edits back into the national map…');
  await tick();
  const final = cs.finalize();

  onProgress('Checking the whole country…');
  await tick();
  /* The working area's exclusive-class bands — the changeset's memo, which is
     `deriveBands(cs.contours)` by the same function that produces the national
     ones, so the two agree by construction. */
  const extentBands = cs.bands;
  const baselineBands = cs.baselineBands;

  onProgress('Comparing against last week…');
  await tick();
  const mf = ctx.manifest;
  /* "No warning" and "no check" are different claims: `warnings: []` must not
     read as "ran clean" when there is no prior week or it would not load, so
     the package says which case it is. `warnings` is derived from this and
     keeps its old shape for anything already reading it. */
  const heuristic = ctx.priorData?.contours
    ? checkChangeMagnitude({
        proposedContours: cs.contours,
        baselineContours: cs.baselineContours,
        previousContours: ctx.priorData.contours,
      })
    /* Only the manifest can say "there IS no previous week". Without one, all
       we honestly know is that we do not have last week's contours. */
    : { skipped: mf?.weeks && !priorWeek(mf.weeks, ctx.week)
          ? 'no-prior-week'
          : 'prior-week-unavailable' };

  const shaOf = (w) => (w ? mf?.byWeek.get(w)?.sha256 ?? null : null);
  const priorWeekId = ctx.priorData?.week ?? null;

  const changes = CLASSES.filter((c) => cs.editedClasses.includes(c)).map((c) => ({
    class: c,
    label: USDM_LABELS[c],
    /* The GEOMETRY is the contour — cumulative, the archive's own format. The
       NUMBERS beside it are the exclusive band's: `areaKm2` and `parts` count
       this class WITHOUT the severer classes nested inside it, the same way
       `changeset.summary()` does for the screen (and where a contour-measured
       D0 row used to carry the whole drought's footprint). `derivedBands`
       below carries the band geometry these numbers were taken from. */
    before: cs.baselineContours[c] ?? null,
    after: cs.contours[c] ?? null,
    areaKm2: {
      before: areaKm2(baselineBands[c]),
      after: areaKm2(extentBands[c]),
      delta: areaKm2(extentBands[c]) - areaKm2(baselineBands[c]),
    },
    parts: {
      before: tally(baselineBands[c]).parts,
      after: tally(extentBands[c]).parts,
    },
  }));

  /* ── the changes, as an author counts them ─────────────────────────────────
     `changes` above is a per-CLASS diff; `proposedChanges` is one row per
     contiguous patch — the unit a reviewer can accept or reject alone and an
     author writes a rationale for. Orphans are excluded and must be: an
     orphaned annotation explains an undone edit (kept so redo costs nothing,
     js/changes.js), and shipping one puts an argument for a change into a file
     that does not contain that change. */
  const tracker = ctx.changes;
  const patches = tracker?.patches ?? [];
  const byKey = new Map((tracker?.annotations ?? []).map((a) => [a.key, a]));
  const proposedChanges = patches.map((p) => {
    const a = byKey.get(p.key);
    const rationale = typeof a?.rationale === 'string' ? a.rationale : '';
    return {
      id: p.key,
      seq: p.seq,
      name: changeName(p.seq),
      geometry: p.geometry,
      anchor: p.anchor,
      bbox: p.bbox,
      areaKm2: p.areaKm2,
      classes: p.classes,
      /* Empty prose is `null`, not `''`. A reviewer reading the JSON should see
         "nobody wrote one" rather than a string that could equally be a
         rationale someone deleted the contents of. */
      rationale: rationale.trim() ? rationale : null,
      /* WHOSE rationale: several changes can share one piece of prose —
         js/changes.js keeps a group id plus a copy of the text on each member.
         The copy keeps every change readable alone; the id tells a reviewer
         the sentences are ONE sentence. Additive, null-by-default. */
      groupId: a?.groupId ?? null,
      reviewed: a?.reviewed === true,
      annotated: !!rationale.trim(),
    };
  });

  /* ── what this says to the jurisdiction next door ──────────────────────────
     The neighbour fetch is same-origin (vendor/aoi/*) and cached by js/aoi.js,
     so it usually costs no network — but can be a cold read on a deep-linked
     session, hence the progress message (the one await here that is not
     arithmetic). A failure costs the coordination note, not the proposal. */
  onProgress('Looking at the boundaries you touched…');
  let edgeEffects = [];
  try {
    edgeEffects = deriveEdgeEffects({
      patches,
      aoi: ctx.aoi,
      neighbors: ctx.aoi ? await loadNeighborGeometries(ctx.aoi) : [],
    });
  } catch (err) {
    console.warn('[usdm/submit] could not derive the edge effects', err);
  }

  return {
    schema: PACKAGE_SCHEMA,
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    app: { name: 'ngp-ridr/usdm-editor', version: APP_VERSION },
    baseline: {
      week: ctx.week,
      source: weekUrl(ctx.week),
      sha256: shaOf(ctx.week),
      /* What js/archive.js's heal did to the rows this proposal was drawn
         against: `healed` and the per-class leak in m². A reviewer diffing
         `changes[].before` against the raw archive row otherwise sees ground
         the HEAL moved and reads it as the author's. Nested inside `baseline`
         so the package's top-level key order (tools/verify.mjs § 7) holds. */
      nesting: ctx.weekData?.nesting
        ? { healed: ctx.weekData.nesting.healed, leaksM2: ctx.weekData.nesting.leaksM2 }
        : null,
    },
    priorWeek: priorWeekId
      ? { week: priorWeekId,
          source: weekUrl(priorWeekId),
          sha256: shaOf(priorWeekId) }
      : null,
    /* The working area, RINGS INCLUDED — see the header: a reader gets the
       boundary every other claim is scoped to, not an id to resolve. */
    aoi: {
      kind: ctx.aoi?.kind ?? null,
      id: ctx.aoi?.id ?? null,
      name: ctx.aoi?.name ?? null,
      bbox: ctx.aoi?.bbox ?? null,
      geometry: ctx.aoi?.geometry ?? null,
    },
    /* PLACEHOLDER — `finishPackage` overwrites it, and a spread keeps a key
       the target already has in place, so the finished file's key order is the
       order this file has always written. Same for the two below. */
    author: null,
    changes,
    proposedChanges,
    edgeEffects,
    changedRegion: final.changedRegion,
    /* The working area's DISJOINT BANDS, derived from the proposed contours —
       the exclusive representation the archive's metadata tells readers to
       derive from its rows. `changes[].before/after` carry the contours, which
       ARE the archive's own format. Scoped, not national — see the header for
       the measurement behind that. */
    derivedBands: Object.fromEntries(CLASSES.map((c) => [c, extentBands[c] ?? null])),
    /* PLACEHOLDER — see `author` above. */
    justification: null,
    /* PLACEHOLDER — computed by `finishPackage` FROM the author and
       justification it just stamped; reserved here to fix its position. */
    edgeBrief: null,
    heuristic,
    warnings: heuristic && !heuristic.skipped && heuristic.flagged ? [heuristic] : [],
    validation: {
      /* Both gates ran on the FULL national geometry, which is why their
         results are here even though that geometry is not. */
      scope: 'national',
      contours: strip(final.contourGate),
      derivedBands: strip(final.bandGate),
      passed: final.contourGate.passed && final.bandGate.passed,
    },
    /* Enough to rebuild the national result exactly, without shipping it. */
    reproduce: {
      method: 'changeset.applyToNational',
      /* Both halves of the fold are about the AOI POLYGON: the clip is
         bbox-prefilter-then-intersect (a naked intersect is 125–340× slower),
         and the near parts subtract the polygon, NOT its rectangle —
         subtracting the bbox erases real drought inside the envelope but
         outside the jurisdiction (for Montana, the Idaho corner). */
      note: 'Fetch baseline.source: one row per class, each a cumulative contour ' +
            '(its class and every more severe one). Nest them first — contour[n] = ' +
            'row[n] ∪ contour[n+1], a no-op unless the rows leak; baseline.nesting ' +
            'says whether they did. Clip each class to aoi.geometry — filter parts ' +
            'by aoi.bbox first, then intersect only those with the polygon — and ' +
            'replace the result with changes[].after. Fold back as (parts whose bbox ' +
            'misses aoi.bbox) ∪ (the remaining parts − aoi.geometry) ∪ (edited ' +
            'geometry), unioned once. Subtracting aoi.bbox instead of aoi.geometry ' +
            'deletes drought outside the jurisdiction but inside its envelope.',
      nationalBandTally: Object.fromEntries(CLASSES.map((c) =>
        [c, final.nationalBands[c] ? tally(final.nationalBands[c]) : null])),
    },
  };
}

/**
 * A justification nobody has filled in, in the shape the stamp expects —
 * exported so the wizard's every-render stamping has ONE shape instead of
 * `?? {}` decided at four call sites. The step-4 gate keeps it out of any
 * package built for a person; tests and mid-form callers get empty fields
 * rather than a throw on `undefined.filter`.
 *
 * KEY SET MUST MATCH `EMPTY()` in js/justify.js EXACTLY (that module's "The
 * contract both forms are held to"): a key present in one and not the other is
 * a key one form's emit silently drops. `borderNotes` is here even though only
 * js/wizard.js's `paintEdgeEffects` writes it, because a package stamped
 * before that happens still needs the key to exist.
 */
export const EMPTY_JUSTIFICATION = Object.freeze({
  rationale: '', impacts: '', evidence: [], borderNotes: {}, author: {},
});

/**
 * Stamp an author, a justification and a cross-border brief onto a built core.
 * Pure and cheap — `edgeBrief` is string formatting over data already in
 * `core`. SPREAD, NOT CLONE: copying the core's geometry per keystroke is the
 * cost the split exists to avoid, so every package stamped from one core
 * SHARES its arrays and the core must never be mutated after it is built. The
 * three keys already exist on the core holding `null`, so the spread and the
 * assignments REPLACE them in place — the finished file's key order is
 * identical to the pre-split writer's, `edgeBrief` included.
 *
 * @param {object} core from `buildPackageCore`
 * @param {object} [justification] the form's value; empty fields when absent
 * @returns {object} the package, ready to be written
 */
export function finishPackage(core, justification) {
  const j = justification ?? EMPTY_JUSTIFICATION;
  const stamped = {
    ...core,
    author: j.author,
    justification: {
      /* DECLARED, not implied. The rationale and impacts fields are
         Markdown-aware on the wizard's Explain step, and prose whose format is
         only known to the tool that wrote it is prose the next reader renders as
         literal asterisks — or, worse, as HTML. Stating it in /2 means a file
         written today is still self-describing when the field changes.
         js/mdtext.js owns what "markdown" means here, sanitizer included. */
      format: 'markdown',
      rationale: j.rationale,
      impacts: j.impacts,
      /* Rows with neither a link nor a photo were never evidence. */
      evidence: (j.evidence ?? []).filter((e) => e.url || e.image),
      /* Per-neighbour narratives, keyed by id — see js/wizard.js
         `paintEdgeEffects`. Defaulted here rather than left `undefined`: an
         older-shaped justification (or a bare `{}` from a test) must not throw
         inside `buildEdgeBrief`'s lookup. */
      borderNotes: j.borderNotes ?? {},
    },
  };
  /* AFTER the spread, never inside it: `buildEdgeBrief` reads the author and
     border notes THIS CALL just stamped (js/geojson.js), so it needs the
     spread's OUTPUT — as one more property of the literal it would read
     `core`'s placeholder `author: null`. The `null` on `core` fixed this
     key's position; this fills it without moving it. */
  stamped.edgeBrief = buildEdgeBrief(stamped);
  return stamped;
}

/**
 * Build the whole proposal: the core, then the envelope.
 *
 * The one-call path, kept because a package IS one thing from the outside —
 * tools/verify.mjs § 7 and tools/a11y-audit.mjs build one this way, and so does
 * anything that has no reason to hold a core. Callers that re-stamp an envelope
 * often (the wizard's step 4, the navbar's Export menu) use the two halves.
 */
export async function buildPackage(ctx, justification, opts) {
  return finishPackage(await buildPackageCore(ctx, opts), justification);
}

/** Rule results without the geometry payloads, which would dwarf the package. */
function strip(gate) {
  return {
    scope: gate.scope,
    passed: gate.passed,
    ranAt: gate.ranAt,
    rules: gate.rules.map((r) => ({ id: r.id, class: r.usdmClass, ok: r.ok, message: r.message })),
    failures: gate.failures.map((r) => ({ id: r.id, class: r.usdmClass, message: r.message, geometry: r.geometry })),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Re-validate a package from its own contents — the same gate, run the other
 * way round, so a reviewer knows what the file claims before they read the
 * prose.
 *
 * THE MUTUAL-CONTAINMENT CHECK IS RESIDUE-AWARE, and it has to be. The two
 * blocks it compares are not two copies of one computation: `derivedBands` went
 * through `deriveBands` (a difference per class, and `dropResidueParts` at the
 * end) and comes back here through `deriveContours` (a suffix union), while
 * `changes[].after` is the contour itself, untouched. On the nested product
 * those two paths part company along every shared edge — the clipper's residue,
 * the same thing `validateDerivedBands`' band-overlap rule answers — and what
 * `deriveBands` dropped the round trip cannot put back. Measured over the ten
 * bundled example proposals as they shipped: EIGHT failed the flat
 * `CONTAINMENT_TOLERANCE_M2` — largest escape 0.984 km² (1.7 m wide), widest
 * 9.1 m (0.949 km²), most of them 0.0002 km² and under a metre. A file the app
 * had just written was being reported as hand-edited.
 *
 * So the reading here is the two-channel one from `RESIDUE_WIDTH_M`'s header:
 * an escape counts as a PROBLEM only if it is over the area tolerance (which
 * `ruleContainedIn` has already applied) AND wider than residue (50 m, mean
 * width = 2·area/perimeter). Anything narrower is reported as `residue` — it is
 * measured and handed back rather than hidden, so a caller can say what it
 * agreed to within. A corrupted band (verify § 7j replaces D2 with a 1°
 * triangle) is kilometres wide and still fails.
 *
 * `ruleContainedIn` itself is NOT loosened: the editor's live gate uses it as
 * it stands, and this width reading belongs to re-checking a FILE, where both
 * sides have already been through a derivation.
 *
 * @returns {{ok:boolean, problems:string[], residue:Array<{class:string,
 *          km2:number, widthM:number, message:string}>, gates:object}}
 */
export function verifyPackage(pkg) {
  const problems = [];
  /* Escapes small enough to be clipper residue: not problems, not silence. */
  const residue = [];
  /* /1 is REFUSED BY NAME rather than partially read: its `extent` block has
     no geometry, so the containment checks below would run blind, and a
     "passed" on half-checked claims is the worst answer. Nothing shipped
     as /1. */
  if (pkg?.schema === LEGACY_PACKAGE_SCHEMA) {
    return {
      ok: false,
      problems: ['This file was made by an earlier version of this tool and cannot ' +
        'be checked here.'],
      residue: [],
      gates: { contours: null, bands: null },
    };
  }
  if (pkg?.schema !== PACKAGE_SCHEMA) problems.push(`Unknown schema "${pkg?.schema}".`);
  if (!pkg?.baseline?.week) problems.push('No baseline week — the proposal does not say what it edits.');
  if (!pkg?.baseline?.sha256) problems.push('No baseline checksum — the exact archive bytes are unpinned.');

  /* ── the /2 blocks, SHALLOWLY ──────────────────────────────────────────────
     Shape, not topology: the deep gates below re-derive and re-assert; these
     catch the shapes that would make that gate read the wrong thing, or make
     the file unusable to a reviewer without this repo's boundary data. */
  const aoi = pkg?.aoi;
  if (!aoi || typeof aoi !== 'object') {
    problems.push('No working area — the proposal does not say where it applies.');
  } else {
    if (!aoi.id) problems.push('The working area has no id.');
    if (!aoi.geometry) {
      problems.push('The working area carries no geometry, so the clip this proposal ' +
        'is scoped to cannot be reproduced.');
    }
    if (!Array.isArray(aoi.bbox) || aoi.bbox.length !== 4) {
      problems.push('The working area has no [west, south, east, north] envelope.');
    }
  }

  if (!Array.isArray(pkg?.proposedChanges)) {
    problems.push('No change list — the proposal does not say what was changed, only ' +
      'which classes moved.');
  } else {
    for (const [i, c] of pkg.proposedChanges.entries()) {
      if (!c?.id) problems.push(`Change ${i + 1} has no id, so nothing can refer to it.`);
      if (!c?.geometry) problems.push(`Change ${i + 1} (${c?.name ?? 'unnamed'}) has no geometry.`);
      /* `groupId` is additive: absent = predates groups, null = explains
         itself, string = shares that rationale. Anything else cannot be
         compared for grouping, so it is named here rather than surfacing as
         changes that mysteriously belong together. */
      if (c?.groupId != null && typeof c.groupId !== 'string') {
        problems.push(`Change ${i + 1} (${c?.name ?? 'unnamed'}) has a groupId that is ` +
          'not a name, so what it shares a rationale with cannot be worked out.');
      }
    }
  }

  if (pkg?.edgeEffects !== undefined && !Array.isArray(pkg.edgeEffects)) {
    problems.push('edgeEffects must be a list; an empty one means nothing reached a border.');
  }

  const jProblems = validateJustification(pkg?.justification
    ? { ...pkg.justification, author: pkg.author } : {});
  for (const m of Object.values(jProblems)) problems.push(m);

  let contours = null, bands = null;
  if (pkg?.derivedBands) {
    bands = validateDerivedBands(pkg.derivedBands);
    if (!bands.passed) problems.push(...bands.failures.map((f) => f.message));

    /* Rebuild the contours the bands imply and re-assert containment, over the
       WORKING AREA — the same suffix union the archive's rows go through. */
    const rebuilt = deriveContours(pkg.derivedBands);
    contours = validateContours(rebuilt, { scope: 'extent', checkPartOverlap: false });
    if (!contours.passed) problems.push(...contours.failures.map((f) => f.message));

    /* And the bands and the contour diff have to AGREE: for every edited class
       the rebuilt contour and `changes[].after` contain each other — within the
       containment tolerance, and WIDER THAN RESIDUE. This is the check that
       catches a hand-edited package — either block altered alone fails it —
       and the width channel is what keeps it from catching the app's own
       output instead (see this function's header for the measurement). */
    for (const ch of Array.isArray(pkg.changes) ? pkg.changes : []) {
      const c = ch?.class;
      if (!CLASSES.includes(c) || !ch.after) continue;
      const a = ruleContainedIn(ch.after, rebuilt[c], {
        innerLabel: `changes[].after (${c})`, outerLabel: `derivedBands ⇒ ${c}` });
      const b = ruleContainedIn(rebuilt[c], ch.after, {
        innerLabel: `derivedBands ⇒ ${c}`, outerLabel: `changes[].after (${c})` });
      for (const r of [a, b]) {
        if (r.ok) continue;
        /* `ruleContainedIn` hands back WHERE it escaped, which is the only
           reason the width is available without a second boolean op. */
        const widthM = meanWidthM(r.geometry);
        if (widthM > RESIDUE_WIDTH_M) { problems.push(r.message); continue; }
        residue.push({ class: c, km2: areaKm2(r.geometry), widthM, message: r.message });
      }
    }
  } else {
    problems.push('No derived bands — nothing to check.');
  }

  return { ok: problems.length === 0, problems, residue, gates: { contours, bands } };
}


/* ══ renderers ══════════════════════════════════════════════════════════════
   Two pieces of DOM that belong to a PACKAGE rather than to a screen — each
   appears in two places (the delta table on steps 3 and 4; a transport row on
   step 4 and in a loaded proposal's report), and a renderer that exists twice
   eventually renders two different things. They hand back an element: no
   selectors, no `ctx` — the non-data arguments are `transportControl`'s
   callbacks (`getPackage`, for the CURRENT envelope; `guard`; toast/live).
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The before/after table, one row per edited class. Built node by node — a
 * `style` ATTRIBUTE is blocked by CSP (`style-src 'self'`); setting `.style`
 * through the CSSOM is not. Every swatch carries its class NAME beside it:
 * the USDM ramp is CVD-hostile, so a bare swatch column is unreadable.
 *
 * @param {Array} rows `changeset.summary()` entries, already filtered to the
 *        edited ones — or a package's `changes` array, which carries the same
 *        `class`/`areaKm2`/`parts` shape under a different key for the class.
 * @returns {HTMLElement} a `.table-scroll` wrapper. Wide content scrolls inside
 *          its own box; the page never scrolls sideways.
 */
export function renderDeltaTable(rows) {
  const htr = el('tr', {},
    ...['Class', 'Area before', 'Area after', 'Change', 'Parts']
      .map((h) => el('th', { scope: 'col' }, h)));

  const tb = el('tbody');
  for (const r of rows) {
    /* `summary()` says `usdmClass`; a package's `changes[]` says `class`. One
       table serves both rather than two tables drifting apart. */
    const cls = r.usdmClass ?? r.class;
    const sw = el('span', { class: 'legend-swatch' });
    sw.style.background = USDM_COLORS[cls];   // CSSOM, never a style attribute
    const d = r.areaKm2.delta;
    tb.append(el('tr', {},
      el('td', {}, el('span', { class: 'swatch-cell' }, sw, `${cls} · ${USDM_LABELS[cls]}`)),
      ...[fmtArea(r.areaKm2.before), fmtArea(r.areaKm2.after),
          `${d >= 0 ? '+' : '−'}${fmtArea(Math.abs(d))}`,
          `${r.parts.before} → ${r.parts.after}`]
        .map((text) => el('td', { class: 'num' }, text))));
  }
  return el('div', { class: 'table-scroll' },
    el('table', { class: 'delta-table' }, el('thead', {}, htr), tb));
}

/** Areas, in SQUARE MILES from a km² input, at a precision that does not imply
    more than the geometry knows. The conversion lives in js/units.js; this name
    is kept because every caller appends the unit beside it. */
export const fmtArea = fmtMi2;

/**
 * One transport, as the control its shape calls for. A `hrefFor` transport
 * renders an ANCHOR (a `mailto:` is a navigation — see CLAUDE.md; no
 * `download` attribute, these hrefs are not files), keeping the browser's
 * underline: suppressing it would cost a kit-override, and the underline is
 * telling the truth — this control leaves the page. UNDER A FAILING GATE IT
 * RENDERS AS A DISABLED BUTTON INSTEAD: an anchor cannot be disabled —
 * dropping its `href` drops it out of the tab order, and `aria-disabled`
 * alone leaves a link that still navigates.
 *
 * `getPackage`, not `pkg`: the wizard caches a CORE and stamps the envelope
 * fresh, so a package captured at render time would send the author's name as
 * typed when the step was entered. A BUTTON calls it at CLICK time; an ANCHOR
 * at RENDER time — safe only because `mailtoFor` reads no envelope field, and
 * a `hrefFor` transport that ever needs one has to become a `send`. `guard`
 * runs on EVERY activation, both shapes; answering false cancels it (the
 * anchor's click is `preventDefault`ed).
 *
 * @param {object} t the transport
 * @param {{getPackage: () => object, gatePassed: boolean,
 *          guard?: () => boolean, toast?: Function, live?: Function}} opts
 *        `getPackage` must answer synchronously at render time; a promise is
 *        awaited on the button path.
 */
export function transportControl(t, { getPackage, gatePassed, guard = () => true,
                                      toast, live } = {}) {
  if (typeof t.hrefFor === 'function' && gatePassed) {
    const a = el('a', { class: 'nav-btn', href: t.hrefFor(getPackage()) }, t.label);
    a.addEventListener('click', (e) => { if (guard() !== true) e.preventDefault(); });
    return a;
  }
  /* Not dom.js's button(): the label is kept plain but the disabled state and
     the async handler are this function's whole subject. */
  const b = el('button', { type: 'button', class: 'nav-btn' }, t.label);
  b.addEventListener('click', async () => {
    if (typeof t.send !== 'function') return;
    if (guard() !== true) return;
    try {
      await t.send(await getPackage());
      toast?.('Proposal saved.');
      live?.('Proposal packaged and saved.');
    } catch (err) {
      console.error('[usdm/submit] transport failed', err);
      toast?.(`Could not send: ${err.message}`);
    }
  });
  b.disabled = !gatePassed;
  return b;
}

/**
 * Every applicable transport for a package, each with its description.
 *
 * The predicate is applied HERE, because this is the only place a package
 * exists. `listTransports()` stays static on purpose — see the transports
 * header — so the renderer is what filters. It reads one package at render time
 * for that predicate and for the anchors; the buttons ask again when pressed.
 *
 * @param {{getPackage: () => object, gatePassed: boolean, guard?: () => boolean,
 *          toast?: Function, live?: Function}} opts
 * @returns {HTMLElement[]} one `.field.transport` block per transport
 */
export function renderTransports({ getPackage, gatePassed, guard, toast, live } = {}) {
  const pkg = getPackage();
  const out = [];
  for (const t of listTransports()) {
    if (!transportApplies(t, pkg)) continue;
    const wrap = el('div', { class: 'field transport' },
      transportControl(t, { getPackage, gatePassed, guard, toast, live }),
      t.description ? hint(t.description) : null);
    out.push(wrap);
  }
  return out;
}
