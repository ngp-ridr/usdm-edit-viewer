/* ============================================================================
   USDM Edit Viewer · js/panels.js
   The drawer: the session line, the proposal list, the findings list and the
   legend. docs/contracts.md § 11.

     const panels = createPanels(els, ctx);
     panels.renderSession();          // #session-line
     panels.renderProposals(list);    // #proposal-list, grouped by working area
     panels.renderFindings(findings); // the three <details>
     panels.renderLegend('proposal'); // #legend-body + #legend-key
     panels.setStatus(sentence);      // #findings-status, role="status"

   ── THE FINDINGS LIST IS THE MAP'S TEXT TWIN ───────────────────────────────
   A screen reader cannot see a WebGL canvas. Everything the map marks is a row
   here, in the SAME RANK ORDER, with the SAME WORDS the card uses, and the
   count is mirrored into `#findings-status`. That is not a courtesy: it is the
   only reading of this app a third of its readers will get, and it is also what
   a sighted reviewer quotes into an email.

   Hiding a proposal hides its outlines and DIMS its findings. It never changes
   the answer — the comparison is over what was LOADED, and a tool whose
   findings depend on which checkbox is ticked is a tool nobody can quote.

   ── NO INLINE `style`, ANYWHERE ────────────────────────────────────────────
   Everything is built with `el()` from the vendored js/dom.js, which THROWS on
   a `style` attribute. The page runs `style-src 'self'`: a style attribute is
   silently dropped and the element renders unstyled, which looks exactly like a
   CSS bug. Swatch colours are CSSOM writes (`node.style.background`), the way
   the editor's legend does it, and the two USDM ramps come from
   vendor/usdm-editor/js/color.js because they are DATA, not brand.

   NEVER call the kit's `vendor/style/ui/legend.js`: it writes inline `style`
   attributes. The legend here is hand-built, and every swatch carries its NAME
   — both published ramps are CVD-hostile through their middles, so a bare
   swatch is not a reading.

   ── THE RE-CHECK IS DEFERRED, ONE PROPOSAL PER TICK ────────────────────────
   `p.integrity` costs 106–663 ms per package (measured over the twelve bundled
   ones), so touching all twelve inside `renderProposals` would freeze the
   drawer for several seconds at exactly the moment a reader is looking at it.
   Rows render immediately with a "checking…" line and a queue fills them in,
   one per `setTimeout(0)` — NOT `requestIdleCallback`, which Safari does not
   have, and this app is public. A re-render cancels the queue.

   Sections: helpers · session · proposals · findings · legend
   ========================================================================== */

import { el, button } from '../vendor/usdm-editor/js/dom.js';
import { changeLegendItems, legendItems, USDM_COLORS, USDM_LABELS }
  from '../vendor/usdm-editor/js/color.js';
import { fmtMi, fmtMi2, MI2 } from '../vendor/usdm-editor/js/units.js';
import { prose } from '../vendor/usdm-editor/js/changes.js';
import { markStyle } from './marks.js';
import { normalizeRecheck } from './recheck.js';

/* ── small shared helpers ─────────────────────────────────────────────────────
   The three exported ones are also js/cards.js's. They are exported rather than
   copied because `classSwatch` + `classPhrase` are the pair that enforces the
   house rule — a USDM colour NEVER appears without its class name — and a rule
   written twice is a rule that holds in one of the two places. The import runs
   one way only: cards → panels, never back. */

/** The surname a finding row names an author by. "Dana Reyes" → "Reyes". */
export function surnameOf(author) {
  const name = String(author?.name ?? '').trim();
  if (!name) return 'an unnamed author';
  const parts = name.split(/\s+/);
  return parts[parts.length - 1];
}

/** `['Change 2', 'Change 3']` → `'Changes 2 and 3'`; `[]` → `'no change'`. */
function changeRef(names) {
  if (!names.length) return 'no change';
  if (names.length === 1) return names[0];
  return `Changes ${prose(names.map((n) => n.replace(/^Change\s+/, '')))}`;
}

/** A class code with its published name — the swatch is never the only channel. */
export function classPhrase(level) {
  if (!level || level === 'none') return 'no drought';
  return `${level} · ${USDM_LABELS[level] ?? level}`;
}

/**
 * A class in a list row, where `null` and `'none'` are DIFFERENT ANSWERS.
 *
 * `'none'` is ground inside a working area that carries no drought. `null` is a
 * side nobody could read — the published far side of a seam, with the archive
 * unreachable — and calling that "no drought" states the opposite of what is
 * known. `classPhrase` folds the two together deliberately, because everywhere
 * it is used a class is always present; this is for the one place that is not.
 */
export function classWord(level) {
  if (level == null) return 'not known';
  return level === 'none' ? 'no drought' : String(level);
}

/** A swatch for one USDM class, coloured through the CSSOM. */
export function classSwatch(level) {
  const sw = el('span', { class: 'legend-swatch' });
  /* CSSOM, never a `style` attribute: `el()` throws on one and this page's CSP
     would drop it anyway. `none` gets the labelled hole — the same treatment
     the change ramp's zero band gets, and for the same reason. */
  if (level && level !== 'none') sw.style.background = USDM_COLORS[level];
  else sw.classList.add('is-unshaded');
  return sw;
}

/** Is this proposal drawing right now? An empty `shown` set means all of them. */
function isShown(ctx, id) {
  const shown = ctx?.shown;
  if (!shown || typeof shown.has !== 'function') return true;
  return shown.size === 0 || shown.has(id);
}

/* ══ the panels ═════════════════════════════════════════════════════════════ */

/**
 * Mount the drawer's four surfaces.
 *
 * @param {object} els the element map from js/app.js (`sessionLine`,
 *        `proposalList`, `findingsConflicts` / `findingsOnesided` /
 *        `findingsSeams`, `findingsStatus`, `legendBody`, `legendKey`)
 * @param {object} ctx docs/contracts.md § 12 — read through getters, never
 *        copied. Only `shown`, `selection`, `marks`/`markFor`, `proposalById`
 *        and `week` are read; `setShown`, `select`, `focus` and `say` are
 *        called.
 * @param {{onToggleShown?:Function, onOpenProposal?:Function,
 *          onOpenFinding?:Function}} [handlers] optional overrides — WP-B may
 *        wire these explicitly rather than through `ctx`. Whichever is present
 *        wins; the `ctx` route is the default so the two-argument call in
 *        docs/contracts.md § 11 works unchanged.
 */
/** Above this many one-sided rows the group starts collapsed — see renderFindings. */
const ONE_SIDED_OPEN_MAX = 12;

export function createPanels(els, ctx, handlers = {}) {
  /** The deferred re-check queue. Cancelled and rebuilt on every render. */
  let recheckTimer = null;
  /** Grades already computed, by proposal id — a re-render must not re-pay. */
  const recheckCache = new Map();
  /** Every finding row currently on screen, by finding id, for `setSelection`. */
  const rowsById = new Map();

  /* ── § 1. The session line ─────────────────────────────────────────────── */

  /**
   * "Week 2026-09-08 · 12 proposals over 5 working areas · 3 conflicts, 41
   * one-sided, 4 seams".
   *
   * The counts come from the caller when it has them and from `ctx` when it
   * does not, so a caller that has only just loaded files does not have to
   * build a summary object to say so.
   *
   * A session loaded from LOCAL FILES gets one extra sentence: a link to this
   * page will open empty. Local files cannot travel in a URL, and pretending
   * otherwise is the failure mode worth a sentence (docs/contracts.md § 14).
   */
  function renderSession(summary = null) {
    const node = els?.sessionLine;
    if (!node) return;
    const proposals = summary?.proposals ?? ctx?.proposals ?? [];
    const n = Array.isArray(proposals) ? proposals.length : (summary?.count ?? 0);
    if (!n) {
      node.textContent = summary?.sentence ?? 'Nothing is loaded yet.';
      return;
    }
    const findings = summary?.findings ?? ctx?.findings ?? [];
    /* The caller's own counts when it has them — js/app.js's `summaryOf()`
       already has all three — and a sweep of the list when it does not. */
    const counts = Number.isFinite(summary?.conflicts)
      ? { conflict: summary.conflicts, 'one-sided': summary.oneSided ?? 0, seam: summary.seams ?? 0 }
      : countKinds(findings);
    const areas = summary?.areas
      ?? new Set(proposals.map((p) => p?.aoi?.id).filter(Boolean)).size;
    const week = summary?.week ?? ctx?.week ?? proposals[0]?.week ?? null;

    const parts = [
      week ? `Week ${week}` : 'An unrecorded week',
      `${n} proposal${n === 1 ? '' : 's'} over ${areas} working area${areas === 1 ? '' : 's'}`,
    ];
    /* The three counts are always all three, even at zero: "no conflicts" is a
       finding in its own right, and a sentence that silently drops the word
       reads as a sentence that did not look. */
    parts.push(`${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}, ` +
      `${counts['one-sided']} one-sided, ${counts.seam} seam${counts.seam === 1 ? '' : 's'}`);

    /* A local-file session gets ONE extra sentence, and js/app.js's summary is
       the authority on whether this is one — it watched the files arrive. */
    const local = summary?.local ?? (Array.isArray(proposals)
      && proposals.some((p) => p?.fileName && !p?.source));
    const note = local
      ? (summary?.localNote ?? 'These came from files on this computer, so a link ' +
        'to this page opens empty — use Briefs to share what you found.')
      : null;
    node.textContent = parts.join(' · ') + '.' + (note ? ` ${note}` : '');
  }

  /** How many of each kind, over a mixed ranked list. */
  function countKinds(findings) {
    const out = { conflict: 0, 'one-sided': 0, seam: 0 };
    for (const f of findings ?? []) if (f?.kind in out) out[f.kind]++;
    return out;
  }

  /* ── § 2. The proposal list ────────────────────────────────────────────── */

  /**
   * One row per loaded proposal, grouped by working area.
   *
   * The MARK is the point of the row: a proposal is identified on the map by a
   * letter and a dash pattern, and both have to be legible here or the map's
   * marks name nothing. The swatch is a real dashed rule (a `border-top-style`,
   * css/app.css § 4), not a picture of one, and the letter beside it is the
   * text twin.
   */
  function renderProposals(proposals = ctx?.proposals ?? []) {
    const host = els?.proposalList;
    if (!host) return;
    cancelRechecks();
    host.replaceChildren();

    const list = [...(proposals ?? [])];
    if (!list.length) {
      host.append(el('p', { class: 'drawer-note' }, 'No proposals are loaded.'));
      return;
    }

    /* Grouped by working area, in the order the areas first appear — which is
       load order, which is the order the letters were assigned in. */
    const groups = new Map();
    for (const p of list) {
      const key = p?.aoi?.id ?? '—';
      if (!groups.has(key)) groups.set(key, { name: p?.aoi?.name ?? key, items: [] });
      groups.get(key).items.push(p);
    }

    const pending = [];
    for (const [, g] of groups) {
      const block = el('div', { class: 'proposal-group' },
        el('h3', {}, `${g.name} (${g.items.length})`));
      for (const p of g.items) block.append(proposalRow(p, pending));
      host.append(block);
    }
    scheduleRechecks(pending);
  }

  /** One `.proposal-row`. Pushes its re-check job onto `pending`. */
  function proposalRow(p, pending) {
    const id = p?.id ?? '';
    const short = p?.shortId ?? id.slice(0, 8);
    const mark = markOf(p);
    const style = markStyle(mark?.dash ?? 0);
    const shown = isShown(ctx, id);

    const box = el('input', { type: 'checkbox', id: `show-${short}` });
    box.checked = shown;
    box.addEventListener('change', onShownChanged);

    /* The label's accessible name is "A · Marla Teigen" — letter first, because
       that is what the map draws and what a brief says. The swatch is
       `aria-hidden`: it is the dash pattern, and the letter already carries
       that distinction in text. */
    const label = el('label', { for: `show-${short}` },
      el('span', { class: `mark-swatch ${style.className}`, 'aria-hidden': 'true' }),
      el('span', { class: 'mark-letter' }, mark?.letter ?? '?'),
      el('span', {}, p?.author?.name ?? 'An unnamed author'));

    const row = el('div', { class: `proposal-row${shown ? ' is-shown' : ''}`,
      'data-proposal-id': id },
    el('div', { class: 'proposal-check' }, box, label));

    const meta = [
      p?.author?.role,
      p?.author?.affiliation,
      `${p?.patches?.length ?? 0} change${(p?.patches?.length ?? 0) === 1 ? '' : 's'}`,
      (p?.changes ?? []).map((c) => c.class).join(' '),
    ].filter(Boolean).join(' · ');
    row.append(el('p', { class: 'proposal-meta' }, meta));

    /* The verdict lands here later — see the header. A row that said nothing
       until the check finished would read as a row with nothing to say. */
    const verdict = el('p', { class: 'recheck-line' }, 'Re-check: checking…');
    row.append(verdict);
    pending.push({ proposal: p, node: verdict });

    /* "Details" is the visible label, so the accessible name must contain it
       (WCAG 2.5.3) — and it must not contain, or be contained by, the
       checkbox's "A · Marla Teigen". The comma is what keeps the two apart. */
    const details = button('Details', () => openProposal(p));
    details.setAttribute('aria-label',
      `Details of proposal ${mark?.letter ?? '?'}, ${p?.author?.name ?? 'an unnamed author'}`);
    row.append(el('div', { class: 'proposal-tools' }, details));
    return row;
  }

  function markOf(p) {
    if (typeof ctx?.markFor === 'function') return ctx.markFor(p?.id);
    return ctx?.marks?.get?.(p?.id) ?? null;
  }

  /**
   * A checkbox moved: hand the whole set back, never one id.
   *
   * EMPTY MEANS ALL. `ctx.shown` is a Set that is empty when nothing has been
   * hidden (js/app.js § State), and `?show=` is emitted only when not all are
   * shown — so "everything ticked" has to arrive as `[]` or the URL grows a
   * parameter that says nothing.
   */
  function onShownChanged() {
    const boxes = [...(els?.proposalList?.querySelectorAll('input[type="checkbox"]') ?? [])];
    const rows = boxes.map((b) => ({
      id: b.closest('.proposal-row')?.dataset?.proposalId ?? null,
      on: b.checked,
    })).filter((r) => r.id);
    const on = rows.filter((r) => r.on).map((r) => r.id);
    for (const b of boxes) {
      b.closest('.proposal-row')?.classList.toggle('is-shown', b.checked);
    }
    const ids = on.length === rows.length ? [] : on;
    if (typeof handlers.onToggleShown === 'function') handlers.onToggleShown(ids);
    else ctx?.setShown?.(ids);
    /* Dim the findings the hidden proposals take part in. The list is not
       rebuilt — the answer did not change, only what is drawing. */
    repaintDimming();
  }

  function openProposal(p) {
    if (typeof handlers.onOpenProposal === 'function') handlers.onOpenProposal(p);
    else if (typeof ctx?.openProposal === 'function') ctx.openProposal(p);
    else ctx?.cards?.showProposal?.(p);
  }

  /* ── the deferred re-check ─────────────────────────────────────────────── */

  function cancelRechecks() {
    if (recheckTimer != null) clearTimeout(recheckTimer);
    recheckTimer = null;
  }

  /**
   * Fill in the verdicts, one per tick.
   *
   * `setTimeout(0)` rather than `requestIdleCallback`: Safari does not have the
   * latter, and the editor's cautionary tale is a background pre-warm whose
   * idle fallback WAS the Safari code path.
   */
  function scheduleRechecks(jobs) {
    if (!jobs.length) return;
    let i = 0;
    const step = () => {
      recheckTimer = null;
      const job = jobs[i++];
      if (!job) return;
      if (job.node.isConnected) paintRecheck(job.proposal, job.node);
      if (i < jobs.length) recheckTimer = setTimeout(step, 0);
    };
    recheckTimer = setTimeout(step, 0);
  }

  /** The grade for one proposal, computed at most once per session. */
  function recheckOf(p) {
    const id = p?.id ?? '';
    if (recheckCache.has(id)) return recheckCache.get(id);
    let out = null;
    try {
      /* `p.integrity` is docs/contracts.md § 2's memo — a lazy getter, which is
         why this is on a tick. `normalizeRecheck` accepts either that shape or
         `recheckPackage`'s, so the sentence is written in one place. */
      out = normalizeRecheck(p?.recheck ?? p?.integrity ?? null);
    } catch (err) {
      console.warn('[viewer] re-check failed', err);
      out = null;
    }
    recheckCache.set(id, out);
    return out;
  }

  function paintRecheck(p, node) {
    const r = recheckOf(p);
    if (!r) { node.textContent = 'Re-check: not run.'; return; }
    node.textContent = r.sentence;
    /* `.is-defect` for a DEFECT ONLY. Ten of the twelve bundled proposals grade
       `residue`, and a warning that fires on ten of twelve has told the reader
       nothing (docs/contracts.md § 16.8). */
    node.classList.toggle('is-defect', r.grade === 'defect');
  }

  /* ── § 3. The findings list ────────────────────────────────────────────── */

  /**
   * The three groups, in rank order, conflicts first.
   *
   * One `<ol>` per `<details>`; one `<button class="finding-row">` per finding,
   * three lines each — where, what, how big. A one-line row either truncates
   * the place or drops the size, and both are how a reviewer decides what to
   * open.
   */
  function renderFindings(findings = ctx?.findings ?? []) {
    rowsById.clear();
    const list = [...(findings ?? [])];
    const groups = [
      [els?.findingsConflicts, 'conflict', 'Conflicts',
        'No conflicts — no two loaded proposals answer the same ground differently.'],
      [els?.findingsOnesided, 'one-sided', 'One-sided',
        'No one-sided differences.'],
      [els?.findingsSeams, 'seam', 'Seams',
        'No seams — no shared working-area border grew a step the published map did not have.'],
    ];
    for (const [host, kind, title, empty] of groups) {
      if (!host) continue;
      const items = list.filter((f) => f?.kind === kind);
      const summary = host.querySelector('summary');
      if (summary) summary.textContent = `${title} (${items.length})`;
      const ol = host.querySelector('ol');
      if (!ol) continue;
      ol.replaceChildren(...items.map((f, i) => el('li', {}, findingRow(f, i))));
      /* The one-sided group is the LONG one — 162 rows on the twelve-proposal
         demo against 6 conflicts and 20 seams — so it opens by itself only
         while it is short. Once a reader has flipped it, it stays as they left
         it: the rule applies only while the group's state is still the one
         this function last set, so a recompute never snaps a list shut under
         somebody reading it. */
      if (kind === 'one-sided') {
        const want = items.length <= ONE_SIDED_OPEN_MAX;
        const last = host.dataset.autoOpen;
        if (last === undefined || host.open === (last === '1')) {
          host.open = want;
          host.dataset.autoOpen = want ? '1' : '0';
        }
      }
      /* The empty note is a SIBLING of the list, not an item in it: an <ol>
         whose one entry says "nothing here" counts as one. */
      let note = host.querySelector('.findings-empty');
      if (!items.length) {
        if (!note) { note = el('p', { class: 'drawer-note findings-empty' }); host.append(note); }
        note.textContent = empty;
        note.hidden = false;
      } else if (note) {
        note.hidden = true;
      }
    }
    setSelection(ctx?.selection ?? null);
  }

  /** One `.finding-row` button, three lines. */
  function findingRow(f, index) {
    const b = el('button', {
      type: 'button', class: 'finding-row', 'data-finding-id': f?.id ?? '',
      /* Roving tabindex: one stop per group, arrows move within it. Twelve
         proposals can make forty findings, and forty tab stops between the
         legend and the map is not a keyboard interface. */
      tabindex: index === 0 ? '0' : '-1',
    });
    const lines = f?.kind === 'seam' ? seamLines(f) : regionLines(f);
    b.append(
      el('span', { class: 'finding-where' }, lines.where),
      el('span', { class: 'finding-what' }, ...lines.what),
      el('span', { class: 'finding-size' }, lines.size));
    b.addEventListener('click', () => openFinding(f));
    b.addEventListener('keydown', onRowKey);
    if (isDimmed(f)) b.classList.add('is-dimmed');
    rowsById.set(f?.id, b);
    return b;
  }

  /** Where · what · how big, for a region (docs/contracts.md § 4). */
  function regionLines(f) {
    const A = ctx?.proposalById?.(f?.proposalA) ?? null;
    const B = ctx?.proposalById?.(f?.proposalB) ?? null;
    const nameA = surnameOf(A?.author);
    const nameB = surnameOf(B?.author);
    const refA = changeRef(patchNames(A, f?.patchesA));
    const refB = changeRef(patchNames(B, f?.patchesB));
    const where = `${f?.aoiName ?? A?.aoi?.name ?? B?.aoi?.name ?? f?.aoiId ?? 'Unnamed area'}` +
      ` · ${refA} (${nameA}) vs ${refB} (${nameB})`;
    /* The two classes are the answer; the published one is what they are both
       answering. `<strong>` on the two that disagree, because this line is
       skimmed. */
    const what = [
      el('strong', {}, f?.classA === 'none' ? 'no drought' : String(f?.classA ?? '?')),
      ` ${nameA} vs `,
      el('strong', {}, f?.classB === 'none' ? 'no drought' : String(f?.classB ?? '?')),
      ` ${nameB} · published ${f?.published === 'none' ? 'no drought' : f?.published ?? '?'}`,
      f?.magnitude ? ` · ${f.magnitude}-class span` : '',
    ];
    return { where, what, size: `${fmtMi2(f?.areaKm2 ?? 0)} ${MI2}` };
  }

  /** Where · what · how big, for a seam (docs/contracts.md § 5). */
  function seamLines(f) {
    const a = f?.sideA?.aoi?.name ?? f?.aoiIds?.[0] ?? 'one side';
    const b = f?.sideB?.aoi?.name ?? f?.aoiIds?.[1] ?? 'the other side';
    const runs = (f?.runs ?? []).filter((r) => r?.kind && r.kind !== 'agree' && r.kind !== 'pre-existing');
    /* AN UNKNOWN RUN IS NOT A STEP — its far side is the published week this
       app could not read, so its `classB` is null and its `step` is null.
       Leaving it in the worst-run pick let a seam with a real step lose to one
       that says nothing, and printed the null as "null". */
    const stepped = runs.filter((r) => r.kind !== 'unknown');
    const worst = stepped.reduce((w, r) =>
      (Math.abs(r?.step ?? 0) > Math.abs(w?.step ?? 0) ? r : w), stepped[0] ?? null)
      /* Nothing but unknown runs: the row still says what THIS side proposes
         at the line, against a far side it names as unread. */
      ?? [...runs].sort((x, y) => (y?.lengthKm ?? 0) - (x?.lengthKm ?? 0))[0] ?? null;
    const stepKm = runs.reduce((s, r) => s + (r?.lengthKm ?? 0), 0);
    const what = [
      worst ? `${classWord(worst.classA)} → ${classWord(worst.classB)}` : 'no step',
      ` · ${f?.reciprocal ? 'reciprocal' : 'one-sided'}`,
      f?.isNew ? ' · new' : '',
    ];
    /* "OF N MI SHARED" IS A CLAIM ABOUT THE BORDER, and the border is only
       known when both sides are loaded (js/seams.js `sharedKm`). Facing a
       neighbour nobody loaded, the line is that author's own edge effects —
       68 of "72 mi shared" where the border runs 378 — so the word becomes
       "analysed", which is what the number actually measures. */
    const whole = f?.sharedKm ?? f?.lengthKm ?? stepKm ?? 0;
    const word = f?.sharedKm != null ? 'shared' : 'analysed';
    const size = stepKm
      ? `${fmtMi(stepKm)} mi of ${fmtMi(whole)} mi ${word}`
      : `${fmtMi(whole)} mi ${word}`;
    /* AUTHOR-QUALIFIED, as `regionLines` is: three Montana proposals against
       one North Dakota one are three seams over one border, and without the
       surnames the three rows are byte-identical. */
    return { where: `${a} (${sideWho(f?.sideA)}) / ${b} (${sideWho(f?.sideB)})`, what, size };
  }

  /** Who a seam's side is, in one word: an author, or what stands in for one. */
  function sideWho(side) {
    if (side?.kind === 'proposal') return surnameOf(side.proposal?.author);
    return side?.kind === 'published' ? 'published' : 'not read';
  }

  /** The patch NAMES a region attributes to one side. */
  function patchNames(p, keys) {
    if (!p || !Array.isArray(keys) || !keys.length) return [];
    const byKey = new Map((p.patches ?? []).map((x) => [x.key ?? x.id, x]));
    return keys.map((k) => byKey.get(k)?.name).filter(Boolean);
  }

  /** Does this finding involve a proposal the reader has hidden? */
  function isDimmed(f) {
    const ids = f?.kind === 'seam'
      ? [f?.sideA?.proposal?.id, f?.sideB?.proposal?.id]
      : [f?.proposalA, f?.proposalB];
    const present = ids.filter(Boolean);
    if (!present.length) return false;
    return present.some((id) => !isShown(ctx, id));
  }

  function repaintDimming() {
    for (const f of ctx?.findings ?? []) {
      rowsById.get(f?.id)?.classList.toggle('is-dimmed', isDimmed(f));
    }
  }

  function openFinding(f) {
    if (typeof handlers.onOpenFinding === 'function') handlers.onOpenFinding(f);
    else if (typeof ctx?.openFinding === 'function') ctx.openFinding(f);
    else ctx?.select?.({ kind: f?.kind, id: f?.id });
  }

  /**
   * Arrow keys rove WITHIN a group.
   *
   * Down/Up move, Home/End jump; nothing crosses into another `<details>`,
   * because the three groups are three lists and a key that silently jumped
   * from the last conflict to the first seam would be a key that lost the
   * reader's place.
   */
  function onRowKey(e) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const list = e.currentTarget.closest('ol');
    if (!list) return;
    const rows = [...list.querySelectorAll('.finding-row')];
    const here = rows.indexOf(e.currentTarget);
    if (here < 0) return;
    let next = here;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, here + 1);
    if (e.key === 'ArrowUp') next = Math.max(0, here - 1);
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = rows.length - 1;
    if (next === here) { e.preventDefault(); return; }
    for (const r of rows) r.tabIndex = -1;
    rows[next].tabIndex = 0;
    rows[next].focus();
    e.preventDefault();
  }

  /**
   * Mark the selected row.
   *
   * `aria-current` is BOTH channels at once: it is what a screen reader reads
   * and it is what css/app.css § 5 selects on, so the seen state and the
   * announced state cannot drift.
   */
  function setSelection(selection) {
    const id = selection?.id ?? null;
    for (const [rowId, node] of rowsById) {
      if (rowId === id) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
  }

  /** The sentence under the findings title. `role="status"` is on its wrapper. */
  function setStatus(sentence) {
    if (els?.findingsStatus) els.findingsStatus.textContent = sentence ?? '';
  }

  /* ── § 4. The legend ───────────────────────────────────────────────────── */

  /**
   * Hand-built, and which ramp is drawn follows the VIEW.
   *
   * Classes under A proposal and Published; NDMC's change ramp under
   * Differences, with "No change — unshaded" as a labelled hole — the zero band
   * is real and deliberately never painted, because this map has terrain and
   * classes underneath where NDMC's PNG has nothing.
   *
   * Under either ramp, the MARKS: one row per shown proposal, then the finding
   * and seam marks. Every pair of marks differs on at least two axes, and every
   * row carries a name.
   */
  function renderLegend(view = ctx?.view ?? 'proposal') {
    const host = els?.legendBody;
    if (!host) return;
    const blocks = [];
    blocks.push(view === 'differences' ? changeRampBlock() : classRampBlock());
    blocks.push(marksBlock());
    host.replaceChildren(...blocks);
    if (els?.legendKey) {
      els.legendKey.textContent = view === 'differences'
        ? 'Colours are NDMC’s published class-change encoding. Ground that did ' +
          'not move is left unpainted.'
        : 'Colours are the US Drought Monitor’s published class encoding, which ' +
          'never varies by theme.';
    }
  }

  function legendRow(swatch, name, sub) {
    return el('div', { class: 'legend-row' }, swatch,
      el('span', { class: 'legend-name' }, name,
        sub ? el('span', { class: 'legend-sub' }, sub) : null));
  }

  function classRampBlock() {
    const block = el('div', { class: 'legend-block' }, el('h3', {}, 'Drought classes'));
    for (const it of legendItems()) {
      const sw = el('span', { class: 'legend-swatch' });
      sw.style.background = it.color;
      block.append(legendRow(sw, it.label));
    }
    return block;
  }

  function changeRampBlock() {
    const block = el('div', { class: 'legend-block' }, el('h3', {}, 'Class change'));
    for (const it of changeLegendItems()) {
      const sw = el('span', { class: 'legend-swatch' });
      sw.style.background = it.color;
      block.append(legendRow(sw, it.label));
    }
    /* The zero band. A legend that omitted it would leave the reader to guess
       whether unshaded ground means "no change" or "no data". */
    block.append(legendRow(el('span', { class: 'legend-swatch is-unshaded' }),
      'No change — unshaded'));
    return block;
  }

  /** A line swatch in one of the four border styles. */
  function lineSwatch(...extra) {
    return el('span', { class: ['legend-line', ...extra].filter(Boolean).join(' ') });
  }

  function marksBlock() {
    const block = el('div', { class: 'legend-block legend-marks' }, el('h3', {}, 'Marks'));
    const proposals = (ctx?.proposals ?? []).filter((p) => isShown(ctx, p?.id));
    for (const p of proposals) {
      const mark = markOf(p);
      const style = markStyle(mark?.dash ?? 0);
      const cls = { solid: null, dashed: 'is-dashed', dotted: 'is-dotted', double: 'is-double' }[style.swatch];
      block.append(legendRow(lineSwatch(cls),
        `${mark?.letter ?? '?'} · ${p?.author?.name ?? 'An unnamed author'}`,
        p?.aoi?.name ?? null));
    }
    /* The six marks the findings themselves wear. Each names what it means —
       a dash pattern is not a name. */
    block.append(
      legendRow(lineSwatch(), 'Conflict', 'Two proposals answer this ground differently'),
      legendRow(lineSwatch('is-dashed'), 'One-sided', 'One proposal changed it; the other left it'),
      legendRow(lineSwatch('is-seam'), 'Seam, both sides', 'A step at a shared border, both sides proposed'),
      legendRow(lineSwatch('is-seam', 'is-dashed'), 'Seam, one side', 'A step at a shared border, one side proposed'),
      legendRow(lineSwatch('is-new-seam'), 'New seam', 'The published map did not have this step'),
      legendRow(lineSwatch('is-selected'), 'Selected', 'The finding you pointed at'));
    return block;
  }

  return {
    renderSession, renderProposals, renderFindings, renderLegend, setStatus,
    /* Additive, and both are the drawer's own business: the selected row's
       `aria-current`, and the dimming a hidden proposal causes. */
    setSelection, repaintDimming,
    destroy: cancelRechecks,
  };
}
