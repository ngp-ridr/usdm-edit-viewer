/* ============================================================================
   NGP RIDR house-style kit · ui/search.js · v0.2.0
   The county-search combobox: a text input plus an ARIA listbox of results.

   ES module, no build step. Imports only core/core.js.

     import { initSearchBox }
       from '../vendor/style/ui/search.js';

   Markup is the shell documented in theme/ridr-theme.css § "Combobox" —
   this module produces exactly that DOM and nothing else:

     <div class="ridr-combobox">
       <input type="search" id="county-search">
       <kbd>/</kbd>
       <ul id="county-results" role="listbox"></ul>
     </div>

     initSearchBox({
       input:    document.getElementById('county-search'),
       dropdown: document.getElementById('county-results'),
       items:    counties,                    // [{ id, label, code }]
       onSelect: (item) => openCounty(item.id),
       announce: live.announce,               // core createLiveRegion()
     });

   The listbox is the KEYBOARD TWIN for click-to-select on the map canvas
   (HOUSE-STYLE §5.8): every county reachable by pointer must be reachable
   here, so this is an accessibility obligation, not a convenience.

   ── Attribution ────────────────────────────────────────────────────────────
   Ported from mt-climate-office/mco-web-style (MIT) — the
   `MCO.initSearchBox({input, dropdown, items, renderRow, onSelect})` API
   planned for that kit's 0.7.0 (CHANGELOG § "Planned for 0.7.0"), which
   itself generalises the two mesonet_app map search boxes whose keyboard
   handling differed only in whitespace. Deltas from that plan:

     1. ES module with a named export — no `MCO` global.
     2. Filtering is diacritic- AND case-insensitive (NFD fold), and RANKED:
        label prefix > code prefix > word-start > substring. The MCO originals
        did a flat case-insensitive `includes()`, which buries "Lake County"
        under "Salt Lake…" for the query "lake".
     3. Results are capped (`maxResults`) with a counted overflow row, so a
        3,100-county list can't render 3,100 <li>s into a flyout. That row and
        the zero-results row are DISABLED OPTIONS, not presentation rows — see
        buildInfoRow().
     4. `announce` is a first-class option: every filter pass announces the
        match count through the app's live region (HOUSE-STYLE §5.1).
     5. Escape precedence is DOCUMENTED and enforced (see below) so the
        combobox and ui/card.js can share one Escape key without a race.
   ========================================================================== */

import { escapeRe } from '../core/core.js';

/* ── Constants ───────────────────────────────────────────────────────────── */

/** Blur closes the dropdown on a delay: a mousedown on an option fires
    blur BEFORE the pointer sequence completes, and closing immediately would
    delete the row out from under the click. 120ms is the shortest delay that
    survives a slow tap without being visible as a lingering flyout. */
const BLUR_CLOSE_MS = 120;

/** Zero-results row text. The theme styles `.option-empty` for it — a text
    row, never an empty box. */
const NO_MATCH_TEXT = 'No matches';

/** Ids are generated only when the app didn't give the listbox one; the
    counter keeps two comboboxes on one page from colliding. */
let _listboxSeq = 0;

/**
 * Match tiers, best first. Exported so a consumer (or a test) can reason
 * about ordering without re-deriving it.
 *   LABEL_PREFIX — the label starts with the query ("luc" → "Lucas")
 *   CODE_PREFIX  — the code starts with the query ("390" → FSA id 39095).
 *                  Codes match by PREFIX ONLY: a substring match inside a
 *                  5-digit id is noise, not intent.
 *   WORD_START   — the query starts a later word ("clara" → "Santa Clara")
 *   SUBSTRING    — the query appears anywhere else in the label
 */
export const MATCH_RANK = Object.freeze({
  LABEL_PREFIX: 0,
  CODE_PREFIX: 1,
  WORD_START: 2,
  SUBSTRING: 3,
});

/* ── Pure matching logic (exported underscored for tests) ─────────────────── */

/**
 * Case- and diacritic-insensitive fold. NFD splits "ñ" into "n" + combining
 * tilde; the range strip drops the mark. Typing "canon" therefore finds
 * "Cañon City", and typing "Cañon" finds it too.
 * @param {*} str
 * @returns {string}
 */
export function _fold(str) {
  return String(str == null ? '' : str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip the combining marks NFD exposed
    .toLowerCase();
}

/** A word start is any position preceded by a non-alphanumeric character.
    Position 0 is deliberately excluded — that case is LABEL_PREFIX, a better
    tier. Unicode property escapes keep this right for accented labels after
    the fold has already stripped the marks. */
function _wordStartRe(foldedQuery) {
  return new RegExp('[^\\p{L}\\p{N}]' + escapeRe(foldedQuery), 'u');
}

/**
 * Filter + rank, with no DOM involved.
 * @param {Array<{id: string, label: string, code?: string}>} items
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {{matches: Array<object>, total: number}} `total` counts EVERY
 *          match; `matches` is capped at maxResults. The gap is what the
 *          overflow row reports.
 */
export function _rankItems(items, query, maxResults = 12) {
  const q = _fold(query).trim();
  const cap = Math.max(1, Math.floor(maxResults));
  if (!q || !Array.isArray(items)) return { matches: [], total: 0 };

  const wordStart = _wordStartRe(q);
  const scored = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const label = _fold(item.label);
    const code = _fold(item.code);
    let rank = -1;
    if (label.startsWith(q)) rank = MATCH_RANK.LABEL_PREFIX;
    else if (code && code.startsWith(q)) rank = MATCH_RANK.CODE_PREFIX;
    else if (wordStart.test(label)) rank = MATCH_RANK.WORD_START;
    else if (label.includes(q)) rank = MATCH_RANK.SUBSTRING;
    if (rank >= 0) scored.push({ item, rank, i });
  }
  // Rank first, then the caller's own order — an app that sorted its list
  // alphabetically gets alphabetical results inside each tier.
  scored.sort((a, b) => (a.rank - b.rank) || (a.i - b.i));
  return { matches: scored.slice(0, cap).map((s) => s.item), total: scored.length };
}

/* ── The combobox ────────────────────────────────────────────────────────── */

/**
 * Wire a full ARIA 1.2 combobox (listbox popup) over an existing input and
 * <ul>. Any ARIA attribute the markup already carries is left alone; the rest
 * are set here, so the shell in the theme CSS works with or without them.
 *
 * ESCAPE PRECEDENCE — the rule the whole app depends on:
 *   • dropdown OPEN   → Escape closes it and STOPS: preventDefault() +
 *                       stopPropagation(), so a document-level Escape handler
 *                       (ui/card.js closing the detail card, a <dialog>'s
 *                       native close) does NOT also fire.
 *   • dropdown CLOSED → the event is left completely untouched and bubbles,
 *                       so the same keypress reaches the next layer down.
 *   One Escape dismisses exactly one layer, top-down. ui/card.js honours the
 *   other half of this contract in both directions: it ignores an Escape whose
 *   defaultPrevented is already true, and it sets defaultPrevented when the
 *   card is the layer that closes, so anything below the card can yield the
 *   same way. Every layer in an app owes the stack both halves.
 *
 * @param {object} opts
 * @param {HTMLInputElement} opts.input
 * @param {HTMLElement} opts.dropdown  the <ul> that becomes role="listbox"
 * @param {Array<{id: string, label: string, code?: string}>} [opts.items]
 * @param {(item: object, index: number, li: HTMLLIElement) => (Node|string|void)} [opts.renderRow]
 *        Row content. Return a Node (preferred — no HTML parsing anywhere),
 *        or mutate the `li` you are handed and return nothing. A returned
 *        STRING is inserted as HTML: that is an app-authored, trusted-by-
 *        contract string, the same trust class as ui/help.js's fallbackHTML.
 *        Never build one by concatenating a value you did not escape —
 *        core's escapeHTML() is right there. With no renderRow the row is
 *        `item.label` as text.
 * @param {(item: object, index: number) => void} [opts.onSelect]
 *        Fired on Enter or on a pointer selection. The input's value is
 *        deliberately NOT rewritten here — some apps want the query to stand,
 *        some want it cleared; do it in this callback.
 * @param {number} [opts.maxResults=12]
 * @param {(text: string) => void} [opts.announce]  usually a live region's
 *        announce() — called `${n} matches` on every filter pass.
 * @returns {{refresh: (items: Array<object>) => void, close: () => void,
 *            destroy: () => void}}
 */
export function initSearchBox({
  input, dropdown, items = [], renderRow, onSelect,
  maxResults = 12, announce,
} = {}) {
  if (!input || !dropdown) {
    console.warn('[ridr] initSearchBox: input and dropdown are both required');
    return { refresh() {}, close() {}, destroy() {} };
  }

  let list = Array.isArray(items) ? items.slice() : [];
  let shown = [];            // the items currently rendered as options
  let activeIndex = -1;      // index into `shown`, -1 = nothing active
  let blurTimer = null;

  /* ── ARIA wiring (only what the markup is missing) ─────────────────────── */

  if (!dropdown.id) dropdown.id = 'ridr-listbox-' + (++_listboxSeq);
  if (!dropdown.hasAttribute('role')) dropdown.setAttribute('role', 'listbox');
  if (!input.hasAttribute('role')) input.setAttribute('role', 'combobox');
  if (!input.hasAttribute('aria-autocomplete')) input.setAttribute('aria-autocomplete', 'list');
  if (!input.hasAttribute('aria-haspopup')) input.setAttribute('aria-haspopup', 'listbox');
  if (!input.hasAttribute('aria-controls')) input.setAttribute('aria-controls', dropdown.id);
  // Browser autofill drops a native menu on top of the listbox otherwise.
  if (!input.hasAttribute('autocomplete')) input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-expanded', 'false');
  dropdown.hidden = true;

  const optionId = (i) => dropdown.id + '-opt-' + i;

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  function buildOption(item, i) {
    const li = document.createElement('li');
    li.id = optionId(i);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);
    let out = null;
    if (typeof renderRow === 'function') out = renderRow(item, i, li);
    if (out && typeof Node !== 'undefined' && out instanceof Node) {
      li.appendChild(out);
    } else if (typeof out === 'string') {
      // App-authored markup — see the renderRow contract above.
      li.innerHTML = out;
    } else if (!li.firstChild) {
      li.textContent = String(item && item.label != null ? item.label : '');
    }
    return li;
  }

  /** The zero-results row and the counted overflow row: `role="option"` with
      `aria-disabled="true"`.

      WHY AN OPTION AT ALL. They used to be `role="presentation"`, which is
      correct-looking and wrong: when the query matches NOTHING the "No matches"
      row is the listbox's only child, and a listbox with zero owned options
      fails ARIA's required-children rule — axe scores it CRITICAL, in every
      theme and at every viewport. Disabled options satisfy the role's
      structure while carrying exactly the same meaning.

      They remain unselectable, and that is enforced in four places rather than
      assumed: optionRows() skips them, so arrow navigation and Home/End never
      land on one and aria-activedescendant never names one; Enter reads
      `shown`, which they are not in; and onPointerDown() matches only
      selectable rows, so a mousedown on one is ignored exactly as it was
      before. The theme already styles the disabled state, and the count also
      reaches AT through `announce`, which reports the UNCAPPED total. */
  function buildInfoRow(text, extraClass) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-disabled', 'true');
    li.className = extraClass ? 'option-empty ' + extraClass : 'option-empty';
    li.textContent = text;
    return li;
  }

  /** The SELECTABLE rows, in render order — which is match order. The disabled
      info rows are options for ARIA's sake and for nothing else. */
  function optionRows() {
    return dropdown.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
  }

  function render(matches, total) {
    dropdown.replaceChildren();
    shown = matches;
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    matches.forEach((item, i) => dropdown.appendChild(buildOption(item, i)));
    if (!matches.length) {
      dropdown.appendChild(buildInfoRow(NO_MATCH_TEXT));
    } else if (total > matches.length) {
      dropdown.appendChild(buildInfoRow(
        '…and ' + (total - matches.length) + ' more matches', 'option-more'));
    }
  }

  /* ── Open / close / active option ──────────────────────────────────────── */

  function isOpen() { return !dropdown.hidden; }

  function open() {
    if (isOpen()) return;
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    clearTimeout(blurTimer);
    if (!isOpen()) return;
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  }

  /** In this pattern DOM focus never leaves the input, so :focus-visible can
      never fire on a row. aria-selected + aria-activedescendant ARE the
      active-option state, and the theme styles [aria-selected="true"] with a
      weight change and an inset bar so it doesn't rely on colour alone. */
  function setActive(i) {
    const rows = optionRows();
    rows.forEach((el, idx) => el.setAttribute('aria-selected', String(idx === i)));
    activeIndex = i;
    if (i < 0 || !rows[i]) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', rows[i].id);
    if (typeof rows[i].scrollIntoView === 'function') {
      rows[i].scrollIntoView({ block: 'nearest' });
    }
  }

  /** Arrow keys wrap: down from the last row lands on the first. */
  function move(delta) {
    if (!shown.length) return;
    const n = shown.length;
    const next = activeIndex < 0
      ? (delta > 0 ? 0 : n - 1)
      : ((activeIndex + delta) % n + n) % n;
    setActive(next);
  }

  function pick(i) {
    const item = shown[i];
    if (!item) return;
    close();
    if (typeof onSelect === 'function') onSelect(item, i);
  }

  /* ── Filtering ─────────────────────────────────────────────────────────── */

  function filter() {
    const q = input.value;
    if (!_fold(q).trim()) {       // empty query shows nothing, not everything
      close();
      dropdown.replaceChildren();
      shown = [];
      return;
    }
    const { matches, total } = _rankItems(list, q, maxResults);
    render(matches, total);
    open();
    if (typeof announce === 'function') announce(total + ' matches');
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  function onInput() { filter(); }

  function onFocus() {
    // Coming back to a field that still holds a query re-offers the results.
    if (!isOpen() && _fold(input.value).trim()) filter();
  }

  function onKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        if (!isOpen()) filter(); else move(1);
        e.preventDefault();          // don't run the caret to end-of-field
        break;
      case 'ArrowUp':
        if (isOpen()) move(-1);
        e.preventDefault();
        break;
      case 'Home':
        if (!isOpen() || !shown.length) return;
        setActive(0);
        e.preventDefault();
        break;
      case 'End':
        if (!isOpen() || !shown.length) return;
        setActive(shown.length - 1);
        e.preventDefault();
        break;
      case 'Enter':
        if (!isOpen() || !shown.length) return;   // closed: let the form have it
        // No active row means the user typed and hit Enter: take the top hit,
        // which is the ranked best match.
        pick(activeIndex >= 0 ? activeIndex : 0);
        e.preventDefault();
        break;
      case 'Escape':
        // See the ESCAPE PRECEDENCE block above. Closed → untouched.
        if (!isOpen()) return;
        close();
        e.preventDefault();
        e.stopPropagation();
        break;
      case 'Tab':
        close();                     // no preventDefault: focus still moves on
        break;
      default:
        break;
    }
  }

  /** mousedown, NOT click: mousedown fires before the input's blur, so the
      row is still in the DOM when we read it. preventDefault() on it keeps
      focus in the input, so the blur never happens at all. */
  function onPointerDown(e) {
    // Selectable rows only: a mousedown on a disabled info row falls straight
    // through, untouched, the way it did when those rows were presentational.
    const li = e.target && e.target.closest
      ? e.target.closest('[role="option"]:not([aria-disabled="true"])') : null;
    if (!li || !dropdown.contains(li)) return;
    e.preventDefault();
    // Positional, not a parsed data-index: nothing in this kit coerces a
    // string attribute to a number, and the row order IS the match order.
    const rows = Array.prototype.slice.call(optionRows());
    pick(rows.indexOf(li));
  }

  function onBlur() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(close, BLUR_CLOSE_MS);
  }

  input.addEventListener('input', onInput);
  input.addEventListener('focus', onFocus);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
  dropdown.addEventListener('mousedown', onPointerDown);

  return {
    /** Replace the searchable set (data loaded, vintage swapped, year
        changed). Re-filters in place if the dropdown is open. */
    refresh(next) {
      list = Array.isArray(next) ? next.slice() : [];
      if (isOpen()) filter();
    },
    close,
    destroy() {
      clearTimeout(blurTimer);
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('blur', onBlur);
      dropdown.removeEventListener('mousedown', onPointerDown);
      close();
    },
  };
}
