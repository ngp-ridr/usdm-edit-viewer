/* ============================================================================
   NGP RIDR house-style kit · ui/help.js · v0.2.0
   The help / info modal: repo-authored markdown, rendered into the kit's
   native <dialog> shell, with the first-visit auto-open gate.

   ES module, no build step. Imports core/core.js and the vendored ESM build of
   marked — the kit's ONE runtime library import, pinned by library version and
   shipped inside the release snapshot.

     import { initHelpModal }
       from '../vendor/style/ui/help.js';

     const help = initHelpModal({
       dialog:  document.getElementById('help-modal'),
       trigger: document.getElementById('btn-help'),
       url:     'help.md',                       // ships in THIS app's repo
       fallbackHTML: '<p>Help is unavailable offline…</p>',
       firstVisitKey: 'ridr-ngp-seen-intro',     // app-prefixed — AGENTS.md
       suppressAutoOpen: params.has('county') || params.has('year'),
     });
     await help.ready;

   Markup is the kit's modal shell (theme/ridr-theme.css § "Modal"):

     <dialog class="ridr-modal" id="help-modal" aria-labelledby="help-title">
       <div class="info-modal-box">
         <div class="info-modal-header">
           <h2 class="info-modal-title" id="help-title">How to read this map</h2>
           <button type="button" class="modal-close" data-close-modal
                   aria-label="Close help">×</button>
         </div>
         <div class="info-section" data-help-content></div>
       </div>
     </dialog>

   ╔══════════════════════════════════════════════════════════════════════════╗
   ║ GUARDRAIL — REPO-AUTHORED MARKDOWN ONLY.                                 ║
   ║                                                                          ║
   ║ This module is a markdown renderer wired to innerHTML. `url` must point  ║
   ║ at a file that ships in the app's OWN source tree, reviewed like any     ║
   ║ other source file. Pointing it at user-supplied content, a URL           ║
   ║ parameter, a comment field, an upload, or any third-party host turns it  ║
   ║ into an XSS vector: markdown permits raw HTML, marked passes it through  ║
   ║ by design, and THERE IS NO SANITIZER IN THIS KIT — deliberately, and     ║
   ║ there is not going to be one (AGENTS.md §12). `fallbackHTML` is the      ║
   ║ same contract: an author-written literal, never interpolated data.       ║
   ║                                                                          ║
   ║ If you find yourself wanting to render something a user typed, you want  ║
   ║ textContent, not this module.                                            ║
   ╚══════════════════════════════════════════════════════════════════════════╝

   ── Attribution ────────────────────────────────────────────────────────────
   The first-visit gate is ported from mt-climate-office/mco-web-style (MIT) —
   exemplar/app.js's `mco-exemplar-seen-intro` block. Deltas from that source:

     1. ES module with a named export; the modal's open/close/focus-restore is
        delegated to core's initInfoModal rather than re-implemented.
     2. Content is fetched markdown instead of hand-written HTML in the page,
        so help copy is reviewable prose in the repo rather than a wall of
        <p> tags in index.html.
     3. The seen-key is written AT OPEN, never at close. Writing it at close
        is a real fielded bug: mesonet_app's UMRB build-status map wrote its
        key in the dialog's `close` handler, so anyone who navigated away
        without dismissing the modal was shown it again on EVERY visit
        (fixed in flight during that app's migration — mco CONSUMERS.md,
        UMRB Build Status row). Any open marks the tour seen.
     4. The deep-link suppression the exemplar hard-codes (`['station','net',
        'lng'].some(...)`) is a caller decision here: pass `suppressAutoOpen`.
        A visitor sent to a specific county and year does not need the tour.
   ========================================================================== */

import { marked } from '../vendor-esm/marked-18.0.10/marked.esm.js';
import { initInfoModal, lsGet, lsSet } from '../core/core.js';

/** Matches the exemplar's dwell: long enough that the modal reads as a
    deliberate greeting rather than a flash during first paint. */
const AUTO_OPEN_MS = 350;

/* GFM is on for TABLES — help copy in this fleet is mostly tables (program
   year → boundary vintage, county → determination). Options are passed
   per-parse rather than through marked.setOptions() so this module never
   mutates global marked state for anything else on the page. */
const MARKED_OPTS = { gfm: true };

/**
 * @param {object} opts
 * @param {HTMLDialogElement} opts.dialog
 * @param {HTMLElement} [opts.trigger]  the button that opens it
 * @param {string} [opts.url]  markdown that ships in the app's repo — read the
 *        guardrail above before you pass anything else
 * @param {string} [opts.fallbackHTML]  author-written HTML shown when the
 *        fetch or the parse fails, so the modal is never an empty box offline
 * @param {string} [opts.firstVisitKey]  app-prefixed localStorage key
 *        (`ridr-<app>-*`). Present + unset + not suppressed → auto-open once.
 * @param {boolean} [opts.suppressAutoOpen=false]  pass true for a deep link.
 * @returns {{open: () => void, close: () => void, ready: Promise<void>}}
 *          `ready` resolves when the content is in the DOM — including the
 *          fallback path, which is a success, not a rejection.
 */
export function initHelpModal({
  dialog, trigger, url, fallbackHTML, firstVisitKey, suppressAutoOpen = false,
} = {}) {
  if (!dialog) {
    console.warn('[ridr] initHelpModal: no dialog element');
    return { open() {}, close() {}, ready: Promise.resolve() };
  }

  // core owns the modal mechanics: opener-captured focus restore (so it works
  // with several triggers), backdrop-click close, [data-close-modal]
  // delegation. Esc is the <dialog> element's own.
  //
  // The trigger is deliberately NOT handed to core: it is wired below to the
  // wrapped open() instead, so there is exactly ONE open path and the
  // first-visit key is written on every one of them. core's open() still runs
  // underneath and still captures document.activeElement as the opener.
  const modal = initInfoModal({ dialog });

  /** Wrap core's open so EVERY route — the trigger, a keyboard shortcut, the
      first-visit timer — marks the tour seen at the moment it is shown. */
  function open() {
    if (firstVisitKey) lsSet(firstVisitKey, '1');
    modal.open();
  }
  if (trigger) trigger.addEventListener('click', open);

  function contentEl() {
    const found = dialog.querySelector('[data-help-content]');
    if (found) return found;
    // No slot in the markup: make one, inside the box if there is a box, so
    // it inherits the .info-section prose styling either way.
    const box = dialog.querySelector('.info-modal-box') || dialog;
    const div = document.createElement('div');
    div.className = 'info-section';
    div.setAttribute('data-help-content', '');
    box.appendChild(div);
    return div;
  }

  const ready = (async () => {
    const el = contentEl();
    try {
      if (!url) throw new Error('no url');
      const res = await fetch(url);
      if (!res.ok) throw new Error('help fetch failed: ' + res.status);
      const md = await res.text();
      // Repo-authored markdown → HTML. See the guardrail block above.
      el.innerHTML = marked.parse(md, MARKED_OPTS);
    } catch (err) {
      if (url) console.warn('[ridr] initHelpModal: falling back to inline help.', err);
      // Author-supplied trusted string; the modal must never be an empty box.
      if (fallbackHTML) el.innerHTML = fallbackHTML;
    }
  })();

  if (firstVisitKey && !lsGet(firstVisitKey) && !suppressAutoOpen) {
    ready.then(() => {
      setTimeout(() => {
        // Something else may have opened it in the meantime — a fast reader
        // clicking the trigger, another dialog taking the top layer. Re-read
        // the key too: because it is written AT OPEN, a reader who opened AND
        // closed help inside these 350ms has already seen it, and re-opening
        // it under them would be the same bug from the other direction.
        if (!dialog.open && !lsGet(firstVisitKey)) open();
      }, AUTO_OPEN_MS);
    });
  }

  return { open, close: modal.close, ready };
}
