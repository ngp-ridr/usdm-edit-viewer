/* ============================================================================
   USDM Edit Viewer · js/cards.js
   The detail card: a proposal, a change, a finding, a seam. docs/contracts.md
   § 11.

     const cards = createCards(els, ctx);
     cards.showProposal(p);
     cards.showChange(p, patchKey);
     cards.showFinding(region);
     cards.showSeam(seam);

   ── WHAT THE CARD IS FOR ───────────────────────────────────────────────────
   A finding card is the whole argument of this app in one panel: two authors,
   two answers about one piece of ground, each with the reasoning its author
   actually wrote, side by side. Reading them one after the other asks the
   reader to hold the first in their head while they read the second — which is
   exactly the thing they came here to compare. That is why the card is wider
   than the editor's (min(28rem, 42vw), css/app.css § 7) and why `.side-by-side`
   is a grid rather than a stack.

   It docks BESIDE the map, never over it: `aria-modal="false"` is the truth,
   the map stays live, and the ground the card is about is still on screen. The
   kit's `initDetailCard` owns Escape and returns focus to whatever opened it.

   ── THE RULES THIS FILE IS WRITTEN AGAINST ─────────────────────────────────
   · NO INLINE `style`. Everything is `el()` from the vendored js/dom.js, which
     throws on one; swatches are CSSOM writes.
   · A USDM COLOUR NEVER APPEARS WITHOUT ITS CLASS NAME — `classSwatch` and
     `classPhrase` come from js/panels.js so the pair is written once.
   · MILES ON SCREEN. `fmtMi2`/`fmtMi` from the vendored js/units.js, every
     sentence and every table cell. The objects keep km²; nothing here prints
     one.
   · PROSE IS MARKDOWN and goes through the vendored `renderMarkdown`, which
     returns a SANITIZED fragment. Squire is lazy and `.catch`-guarded there, so
     a read-only render never loads an editor.
   · EVIDENCE IMAGES ARE GATED by `isImageDataURL` — `data:` only, never
     `https:`, which `img-src` would refuse and which would make an emailed
     proposal a beacon.
   · NO TWO CONTROLS ON SCREEN MAY HAVE NAMES WHERE ONE CONTAINS THE OTHER
     (the editor's § 9f rule). The drawer and the navbar count as on screen, so
     every button here is named with something the drawer never says: "Zoom to
     Change 2 (Reyes)", "Show me problem 1 of 2", "Conflict 1 of 3".

   Sections: helpers · proposal · change · finding · seam
   ========================================================================== */

import { button, el, hint } from '../vendor/usdm-editor/js/dom.js';
import { renderMarkdown } from '../vendor/usdm-editor/js/mdtext.js';
import { isImageDataURL } from '../vendor/usdm-editor/js/image.js';
import { renderDeltaTable } from '../vendor/usdm-editor/js/submit.js';
import { prose } from '../vendor/usdm-editor/js/changes.js';
import { fmtMi, fmtMi2, MI2 } from '../vendor/usdm-editor/js/units.js';
import { USDM_CHANGE_LABELS } from '../vendor/usdm-editor/js/color.js';
import { classPhrase, classSwatch, surnameOf } from './panels.js';
import { normalizeRecheck } from './recheck.js';
import { copyBrief, downloadBrief } from './export.js';

/** The editor's own sentence, verbatim — the two apps report the same numbers. */
const AREAS_HINT =
  'Areas in square miles. Each class is counted without the severer classes inside it.';

/* ── small builders ───────────────────────────────────────────────────────── */

/** A titled block. `.card-block > h3` is the kit's eyebrow (css/app.css § 7). */
function cardBlock(title, ...kids) {
  const body = kids.filter((k) => k != null);
  if (!body.length) return null;
  return el('div', { class: 'card-block' }, el('h3', {}, title), ...body);
}

/**
 * Rendered markdown, in a box.
 *
 * It carries the kit's own `.info-section` prose class alongside `.md-block`,
 * so paragraphs, lists, links and code get the house treatment rather than a
 * second set of rules in css/app.css.
 */
function mdBlock(md) {
  const text = typeof md === 'string' ? md.trim() : '';
  if (!text) return null;
  const box = el('div', { class: 'md-block info-section' });
  box.append(renderMarkdown(text));
  return box;
}

/** `a, b and c`, from anything with a `phrase`. */
function phrasesOf(patch) {
  return prose((patch?.classes ?? []).map((c) => c.phrase).filter(Boolean));
}

/* ══ the cards ══════════════════════════════════════════════════════════════ */

/**
 * @param {object} els js/app.js's element map (`cardTitle`, `cardContent`)
 * @param {object} ctx docs/contracts.md § 12
 * @param {{onZoom?:Function, onOpenFinding?:Function, onOpenChange?:Function}}
 *        [handlers] optional overrides; the `ctx` route is the default
 */
export function createCards(els, ctx, handlers = {}) {
  /** What the card is showing, so a re-render of the same thing is a no-op. */
  let showing = null;

  function open(title, nodes) {
    if (els?.cardTitle) els.cardTitle.textContent = title;
    if (els?.cardContent) els.cardContent.replaceChildren(...nodes.filter((n) => n != null));
    ctx?.card?.open?.();
  }

  function focus(target) {
    if (typeof handlers.onZoom === 'function') handlers.onZoom(target);
    else ctx?.focus?.(target);
  }

  function markOf(p) {
    if (typeof ctx?.markFor === 'function') return ctx.markFor(p?.id);
    return ctx?.marks?.get?.(p?.id) ?? null;
  }

  function letterOf(p) { return markOf(p)?.letter ?? '?'; }

  /* ── § 1. A proposal ───────────────────────────────────────────────────── */

  /**
   * One author's whole submission: who, what they re-checked as, what they
   * argued, what they changed, and what it touches at the borders.
   */
  function showProposal(p) {
    if (!p) return;
    showing = { kind: 'proposal', id: p.id };
    const j = p.justification ?? {};
    const nChanges = p.patches?.length ?? 0;

    const nodes = [
      el('p', { class: 'card-lede' }, [
        p.aoi?.name ?? p.aoi?.id ?? 'an unnamed working area',
        p.week ? `week ${p.week}` : null,
        `${nChanges} change${nChanges === 1 ? '' : 's'}`,
        p.created ? `created ${new Date(p.created).toLocaleDateString()}` : null,
      ].filter(Boolean).join(' · ')),

      authorBlock(p),
      recheckBlock(p),
      cardBlock('Why', mdBlock(j.rationale)),
      cardBlock('Impacts', mdBlock(j.impacts)),
      evidenceBlock(j.evidence),
      changesBlock(p),
      deltaBlock(p),
      edgeEffectsBlock(p),
      borderNotesBlock(p),
      heuristicBlock(p),
      provenance(p),
    ];
    open(`${letterOf(p)} · ${p.author?.name ?? 'An unnamed author'}`, nodes);
  }

  /** Who wrote it, and how to reach them. The email is a real `mailto:`. */
  function authorBlock(p) {
    const a = p.author ?? {};
    const lines = [
      a.role ? el('p', {}, a.role) : null,
      a.affiliation ? el('p', {}, a.affiliation) : null,
      a.onBehalfOf ? el('p', {}, `On behalf of ${a.onBehalfOf}`) : null,
      /* A navigation, not a fetch: `mailto:` needs no CSP change, and an
         anchor keeps middle-click and "copy address" working. */
      a.email ? el('p', {}, el('a', { href: `mailto:${a.email}` }, a.email)) : null,
    ].filter(Boolean);
    if (!lines.length) return null;
    return cardBlock(a.name ?? 'Author', ...lines);
  }

  /**
   * The re-check verdict — and, when something really failed, where.
   *
   * A `residue` grade is NOT a warning: ten of the twelve bundled proposals
   * grade residue, and painting those amber would tell a reviewer nothing. Only
   * a defect gets the problem list and the "Show me" buttons.
   */
  function recheckBlock(p) {
    let r = null;
    try {
      r = normalizeRecheck(p?.recheck ?? p?.integrity ?? null);
    } catch (err) {
      console.warn('[viewer] re-check failed', err);
    }
    if (!r) return null;
    const verdict = el('p', { class: `recheck-line${r.grade === 'defect' ? ' is-defect' : ''}` },
      r.sentence);
    if (r.grade !== 'defect') return cardBlock('Re-check', verdict);

    const n = r.problems.length;
    const list = el('ol', { class: 'evidence-list' });
    r.problems.forEach((problem, i) => {
      const row = el('li', {}, problem.message);
      if (problem.geometry) {
        /* "Show me problem 1 of 12" rather than a row of identical "Show me"s:
           a name has to say which one, and "problem 1" alone is a prefix of
           "problem 10". */
        const b = button('Show me', () => focus(problem.geometry));
        b.setAttribute('aria-label', `Show me problem ${i + 1} of ${n}`);
        row.append(' ', b);
      }
      list.append(row);
    });
    return cardBlock('Re-check', verdict, list);
  }

  /** `{url, label}` anchors and `{image, label}` thumbnails, gated. */
  function evidenceBlock(evidence) {
    const rows = (evidence ?? []).map((e) => {
      if (e?.url) {
        return el('li', {}, el('a', { href: e.url, rel: 'noopener', target: '_blank' },
          e.label || e.url));
      }
      /* THE ONE IMAGE GATE. `data:` only — an `https:` src would be refused by
         `img-src` and would turn an emailed proposal into a beacon. A refused
         image keeps its label as text, which is the honest degradation. */
      if (e?.image && isImageDataURL(e.image)) {
        /* The label is the CAPTION and it is on screen, so the image's own alt
           is empty: an alt that repeats the sentence beside it makes a screen
           reader say the same thing twice (axe `image-redundant-alt`). With no
           caption to read, the alt is the only channel and carries the label. */
        return el('li', {},
          el('img', { class: 'evidence-thumb', src: e.image, alt: e.label ? '' : 'Evidence image' }),
          e.label ? el('span', {}, e.label) : null);
      }
      if (e?.label) return el('li', {}, e.label);
      return null;
    }).filter(Boolean);
    if (!rows.length) return null;
    return cardBlock('Evidence', el('ul', { class: 'evidence-list' }, ...rows));
  }

  /** Every patch, with its phrases, its size, its rationale and a way there. */
  function changesBlock(p) {
    const items = (p.patches ?? []).map((patch) => {
      const b = button('Zoom', () => focus(patch.geometry ?? patch.bbox));
      b.setAttribute('aria-label', `Zoom to ${patch.name} (${surnameOf(p.author)})`);
      return el('li', {},
        el('div', { class: 'card-item' },
          el('p', {}, el('strong', {}, patch.name ?? 'A change'),
            ' — ', `${fmtMi2(patch.areaKm2 ?? 0)} ${MI2}`),
          phrasesOf(patch) ? el('p', {}, phrasesOf(patch)) : null,
          mdBlock(patch.rationale),
          el('div', { class: 'row' }, b)));
    });
    if (!items.length) return null;
    return cardBlock('Changes', el('ol', { class: 'evidence-list' }, ...items));
  }

  /** The before/after table, the editor's own renderer. */
  function deltaBlock(p) {
    const rows = (p.changes ?? []).filter((r) =>
      r && r.areaKm2 && typeof r.areaKm2.before === 'number' && r.parts);
    if (!rows.length) return null;
    return cardBlock('Class areas', renderDeltaTable(rows), hint(AREAS_HINT));
  }

  /** What this proposal does at somebody else's border. */
  function edgeEffectsBlock(p) {
    const rows = (p.edgeEffects ?? []).map((e) => el('li', {},
      e.statement ?? `${e.name ?? 'A change'} reaches ${e.neighborNames?.[0] ?? 'a neighbour'}.`));
    if (!rows.length) return null;
    return cardBlock('At the borders', el('ul', { class: 'evidence-list' }, ...rows));
  }

  /** The author's own note to each neighbour, as they wrote it. */
  function borderNotesBlock(p) {
    const notes = p.justification?.borderNotes ?? {};
    const kids = Object.entries(notes).flatMap(([id, md]) => {
      const body = mdBlock(md);
      return body ? [el('p', {}, el('strong', {}, nameForAoi(id))), body] : [];
    });
    if (!kids.length) return null;
    return cardBlock('Notes to neighbours', ...kids);
  }

  /** A neighbour's name, from the session if it is loaded, else its id. */
  function nameForAoi(aoiId) {
    for (const q of ctx?.proposals ?? []) if (q?.aoi?.id === aoiId) return q.aoi.name;
    return aoiId;
  }

  /**
   * The change-magnitude check, as a RESULT rather than as the absence of a
   * warning — ported from the editor's js/wizard.js `heuristicBlock`.
   *
   * "No warning" and "no check" are different claims and only one of them is
   * reassuring: the earliest week in the archive has no previous week, and a
   * previous week that would not download is a check that never ran.
   *
   * Nothing is said when the parsed proposal carries no `heuristic` at all —
   * that is a fact about this app's parse, not about the author's file, and
   * inventing "the check did not run" would be a lie about a check that did.
   */
  function heuristicBlock(p) {
    const h = p?.heuristic ?? null;
    if (!h) return null;
    if (h.skipped) {
      return cardBlock('Change magnitude', hint(h.skipped === 'no-prior-week'
        ? 'The change-magnitude check could not run — this is the earliest week in ' +
          'the archive, so there is no previous week to compare against.'
        : 'The change-magnitude check could not run — the previous week’s data ' +
          'could not be loaded.'));
    }
    if (h.flagged) {
      const b = button('Show me', () => focus(h.geometry));
      b.setAttribute('aria-label', 'Show me the flagged change magnitude');
      return cardBlock('Change magnitude',
        el('p', { class: 'recheck-line is-defect' }, h.message), b);
    }
    return cardBlock('Change magnitude', hint(h.message ?? 'The change-magnitude check did not run.'));
  }

  /** The smallest print on the card and the most important line in the file. */
  function provenance(p) {
    const sha = p.baselineSha256 ? `${String(p.baselineSha256).slice(0, 12)}…` : 'unpinned';
    return el('p', { class: 'card-meta' }, [
      p.fileName ?? p.source ?? 'loaded in this session',
      p.week ? `drawn against the week of ${p.week}` : null,
      `baseline sha256 ${sha}`,
      p.validationPassed ? 'the author’s own checks passed' : null,
      p.warningCount ? `${p.warningCount} warning(s) recorded by the editor` : null,
    ].filter(Boolean).join(' · '));
  }

  /* ── § 2. One change ───────────────────────────────────────────────────── */

  /**
   * One patch of ground one author moved, and every finding it takes part in.
   *
   * @param {object} p the proposal
   * @param {string|object} patchOrKey the patch, or its key
   */
  function showChange(p, patchOrKey) {
    if (!p) return;
    const patch = typeof patchOrKey === 'object' && patchOrKey
      ? patchOrKey
      : (p.patches ?? []).find((x) => (x.key ?? x.id) === patchOrKey);
    if (!patch) return;
    showing = { kind: 'change', id: patch.key ?? patch.id };

    const moved = (patch.classes ?? []).map((c) => el('div', { class: 'side-class' },
      classSwatch(c.class), `${classPhrase(c.class)} — ${c.phrase ?? c.direction ?? 'changed'}`));

    /* `worstDeltaWithin` needs the change map, which is the app's to build and
       not this module's to compute — so it arrives through a hook when there is
       one, and the class phrases above carry the reading when there is not. */
    const worst = ctx?.worstDeltaFor?.(p, patch) ?? null;
    const zoom = button('Zoom', () => focus(patch.geometry ?? patch.bbox));
    zoom.setAttribute('aria-label', `Zoom to ${patch.name} (${surnameOf(p.author)})`);

    open(`${patch.name} · ${letterOf(p)} · ${surnameOf(p.author)}`, [
      el('p', { class: 'card-lede' },
        `${p.aoi?.name ?? 'an unnamed working area'} · ${fmtMi2(patch.areaKm2 ?? 0)} ${MI2}`),
      moved.length ? cardBlock('Classes that moved', ...moved) : null,
      worst ? cardBlock('On NDMC’s change map',
        el('p', {}, USDM_CHANGE_LABELS[worst.step] ?? worst.label)) : null,
      cardBlock('Why', mdBlock(patch.rationale) ?? hint('No rationale was written for this change.')),
      findingsForBlock(patch.key ?? patch.id),
      el('div', { class: 'card-actions' }, zoom),
    ]);
  }

  /** The findings this patch takes part in, as ways into them. */
  function findingsForBlock(key) {
    const all = (ctx?.findings ?? []).filter((f) =>
      (f?.patchesA ?? []).includes(key) || (f?.patchesB ?? []).includes(key));
    if (!all.length) return null;
    const rows = all.map((f, i) => {
      const b = button(kindWord(f.kind), () => openFinding(f));
      /* Named by ORDINAL, not by place: the drawer's rows are named by place,
         and no name on screen may contain another's. */
      b.setAttribute('aria-label', `${kindWord(f.kind)} ${i + 1} of ${all.length}`);
      return el('li', {}, el('div', { class: 'card-item' },
        el('p', {}, describeFinding(f)),
        el('div', { class: 'row' }, b)));
    });
    return cardBlock('It takes part in', el('ol', { class: 'evidence-list' }, ...rows));
  }

  function kindWord(kind) {
    return kind === 'conflict' ? 'Conflict'
      : kind === 'seam' ? 'Seam' : 'One-sided difference';
  }

  /** A finding in one sentence, for a list that is not the drawer's. */
  function describeFinding(f) {
    if (f?.kind === 'seam') {
      return `A ${f.reciprocal ? 'reciprocal' : 'one-sided'} seam along ` +
        `${f.sideA?.aoi?.name ?? 'one area'} / ${f.sideB?.aoi?.name ?? 'the other'}, ` +
        `${fmtMi(f.lengthKm ?? 0)} mi of shared border.`;
    }
    return `${classPhrase(f?.classA)} against ${classPhrase(f?.classB)} over ` +
      `${fmtMi2(f?.areaKm2 ?? 0)} ${MI2}, where the published map has ` +
      `${classPhrase(f?.published)}.`;
  }

  function openFinding(f) {
    if (typeof handlers.onOpenFinding === 'function') handlers.onOpenFinding(f);
    else if (typeof ctx?.openFinding === 'function') ctx.openFinding(f);
    else ctx?.select?.({ kind: f?.kind, id: f?.id });
  }

  /* ── § 3. A finding: the side-by-side ──────────────────────────────────── */

  /**
   * A conflict or a one-sided difference — the two answers, side by side.
   *
   * Source order is A then B, so the stacked reading on a phone is the same
   * reading as the two-column one on a laptop.
   */
  function showFinding(f) {
    if (!f) return;
    if (f.kind === 'seam') { showSeam(f); return; }
    showing = { kind: f.kind, id: f.id };

    const A = ctx?.proposalById?.(f.proposalA) ?? null;
    const B = ctx?.proposalById?.(f.proposalB) ?? null;
    const areaName = f.aoiName ?? A?.aoi?.name ?? B?.aoi?.name ?? f.aoiId ?? 'an unnamed area';
    const changedA = f.changedBy === 'A' || f.changedBy === 'both';
    const changedB = f.changedBy === 'B' || f.changedBy === 'both';

    const lede = [
      `${fmtMi2(f.areaKm2 ?? 0)} ${MI2}`,
      `the published map has ${classPhrase(f.published)}`,
      f.magnitude ? `${f.magnitude} class${f.magnitude === 1 ? '' : 'es'} apart` : null,
    ].filter(Boolean).join(' · ');

    open(`${kindWord(f.kind)} · ${areaName}`, [
      el('p', { class: 'card-lede' }, lede),
      el('div', { class: 'side-by-side' },
        sideColumn(A, f.classA, f.patchesA, changedA, f.published),
        sideColumn(B, f.classB, f.patchesB, changedB, f.published)),
      questionsBlock(f),
      actionsRow(f),
    ]);
  }

  /**
   * One column of the grid.
   *
   * A side that LEFT THE GROUND ALONE says so in as many words — "Left as
   * published" plus the author's name — because an empty column reads as
   * missing data rather than as a considered non-answer.
   */
  function sideColumn(p, level, patchKeys, changed, published) {
    if (!p) {
      return el('div', { class: 'side' },
        el('p', { class: 'side-head' }, 'Not loaded'),
        el('p', {}, 'The proposal on this side of the comparison is not loaded.'));
    }
    const col = el('div', { class: `side${changed ? ' is-changed' : ''}` },
      el('p', { class: 'side-head' },
        el('span', { class: 'mark-letter' }, letterOf(p)),
        el('span', {}, p.author?.name ?? 'An unnamed author')),
      el('p', { class: 'side-role' },
        [p.author?.role, p.author?.affiliation].filter(Boolean).join(' · ')));

    if (changed) {
      col.append(el('p', { class: 'side-class' }, classSwatch(level),
        el('span', {}, `proposes ${classPhrase(level)}`)));
    } else {
      col.append(el('p', { class: 'side-class' }, classSwatch(published),
        el('span', {}, `Left as published — ${classPhrase(published)}`)));
      col.append(el('p', {},
        `${p.author?.name ?? 'This author'} did not propose a change here.`));
    }

    const byKey = new Map((p.patches ?? []).map((x) => [x.key ?? x.id, x]));
    for (const key of patchKeys ?? []) {
      const patch = byKey.get(key);
      if (!patch) continue;
      const b = button('Zoom', () => focus(patch.geometry ?? patch.bbox));
      b.setAttribute('aria-label', `Zoom to ${patch.name} (${surnameOf(p.author)})`);
      col.append(el('div', { class: 'side-patch' },
        el('strong', {}, patch.name ?? 'A change'),
        el('span', {}, `${phrasesOf(patch)}${phrasesOf(patch) ? ' · ' : ''}` +
          `${fmtMi2(patch.areaKm2 ?? 0)} ${MI2}`),
        mdBlock(patch.rationale),
        b));
    }
    return col;
  }

  /* ── § 4. A seam ───────────────────────────────────────────────────────── */

  /**
   * A step along a shared working-area border.
   *
   * The far side is not always a proposal: it can be the published week (no
   * proposal loaded for that area) or unknown (the published week could not be
   * read). Both are stated, because "no disagreement shown" and "the other side
   * was never read" are different claims.
   */
  function showSeam(s) {
    if (!s) return;
    showing = { kind: 'seam', id: s.id };
    const a = s.sideA?.aoi?.name ?? s.aoiIds?.[0] ?? 'one area';
    const b = s.sideB?.aoi?.name ?? s.aoiIds?.[1] ?? 'the other area';
    const runs = (s.runs ?? []).filter((r) => r.kind !== 'agree' && r.kind !== 'pre-existing');

    const lede = [
      `${fmtMi(s.lengthKm ?? 0)} mi of shared border`,
      s.reciprocal ? 'both sides proposed a change' : 'one side proposed a change',
      s.isNew ? 'this step is new — the published map did not have it' : null,
      s.maxStep ? `the largest step is ${Math.abs(s.maxStep)} class${Math.abs(s.maxStep) === 1 ? '' : 'es'}` : null,
    ].filter(Boolean).join(' · ');

    /* The worst run is what the two sides are being read as proposing AT THE
       LINE — the run table below has every run, but the columns need the one
       number the disagreement is about. */
    const worst = runs.reduce((w, r) =>
      (Math.abs(r?.step ?? 0) > Math.abs(w?.step ?? 0) ? r : w), runs[0] ?? null);

    open(`Seam · ${a} / ${b}`, [
      el('p', { class: 'card-lede' }, lede),
      el('div', { class: 'side-by-side' },
        seamSide(s.sideA, a, worst?.classA, worst?.publishedA),
        seamSide(s.sideB, b, worst?.classB, worst?.publishedB)),
      runs.length ? cardBlock('Along the line', runTable(runs)) : null,
      seamNotesBlock(s),
      seamEdgeEffectsBlock(s),
      questionsBlock(s),
      actionsRow(s),
    ]);
  }

  function seamSide(side, name, level, published) {
    const col = el('div', { class: 'side' });
    if (side?.kind === 'proposal' && side.proposal) {
      const p = side.proposal;
      col.classList.add('is-changed');
      col.append(
        el('p', { class: 'side-head' },
          el('span', { class: 'mark-letter' }, letterOf(p)),
          el('span', {}, p.author?.name ?? 'An unnamed author')),
        el('p', { class: 'side-role' },
          [name, p.author?.role].filter(Boolean).join(' · ')));
      if (level) {
        col.append(el('p', { class: 'side-class' }, classSwatch(level),
          el('span', {}, `${classPhrase(level)} at the line`)));
      }
      return col;
    }
    col.append(el('p', { class: 'side-head' }, name));
    col.append(el('p', {}, side?.kind === 'unknown'
      ? 'The published week could not be read, so this side of the seam is unknown.'
      : `No proposal is loaded for ${name}, so this side of the seam is the published week.`));
    /* A published side still has a class, and it is the number the other side
       is being compared against — leaving the column bare would read as no
       answer rather than as the published answer. */
    if (published) {
      col.append(el('p', { class: 'side-class' }, classSwatch(published),
        el('span', {}, `${classPhrase(published)} at the line`)));
    }
    return col;
  }

  /** The runs, in miles. A table because they are read as a column of numbers. */
  function runTable(runs) {
    const head = el('tr', {}, ...['Run', 'Proposed', 'Published', 'Length']
      .map((h) => el('th', { scope: 'col' }, h)));
    const body = el('tbody', {}, ...runs.map((r, i) => el('tr', {},
      el('td', {}, `${i + 1} · ${r.kind}`),
      el('td', {}, `${shortLevel(r.classA)} / ${shortLevel(r.classB)}`),
      el('td', {}, `${shortLevel(r.publishedA)} / ${shortLevel(r.publishedB)}`),
      el('td', { class: 'num' }, `${fmtMi(r.lengthKm ?? 0)} mi`))));
    return el('div', { class: 'table-scroll' },
      el('table', { class: 'data-table' }, el('thead', {}, head), body));
  }

  function shortLevel(level) {
    return !level || level === 'none' ? 'none' : level;
  }

  function seamNotesBlock(s) {
    const kids = [];
    for (const key of ['A', 'B']) {
      const md = s.borderNotes?.[key];
      const body = mdBlock(md);
      if (!body) continue;
      const p = s[`side${key}`]?.proposal;
      kids.push(el('p', {}, el('strong', {},
        `${p?.author?.name ?? 'One side'} — note to the neighbour`)), body);
    }
    if (!kids.length) return null;
    return cardBlock('Notes to neighbours', ...kids);
  }

  function seamEdgeEffectsBlock(s) {
    const rows = (s.edgeEffects ?? []).map((e) => el('li', {}, e.statement ?? '')).filter((n) => n.textContent);
    if (!rows.length) return null;
    return cardBlock('What the authors said about this border',
      el('ul', { class: 'evidence-list' }, ...rows));
  }

  /* ── § 5. Questions and the two actions ────────────────────────────────── */

  /**
   * The questions the brief asks, shown here so the reader does not have to
   * download a file to see what the tool thinks is worth asking.
   *
   * They come from `js/brief.js` through `ctx.brief(finding)` — the brief is
   * the single source, and a second list written here would drift from the one
   * that leaves the browser. A `ctx.questionsFor` hook wins when there is one.
   */
  function questionsBlock(f) {
    let questions = [];
    try {
      questions = ctx?.questionsFor?.(f) ?? questionsFromBrief(ctx?.brief?.(f));
    } catch (err) {
      console.warn('[viewer] could not read the brief’s questions', err);
    }
    if (!questions?.length) return null;
    return cardBlock('Questions for discussion',
      el('ol', { class: 'questions' }, ...questions.map((q) => el('li', {}, q))));
  }

  /**
   * The list items under the brief's questions heading.
   *
   * Markdown in, plain sentences out: the heading is matched by WORD rather
   * than by level, so a brief that promotes or demotes the section keeps its
   * questions on the card.
   */
  function questionsFromBrief(md) {
    if (typeof md !== 'string' || !md) return [];
    const lines = md.split('\n');
    const start = lines.findIndex((l) => /^#{1,6}\s.*question/i.test(l));
    if (start < 0) return [];
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) break;
      const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
      if (m) out.push(stripMarks(m[1]));
    }
    return out;
  }

  /** Emphasis and links, out of a sentence that is about to be plain text. */
  function stripMarks(s) {
    return String(s)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]{1,3}/g, '')
      .trim();
  }

  /**
   * Download and Copy, the two ways the brief leaves the browser.
   *
   * The ids are docs/contracts.md § 13's. No transport label contains another's
   * — "Copy brief" and "Download brief (.md)" share no substring, and neither
   * is inside the navbar's "Briefs — download every finding as markdown".
   */
  function actionsRow(f) {
    const dl = button('Download brief (.md)', () => downloadBrief(f, { ctx }));
    dl.id = 'brief-download';
    const cp = button('Copy brief', () => { copyBrief(f, { ctx }); });
    cp.id = 'brief-copy';
    return el('div', { class: 'card-actions' }, dl, cp);
  }

  return {
    showProposal, showChange, showFinding, showSeam,
    /** What the card is showing, for the app's own selection bookkeeping. */
    showing: () => showing,
  };
}
