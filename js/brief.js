/* ══ USDM Edit Viewer · js/brief.js ═══════════════════════════════════════════
   A markdown discussion brief per finding — the thing a reviewer actually
   takes into the meeting.

   DOM-free AND TURF-FREE (docs/contracts.md § 7). It imports `color.js`,
   `units.js` and `changes.js`'s `prose`, and nothing else: every number it
   prints was measured by somebody upstream, and a brief that recomputed one
   would be a second opinion about geometry rather than a report of the first.

   ── THE HOUSE STYLE IS THE VENDORED `buildEdgeBrief`'s ────────────────────
   (js/geojson.js): an H1 naming the place and the week, a disclaimer that
   nothing here is published, bullet metadata, `##` per party, and the pin
   lines — the baseline sha256 and its source url — at the end, because a
   document about a week that cannot say WHICH bytes of that week cannot be
   reproduced. Markdown rather than prose in a panel, for the same reason the
   editor chose it: this is a document a person forwards, pastes into an email,
   or opens in any editor.

   ── MILES, AND ONLY MILES ─────────────────────────────────────────────────
   Every area and length here goes through `fmtMi2`/`fmtMi`. The objects it
   reads carry km² and km under keys that say so, and not one of those numbers
   reaches the page — the reader is a US drought author who thinks in square
   miles, and a brief that mixed the two would be a brief somebody misquotes.
   tools/compare.test.mjs § 8 asserts that no brief contains the string `km²`.

   ── DETERMINISTIC ─────────────────────────────────────────────────────────
   The same session produces byte-identical markdown twice: no timestamp, no
   `Math.random`, and every iteration over a Map or an object is sorted. A
   brief is pasted into a ticket and diffed against the one from last week.
   ========================================================================== */

import { USDM_LABELS, USDM_CHANGE_LABELS } from '../vendor/usdm-editor/js/color.js';
import { fmtMi2, fmtMi, MI2 } from '../vendor/usdm-editor/js/units.js';
import { prose } from '../vendor/usdm-editor/js/changes.js';

/** The ordinal scale, restated rather than imported: js/proposal.js imports the
 *  vendored topology (and therefore turf) and this file may not. Same six
 *  states, same numbering — docs/contracts.md § 1. */
const LEVELS = Object.freeze(['none', 'D0', 'D1', 'D2', 'D3', 'D4']);
const ord = (level) => LEVELS.indexOf(level) - 1;

/** How a class is named in a sentence: the code AND its name, always. Both USDM
 *  ramps are CVD-hostile in the middle, so nothing in this app ever says a
 *  class without saying what it is called (CLAUDE.md).
 *
 *  `null` IS NOT `'none'`. A side the published week could not be read for has
 *  no class at all, and "no drought" about it is a false statement about
 *  drought rather than a missing one. */
function className(level) {
  if (level == null) return 'not known';
  if (level === 'none') return 'no drought';
  return `**${level} · ${USDM_LABELS[level] ?? 'unnamed class'}**`;
}

/** The signed step between two levels, in NDMC's own words. */
function stepLabel(from, to) {
  const d = ord(to) - ord(from);
  if (d === 0) return 'no change';
  return USDM_CHANGE_LABELS[String(d)] ?? `${Math.abs(d)}-class change`;
}

/* ── a region ─────────────────────────────────────────────────────────────── */

/**
 * The brief for one region — a conflict or a one-sided difference.
 *
 * @param {object} region      from js/compare.js
 * @param {object} comparison  the Comparison it came out of; carries `A`/`B`
 * @param {object} [opts]
 * @param {string} [opts.viewerUrl]  `location.origin + location.pathname`
 * @returns {string} markdown
 */
export function buildRegionBrief(region, comparison, { viewerUrl = '' } = {}) {
  const A = comparison?.A ?? null;
  const B = comparison?.B ?? null;
  const week = A?.week ?? B?.week ?? 'an unrecorded week';
  const where = A?.aoi?.name ?? region.aoiId ?? 'the working area';
  const title = region.kind === 'conflict' ? 'Conflict' : 'One-sided difference';

  const L = [];
  L.push(`# ${title} — ${where}, ${week}`);
  L.push('');
  L.push(`Two proposed edits to the US Drought Monitor for **${week}** answer this ` +
    `ground differently. Nothing here has been published, nothing here changes the ` +
    `official map, and this note resolves nothing — it sets out what each side ` +
    `proposed and why, so the two can be talked about together.`);
  L.push('');
  L.push(`- **Finding** \`${region.id}\` (${region.kind})`);
  L.push(`- **Working area** ${where}${region.aoiId ? ` (\`${region.aoiId}\`)` : ''}`);
  L.push(`- **Ground** ${fmtMi2(region.areaKm2)} ${MI2}`);
  L.push(`- **Around** ${coord(region.anchor)}`);
  L.push(`- **Bounding box** ${bboxText(region.bbox)}`);
  L.push(`- **Published class here** ${className(region.published)}`);
  if (viewerUrl) L.push(`- **Open in the viewer** [${region.id}](${focusLink(viewerUrl, region.id)})`);
  L.push('');

  L.push('## What the published map had');
  L.push('');
  L.push(`The week of ${week} put ${className(region.published)} over this ground. ` +
    `Both proposals below are read against that.`);
  L.push('');

  L.push(...sideSection('A', A, region.classA, region.published, region.patchesA, region));
  L.push(...sideSection('B', B, region.classB, region.published, region.patchesB, region));

  L.push('## The disagreement');
  L.push('');
  L.push(`On ${fmtMi2(region.areaKm2)} ${MI2} of ground, ` +
    `${authorName(A)} proposes ${className(region.classA)} ` +
    `(ordinal ${ord(region.classA)}) and ${authorName(B)} proposes ` +
    `${className(region.classB)} (ordinal ${ord(region.classB)}) — a gap of ` +
    `**${region.magnitude} class${region.magnitude === 1 ? '' : 'es'}**. ` +
    (region.kind === 'conflict'
      ? `Neither of them is the published class, so both sides moved this ground.`
      : `${region.changedBy === 'A' ? authorName(B) : authorName(A)} left it as published.`));
  L.push('');

  L.push('## Questions for discussion');
  L.push('');
  for (const q of regionQuestions(region, comparison, A, B)) L.push(`- ${q}`);
  L.push('');

  L.push(...pinLines(A, B));
  return L.join('\n');
}

/** One party's section: who, what they propose, which of their changes did it. */
function sideSection(letter, p, level, published, patchKeys, region) {
  const L = [];
  L.push(`## Side ${letter} — ${authorName(p)}`);
  L.push('');
  if (!p) {
    L.push('This side could not be read.');
    L.push('');
    return L;
  }
  L.push(`- **Author** ${authorLine(p.author)}`);
  if (p.author?.role) L.push(`- **Role** ${p.author.role}`);
  L.push(`- **Proposal** \`${p.id}\``);
  L.push(`- **Proposes here** ${className(level)} — ${stepLabel(published, level)} ` +
    `from the published week`);
  L.push('');

  const patches = (p.patches ?? []).filter((x) => patchKeys.includes(x.key));
  if (!patches.length) {
    L.push(`${authorName(p)} did not propose a change over this ground; it stands as ` +
      `published.`);
    L.push('');
    return L;
  }

  for (const patch of patches) {
    L.push(`### ${patch.name}`);
    L.push('');
    const phrases = (patch.classes ?? []).map((c) => c.phrase).filter(Boolean);
    if (phrases.length) L.push(`${capitalize(prose(phrases))}.`);
    L.push(`- **Classes** ${(patch.classes ?? []).map((c) =>
      `${c.class} (${USDM_LABELS[c.class] ?? 'unnamed class'})`).join(', ') || 'none recorded'}`);
    L.push(`- **Size of the change** ${fmtMi2(patch.areaKm2)} ${MI2}`);
    L.push('');
    /* THE RATIONALE IN FULL, never an excerpt. It is the author's argument, it
       is the reason this brief exists, and a reviewer who is shown half of it
       is being asked to argue against a summary. */
    L.push(patch.rationale?.trim() || '_No rationale was written for this change._');
    L.push('');
  }

  const narrative = relevantParagraphs(p.justification?.rationale, region, patches);
  if (narrative) {
    L.push(`### ${authorName(p)}'s case`);
    L.push('');
    L.push(narrative);
    L.push('');
  }
  if (p.justification?.impacts?.trim()) {
    L.push(`### What ${authorName(p)} says is at stake`);
    L.push('');
    L.push(p.justification.impacts.trim());
    L.push('');
  }
  const evidence = p.justification?.evidence ?? [];
  if (evidence.length) {
    L.push('### Evidence offered');
    L.push('');
    for (const e of evidence) {
      if (e.url) L.push(`- [${e.label ?? e.url}](${e.url})`);
      else if (e.image) L.push(`- ${e.label ?? 'A photograph'} (attached to the proposal)`);
    }
    L.push('');
  }
  /* BORDER NOTES, when this ground reaches the working area's edge. The test
     is arithmetic on two bounding boxes — this module may not touch turf — so
     it is generous: it includes the notes for a region that merely reaches the
     envelope, which costs a reader a paragraph and never hides one. */
  const notes = p.justification?.borderNotes ?? {};
  const keys = Object.keys(notes).sort();
  if (keys.length && touchesEdge(region.bbox, p.aoi?.bbox)) {
    L.push(`### ${authorName(p)}'s notes to the neighbours`);
    L.push('');
    for (const k of keys) {
      if (!String(notes[k] ?? '').trim()) continue;
      L.push(`**${k}** — ${String(notes[k]).trim()}`);
      L.push('');
    }
  }
  return L;
}

/**
 * The paragraphs of a narrative that are ABOUT this ground.
 *
 * A justification argues for a whole proposal and can run to a page; a brief
 * about one 200 mi² region should not reprint the paragraph about the other
 * end of the state. A paragraph is kept when it names one of the classes in
 * play or a proper noun that also appears in one of the touching rationales —
 * which is how the Milk River paragraph follows the Milk River change and the
 * Powder River one does not. When no paragraph matches, THE WHOLE NARRATIVE is
 * printed: a filter that returns nothing has failed, and failing to a
 * complete argument is the safe direction.
 */
function relevantParagraphs(markdown, region, patches) {
  const text = String(markdown ?? '').trim();
  if (!text) return '';
  const paragraphs = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (paragraphs.length < 2) return text;
  const classes = [region.classA, region.classB, region.published].filter((c) => c && c !== 'none');
  const places = new Set();
  for (const patch of patches) {
    for (const m of String(patch.rationale ?? '').matchAll(/\b([A-Z][a-z]{3,})\b/g)) places.add(m[1]);
  }
  const kept = paragraphs.filter((para) =>
    classes.some((c) => para.includes(c)) || [...places].some((w) => para.includes(w)));
  return (kept.length ? kept : paragraphs).join('\n\n');
}

/**
 * Three to five questions, CHOSEN BY CASE.
 *
 * A fixed list of questions is a list nobody reads twice. These are picked
 * from the facts of the finding in a fixed priority order, so the same finding
 * always produces the same questions and two different findings rarely produce
 * the same ones.
 */
function regionQuestions(region, comparison, A, B) {
  const qs = [];
  const nameA = authorName(A), nameB = authorName(B);

  if (comparison?.sameAuthor) {
    qs.push(`These two files are by the same author. Treat them as two drafts rather ` +
      `than two opinions: which is the later reading, and should the earlier one be ` +
      `withdrawn?`);
  }
  if (region.magnitude >= 2) {
    qs.push(`This is a ${region.magnitude}-class gap between two readings of one week. ` +
      `A gap that size is rarely a difference of judgement — is one side reading a ` +
      `different indicator, a different period, or a different piece of ground?`);
  }
  if (region.kind === 'conflict' && region.directionA !== region.directionB) {
    qs.push(`Both sides moved this ground and moved it in OPPOSITE directions: ` +
      `${nameA} ${wordFor(region.directionA)} and ${nameB} ${wordFor(region.directionB)}. ` +
      `What does each side weight, and over what window?`);
    qs.push(`Is the disagreement about the ground or about the period — does one side ` +
      `read the last 30 days and the other the last 90?`);
  } else if (region.kind === 'conflict') {
    qs.push(`Both sides moved this ground the same way and disagree about how far. ` +
      `Is that a difference of degree the two could settle on one class?`);
  } else {
    const mover = region.changedBy === 'A' ? nameA : nameB;
    const stayer = region.changedBy === 'A' ? nameB : nameA;
    qs.push(`${stayer} left this ground as published. Was that deliberate, or is it ` +
      `ground they did not look at?`);
    qs.push(`Does ${mover}'s case for this change apply to the rest of the working area, ` +
      `or is this ground particular?`);
  }

  const host = sharedEvidenceHost(A, B);
  if (host) {
    qs.push(`Both sides cite **${host}**. Are they reading the same product differently, ` +
      `or different products from the same source?`);
  }
  for (const p of [A, B]) {
    if (p?.integrity?.grade === 'defect') {
      qs.push(`${authorName(p)}'s package does not re-check cleanly against itself. ` +
        `That is worth settling before the geometry is argued about.`);
    }
  }
  if (qs.length < 3) {
    qs.push(`What would settle this on the ground — a station record, a stream gauge, ` +
      `a field visit, or a look at last week's map?`);
  }
  return qs.slice(0, 5);
}

function wordFor(direction) {
  return direction === 'grew' ? 'made it worse' : direction === 'shrank' ? 'made it better' : 'left it';
}

/** The evidence host both sides cite, if there is exactly one worth naming. */
function sharedEvidenceHost(A, B) {
  const hosts = (p) => new Set((p?.justification?.evidence ?? [])
    .map((e) => hostOf(e.url)).filter(Boolean));
  const a = hosts(A), b = hosts(B);
  const both = [...a].filter((h) => b.has(h)).sort();
  return both[0] ?? null;
}

/** `https://drought.gov/x` → `drought.gov`. No `URL`, which is a browser and
 *  Node global this module does not need to depend on. */
function hostOf(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url ?? ''));
  return m ? m[1].replace(/^www\./i, '') : null;
}

/* ── a seam ───────────────────────────────────────────────────────────────── */

/**
 * The brief for one seam — a step along a shared working-area border.
 *
 * @param {object} seam  from js/seams.js
 * @param {object} [opts]
 * @param {string} [opts.viewerUrl]
 * @returns {string} markdown
 */
export function buildSeamBrief(seam, { viewerUrl = '' } = {}) {
  const A = seam.sideA?.proposal ?? null;
  const B = seam.sideB?.proposal ?? null;
  const week = A?.week ?? B?.week ?? 'an unrecorded week';
  const nameA = seam.sideA?.aoi?.name ?? seam.aoiIds[0] ?? 'one side';
  const nameB = seam.sideB?.aoi?.name ?? seam.aoiIds[1] ?? 'the other side';

  const L = [];
  L.push(`# Seam — ${nameA} / ${nameB}, ${week}`);
  L.push('');
  L.push(`A class boundary runs along the ${nameA} / ${nameB} line in the proposals for ` +
    `**${week}**. Drought does not stop at a jurisdiction, so a step that appears at one ` +
    `is a step two people drew from two sides. Nothing here has been published.`);
  L.push('');
  /* NOTHING IS KNOWN ABOUT A STEP WHOSE FAR SIDE COULD NOT BE READ, and a
     brief that prints "0 mi · 0 classes" for one has stated the opposite: it
     reads as "we looked and there is no step". A run carries a null `step`
     exactly when its far side is unknown, so every run being null IS the
     unreadable seam, and the two bullets say so in words. */
  const nothingKnown = seam.runs.length > 0 && seam.runs.every((r) => r.step == null);
  L.push(`- **Finding** \`${seam.id}\` (seam)`);
  /* THE ANALYSED LINE IS NOT THE BORDER when the neighbour is a jurisdiction
     nobody loaded: it is the loaded author's own edge effects toward it, and
     this app has no ring for the far side to measure the rest against
     (js/seams.js `sharedKm`). */
  if (seam.sharedKm != null) L.push(`- **Shared boundary** ${fmtMi(seam.sharedKm)} mi`);
  else {
    L.push(`- **Line analysed** ${fmtMi(seam.lengthKm)} mi — the loaded side's own edge ` +
      `effects toward this neighbour, not the whole shared border, which is not known ` +
      `here because no proposal is loaded for the far side`);
  }
  L.push(`- **Newly stepped** ${nothingKnown ? 'not known' : `${fmtMi(seam.newStepKm)} mi`}`);
  L.push(`- **Largest step** ${nothingKnown ? 'not known'
    : `${seam.maxStep} class${seam.maxStep === 1 ? '' : 'es'}`}`);
  L.push(`- **Reciprocal** ${seam.reciprocal ? 'yes' : 'no'}`);
  if (seam.anchor) L.push(`- **Around** ${coord(seam.anchor)}`);
  if (viewerUrl) L.push(`- **Open in the viewer** [${seam.id}](${focusLink(viewerUrl, seam.id)})`);
  L.push('');

  L.push('## The line');
  L.push('');
  const shown = seam.runs.filter((r) => r.kind !== 'pre-existing');
  if (shown.length) {
    L.push(`| Stretch | ${nameA} | ${nameB} | Published | Step | Length |`);
    L.push('|---|---|---|---|---|---|');
    for (const r of shown) {
      L.push(`| ${r.kind} | ${plain(r.classA)} | ${plain(r.classB)} | ` +
        `${plain(r.publishedA)} / ${plain(r.publishedB)} | ` +
        `${r.step == null ? 'not known' : signed(r.step)} | ${fmtMi(r.lengthKm)} mi |`);
    }
  } else {
    L.push('_Nothing along this line changed._');
  }
  L.push('');
  const preExisting = seam.runs.filter((r) => r.kind === 'pre-existing')
    .reduce((a, r) => a + r.lengthKm, 0);
  if (preExisting > 0) {
    L.push(`A further ${fmtMi(preExisting)} mi of this border already carried the step ` +
      `it carries now, and neither proposal touched it.`);
    L.push('');
  }

  L.push(...seamSide('A', seam.sideA, seam.sideB, seam));
  L.push(...seamSide('B', seam.sideB, seam.sideA, seam));

  const worst = [...seam.runs]
    .filter((r) => ['new', 'widened'].includes(r.kind))
    .sort((x, y) => Math.abs(y.step ?? 0) - Math.abs(x.step ?? 0) || y.lengthKm - x.lengthKm)[0];
  if (worst) {
    L.push('## The disjuncture');
    L.push('');
    L.push(`Over ${fmtMi(worst.lengthKm)} mi the ${nameA} side reads ` +
      `${className(worst.classA)} and the ${nameB} side ${className(worst.classB)} — ` +
      `${Math.abs(worst.step)} class${Math.abs(worst.step) === 1 ? '' : 'es'} apart across ` +
      `the line, where the published week had ` +
      `${worst.publishedStep === 0 ? 'no step at all'
        : `a step of ${Math.abs(worst.publishedStep)}`}.`);
    L.push('');
  }

  const effects = seam.edgeEffects ?? [];
  if (effects.length) {
    L.push('## What each author said about this border');
    L.push('');
    for (const e of effects) {
      L.push(`- **${e.name ?? 'A change'}** (side ${e.side}) — ${e.statement ?? ''}`);
    }
    L.push('');
  }
  for (const side of ['A', 'B']) {
    const note = seam.borderNotes?.[side];
    if (!note) continue;
    const who = side === 'A' ? authorName(A) : authorName(B);
    L.push(`### ${who}'s note for this border`);
    L.push('');
    L.push(note.trim());
    L.push('');
  }

  L.push('## Questions for discussion');
  L.push('');
  for (const q of seamQuestions(seam, nameA, nameB, A, B)) L.push(`- ${q}`);
  L.push('');
  L.push(...pinLines(A, B));
  return L.join('\n');
}

function seamSide(letter, side, other, seam) {
  const L = [];
  const place = side?.aoi?.name ?? seam.aoiIds[letter === 'A' ? 0 : 1] ?? 'this side';
  L.push(`## Side ${letter} — ${place}`);
  L.push('');
  if (side?.kind === 'published') {
    L.push(`No proposal is loaded for ${place}, so this side of the line is the ` +
      `published week as NDMC shipped it.`);
    L.push('');
    return L;
  }
  if (side?.kind !== 'proposal') {
    L.push(`No proposal is loaded for ${place} and the published week could not be ` +
      `read, so this side of the line is unknown. Everything above describes the ` +
      `other side only.`);
    L.push('');
    return L;
  }
  const p = side.proposal;
  L.push(`- **Author** ${authorLine(p.author)}`);
  if (p.author?.role) L.push(`- **Role** ${p.author.role}`);
  L.push(`- **Proposal** \`${p.id}\``);
  L.push('');
  const mine = (seam.edgeEffects ?? []).filter((e) => e.proposalId === p.id);
  if (mine.length) {
    for (const e of mine) L.push(`${e.statement ?? ''}`);
    L.push('');
  } else {
    L.push(`${authorName(p)} recorded no change running along this border.`);
    L.push('');
  }
  return L;
}

function seamQuestions(seam, nameA, nameB, A, B) {
  const qs = [];
  if (seam.maxStep >= 2) {
    qs.push(`This is a ${seam.maxStep}-class step at a jurisdiction line, and a step ` +
      `that size at a state or reservation boundary is almost never physical. Which ` +
      `side is wrong — or is the truth a one-class step somewhere between them?`);
  }
  if (seam.isNew) {
    qs.push(`The published week had no step here at all. Did each author know what the ` +
      `other was drawing along this line?`);
  }
  if (seam.reciprocal) {
    qs.push(`Both ${nameA} and ${nameB} have a proposal in front of the authors. Can the ` +
      `two agree a single line, or does the difference reflect real data that stops at ` +
      `the border?`);
  } else {
    qs.push(`Only ${A ? nameA : nameB} has a proposal loaded. Is anyone drawing ` +
      `${A ? nameB : nameA} this week, and have they seen this?`);
  }
  if (!seam.borderNotes?.A && !seam.borderNotes?.B) {
    qs.push(`Neither author wrote a note for this border. Would one have caught this ` +
      `before it reached a reviewer?`);
  }
  if (qs.length < 3) {
    qs.push(`What is on the ground within ten miles of this line, and does it change ` +
      `across it?`);
  }
  return qs.slice(0, 5);
}

/* ── the whole session ────────────────────────────────────────────────────── */

/**
 * One document for the whole comparison: the index, then every brief.
 *
 * The "Not compared" section is the part that earns its place. A reviewer who
 * reads a list of findings assumes the list is complete; it is complete only
 * over the proposals that loaded, the neighbours that loaded and the sides
 * that could be read, and saying so is the difference between a report and a
 * claim.
 *
 * ── THE INDEX IS THE SESSION'S OWN RANKED LIST ────────────────────────────
 * `opts.findings` is the list js/app.js already holds — `resolveFindingIds`
 * over `rankFindings` — and it is passed in rather than rebuilt here for two
 * reasons. It is the ONE list: an index built by walking the comparisons is a
 * second traversal in comparison order, which is three descending runs rather
 * than one rank, and it repeats a region that more than one comparison can
 * reach. And the rank itself belongs to the engine (`rankRegions`,
 * `rankSeams`), which lives behind turf — this module may not import it, and a
 * comparator copied in here is a copy that drifts.
 *
 * Without it the index falls back to the comparisons' own regions, DEDUPED BY
 * ID and in kind order: unique and complete, but only as ranked as the caller
 * left them.
 *
 * @param {object} session
 * @param {object[]} comparisons
 * @param {object[]} seams
 * @param {object} [opts]
 * @param {string} [opts.viewerUrl]  every index row links back through it
 * @param {object[]} [opts.findings] the session's resolved, ranked findings
 */
export function buildSessionBrief(session, comparisons = [], seams = [], {
  viewerUrl = '', findings = null,
} = {}) {
  const proposals = session.list();
  const week = session.week() ?? 'an unrecorded week';
  const L = [];

  /**
   * A working area's NAME, from anything in this session that knows one.
   *
   * The index's "Where" column and the "Not compared" sentences printed raw ids
   * — `aiannh:00806896-86`, `state:MT` — into a document written for people in
   * a meeting. Every loaded proposal carries `aoi.name`, and a neighbour nobody
   * loaded carries one too: `edgeEffects[].neighborNames` is parallel to
   * `neighborIds`, which is where the author's own editor got the name from.
   * The id is kept only when nothing in the session ever named it.
   */
  const aoiNames = new Map();
  for (const p of proposals) {
    if (p.aoi?.id && p.aoi?.name) aoiNames.set(p.aoi.id, p.aoi.name);
    for (const e of p.edgeEffects ?? []) {
      (e.neighborIds ?? []).forEach((id, i) => {
        const name = e.neighborNames?.[i];
        if (id && name && !aoiNames.has(id)) aoiNames.set(id, name);
      });
    }
  }
  const areaName = (id) => aoiNames.get(id) ?? id ?? 'an unnamed area';

  L.push(`# Proposed USDM edits for ${week} — where they disagree`);
  L.push('');
  L.push(`${proposals.length} proposal${proposals.length === 1 ? '' : 's'} for the week of ` +
    `**${week}**, compared against each other and against the week they were all drawn on. ` +
    `Nothing here has been published and nothing here changes the official map.`);
  L.push('');

  L.push('## The proposals');
  L.push('');
  L.push('| Working area | Author | Role | Changes | Re-check |');
  L.push('|---|---|---|---|---|');
  for (const p of proposals) {
    L.push(`| ${p.aoi?.name ?? p.aoi?.id ?? '—'} | ${authorName(p)} | ${p.author?.role ?? '—'} | ` +
      `${p.patches.length} | ${gradeWord(p)} |`);
  }
  L.push('');

  /* ONE LIST, ONE RUN, ONE ROW PER FINDING — the index below and the briefs
     under the rules are the same list read twice, so a `?focus=` link in the
     index and the brief it names cannot disagree. */
  const ranked = rankedFindings(findings, comparisons, seams);
  const conflicts = ranked.filter((f) => f.kind === 'conflict');
  const oneSided = ranked.filter((f) => f.kind === 'one-sided');
  const lines = ranked.filter((f) => f.kind === 'seam');
  L.push('## What was found');
  L.push('');
  L.push(`- **${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}** — two ` +
    `proposals changing the same ground to different classes`);
  L.push(`- **${oneSided.length} one-sided difference${oneSided.length === 1 ? '' : 's'}** — ` +
    `one changed it, the other left it as published`);
  L.push(`- **${lines.length} seam${lines.length === 1 ? '' : 's'}** — a step along a shared ` +
    `working-area border`);
  L.push('');

  if (conflicts.length || oneSided.length) {
    L.push('### Ground');
    L.push('');
    L.push('| Finding | Where | Disagreement | Ground |');
    L.push('|---|---|---|---|');
    for (const r of [...conflicts, ...oneSided]) {
      L.push(`| ${idCell(r.id, viewerUrl)} | ${areaName(r.aoiId)} | ${plain(r.classA)} vs ${plain(r.classB)} ` +
        `(published ${plain(r.published)}) | ${fmtMi2(r.areaKm2)} ${MI2} |`);
    }
    L.push('');
  }
  if (lines.length) {
    L.push('### Borders');
    L.push('');
    L.push('| Finding | Line | Largest step | Newly stepped |');
    L.push('|---|---|---|---|');
    for (const s of lines) {
      const known = !(s.runs ?? []).length || !s.runs.every((r) => r.step == null);
      L.push(`| ${idCell(s.id, viewerUrl)} | ${s.aoiIds.map(areaName).join(' / ')} | ` +
        `${known ? s.maxStep : 'not known'} | ` +
        `${known ? `${fmtMi(s.newStepKm)} mi` : 'not known'} |`);
    }
    L.push('');
  }

  L.push('## Not compared');
  L.push('');
  const gaps = [];
  const loaded = new Set(proposals.map((p) => p.aoi?.id));
  const unloaded = new Set();
  for (const p of proposals) {
    for (const e of p.edgeEffects) {
      for (const id of e.neighborIds ?? []) if (!loaded.has(id)) unloaded.add(id);
    }
  }
  if (unloaded.size) {
    gaps.push(`No proposal is loaded for ${prose([...unloaded].map(areaName).sort())}, so the far side ` +
      `of any seam toward ${unloaded.size === 1 ? 'it' : 'them'} is the published week ` +
      `rather than somebody's reading of it.`);
  }
  const unknownSides = lines.filter((s) => s.sideA?.kind === 'unknown' || s.sideB?.kind === 'unknown');
  if (unknownSides.length) {
    gaps.push(`${unknownSides.length} seam${unknownSides.length === 1 ? ' has' : 's have'} a ` +
      `side the published week could not be read for; those are reported with one side only.`);
  }
  const singletons = [...new Set(proposals.map((p) => p.aoi?.id))]
    .filter((id) => proposals.filter((p) => p.aoi?.id === id).length === 1)
    .map(areaName).sort();
  if (singletons.length) {
    gaps.push(`${prose(singletons)} ${singletons.length === 1 ? 'has' : 'have'} only one ` +
      `proposal loaded, so there is nothing to compare ${singletons.length === 1 ? 'it' : 'them'} ` +
      `against inside ${singletons.length === 1 ? 'its' : 'their'} own boundary.`);
  }
  if (!gaps.length) gaps.push('Every loaded proposal was compared against every other one over the ground they share.');
  for (const g of gaps) L.push(`- ${g}`);
  L.push('');

  /* THE SAME RANKED LIST AGAIN, so the document reads in the order its own
     index does. A region's comparison is found BY ITS PAIR and never by its
     id: the id is a hash of a key, and looking a finding up by the thing it
     hashes to is how both sides of a brief went missing (the pair is what
     `buildRegionBrief` needs, and a finding carries it). */
  for (const f of ranked) {
    L.push('---');
    L.push('');
    L.push(f.kind === 'seam'
      ? buildSeamBrief(f, { viewerUrl })
      : buildRegionBrief(f, comparisonFor(f, comparisons), { viewerUrl }));
    L.push('');
  }
  return L.join('\n');
}

/* ── the session's one list ───────────────────────────────────────────────── */

/**
 * The findings a session brief indexes and then prints — one row each, in the
 * caller's rank order.
 *
 * The caller (js/app.js `sessionBrief`, tools/compare.test.mjs) passes the
 * session's resolved, ranked list, which is the whole point: it is the list the
 * drawer shows and the list every `?focus=` link in this document names. The
 * fallback walks the comparisons instead, which is unique and complete but
 * only as ordered as they were.
 *
 * Either way it DEDUPES BY ID. Two runs of the same region through one document
 * is how the index came to list one id twice with two different areas.
 */
export function rankedFindings(findings, comparisons = [], seams = []) {
  const list = Array.isArray(findings) && findings.length
    ? findings
    : [...comparisons.flatMap((c) => c.regions ?? []).filter((r) => r.kind === 'conflict'),
      ...comparisons.flatMap((c) => c.regions ?? []).filter((r) => r.kind === 'one-sided'),
      ...seams];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!f?.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * The comparison a region came out of, BY THE PAIR IT NAMES.
 *
 * Never by the region's id: an id is a hash, a session may widen one, and a
 * lookup that misses hands `buildRegionBrief` two nulls, which prints "an
 * unnamed author" twice and "This side could not be read" — a brief with the
 * argument taken out of it. The pair is two proposal ids the region carries
 * verbatim and every comparison states in `pair`, and each pair is compared
 * exactly once (js/compare.js `compareGroup`).
 */
export function comparisonFor(region, comparisons = []) {
  return comparisons.find((c) =>
    c?.pair?.[0] === region?.proposalA && c?.pair?.[1] === region?.proposalB)
    ?? comparisons.find((c) => (c?.regions ?? []).includes(region))
    ?? null;
}

/** A finding id in a table cell, linked back to the viewer when there is one. */
function idCell(id, viewerUrl) {
  return viewerUrl ? `[\`${id}\`](${focusLink(viewerUrl, id)})` : `\`${id}\``;
}

/* ── shared bits ──────────────────────────────────────────────────────────── */

/**
 * The pin lines the vendored `buildEdgeBrief` closes on: which archive bytes
 * this is all about. A proposal that does not pin its baseline cannot be
 * reproduced, and a brief that does not repeat the pin cannot be checked.
 */
function pinLines(...proposals) {
  const seen = new Map();
  for (const p of proposals) {
    if (p?.baselineSha256) seen.set(p.baselineSha256, p);
  }
  const L = ['---', ''];
  if (!seen.size) {
    L.push('Neither proposal pins the archive bytes it was drawn against, so the exact ' +
      'baseline cannot be reproduced.');
    L.push('');
    return L;
  }
  for (const [sha, p] of [...seen.entries()].sort()) {
    L.push(`Drawn against the published archive file for ${p.week}, pinned by ` +
      `\`sha256:${sha}\`. A proposal that does not pin its baseline cannot be reproduced.`);
    L.push('');
  }
  if (seen.size > 1) {
    L.push('**The two sides pin different bytes for the same week.** Small differences ' +
      'along shared edges may be the baseline rather than the proposal.');
    L.push('');
  }
  return L;
}

function focusLink(viewerUrl, id) {
  const sep = viewerUrl.includes('?') ? '&' : '?';
  return `${viewerUrl}${sep}focus=${encodeURIComponent(id)}`;
}

function authorName(p) {
  return p?.author?.name ?? 'an unnamed author';
}

/** The vendored `buildEdgeBrief`'s author line, to the letter: who first, on
 *  whose behalf second, the email last. */
function authorLine(author) {
  if (!author) return '(not recorded)';
  const bits = [author.name, author.affiliation].filter((s) => typeof s === 'string' && s.trim());
  let who = bits.length ? bits.join(', ') : '(not recorded)';
  if (typeof author.onBehalfOf === 'string' && author.onBehalfOf.trim()) {
    who += ` (on behalf of ${author.onBehalfOf.trim()})`;
  }
  return author.email ? `${who} <${author.email}>` : who;
}

function gradeWord(p) {
  const g = p?.integrity?.grade;
  if (g === 'pass') return 'agrees with itself';
  if (g === 'residue') return 'agrees to within clipper residue';
  if (g === 'defect') return '**problems — see the proposal card**';
  return 'not re-checked';
}

/** A class code with no markup, for a table cell. `null` is a side that was
 *  never read and says so; `'none'` is ground inside a working area with no
 *  drought on it. A dash used to stand for both. */
function plain(level) {
  return level == null ? 'not known' : level === 'none' ? 'none' : level;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

function coord(point) {
  if (!point) return 'not recorded';
  const [lng, lat] = point;
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ` +
    `${Math.abs(lng).toFixed(3)}° ${lng >= 0 ? 'E' : 'W'}`;
}

function bboxText(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return 'not recorded';
  return `${bbox.map((n) => n.toFixed(3)).join(', ')} (west, south, east, north)`;
}

/** Does this region's box reach the working area's? Arithmetic only — this
 *  module may not touch turf, and a generous answer costs a paragraph. */
function touchesEdge(bbox, aoiBbox) {
  if (!Array.isArray(bbox) || !Array.isArray(aoiBbox)) return false;
  const eps = 0.02;                       // ~2 km, the scale an edge effect runs at
  return Math.abs(bbox[0] - aoiBbox[0]) < eps || Math.abs(bbox[1] - aoiBbox[1]) < eps
    || Math.abs(bbox[2] - aoiBbox[2]) < eps || Math.abs(bbox[3] - aoiBbox[3]) < eps;
}

function capitalize(s) {
  return typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s;
}
