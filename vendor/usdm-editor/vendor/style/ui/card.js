/* ============================================================================
   NGP RIDR house-style kit · ui/card.js · v0.2.0
   The county detail card: a docked panel over the map that becomes a bottom
   sheet on compact viewports.

   ES module, no build step. Imports only core/core.js.

     import { initDetailCard }
       from '../vendor/style/ui/card.js';

   Markup is the shell documented in theme/ridr-theme.css § "Detail card" —
   this module manages that element, it does not build it:

     <div class="ridr-card" id="county-card" aria-labelledby="card-title" hidden>
       <div class="ridr-card-head">
         <h2 class="ridr-card-title" id="card-title">County</h2>
         <button type="button" class="card-close" id="card-close"
                 aria-label="Close county details">×</button>
       </div>
       <div class="ridr-card-body"> … </div>
     </div>

     const cardCtl = initDetailCard({
       card:     document.getElementById('county-card'),
       closeBtn: document.getElementById('card-close'),
       onClose:  () => { selectedId = null; repaint(); pushState(); },
     });
     cardCtl.open();

   The card is where the CHOROPLETH GETS ITS NUMBER (HOUSE-STYLE §6): colour is
   never the sole channel, and on a county map the readout in this card is the
   cheapest and best redundancy. Filling it is the app's job; keeping it
   accessible is this module's.

   WHY NOT <dialog> — the documented exception
   ───────────────────────────────────────────
   `showModal()` puts the element in the browser's top layer, traps focus, and
   makes everything behind it inert. On a map app that would kill the map: the
   user could no longer pan, zoom, hover another county, or use the search box
   while a county is open — and those are exactly the things you do WITH a
   county open. So this is `role="dialog"` + `aria-modal="false"` +
   `tabindex="-1"`, with the focus management written out by hand here:
   capture the opener, move focus in on open, put it back on close. Same
   exception the mco-web-style exemplar documents on its station card
   (exemplar/index.html: "NOT a <dialog>: showModal() would trap focus and kill
   map interaction"), and the same reason.

   ── Attribution ────────────────────────────────────────────────────────────
   Focus management ported from mt-climate-office/mco-web-style (MIT) —
   exemplar/app.js `openStation` / `closeCard` / the document-level Escape
   handler. Deltas from that source:

     1. ES module with a named export; the card shell is generic (any docked
        detail surface), not station-specific.
     2. The opener capture is guarded: re-opening for a SECOND feature while
        the card is already open no longer overwrites the remembered opener
        with the card itself (the exemplar's `_cardOpener =
        document.activeElement` on every open loses the real opener as soon as
        focus is inside the card).
     3. Escape yields to a handled event (`defaultPrevented`) so a combobox
        dropdown and this card can share one Escape key — see ui/search.js §
        ESCAPE PRECEDENCE — and MARKS the key consumed when it is this card
        that closes, so the layers below can yield in turn.
     4. NEW: the compact bottom-sheet height stamp (`--sheet-h`), which the
        theme's MapLibre corner controls and toast lift by. MCO has no card
        component and no sheet.
   ========================================================================== */

import { viewport } from '../core/core.js';

/* The sheet height is measured twice: once synchronously (the read forces the
   layout the unhide just invalidated) and once on the next frame, which
   catches a late web-font swap or an image that changed the card's height. */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.card       the `.ridr-card` element (starts `hidden`)
 * @param {HTMLElement} [opts.closeBtn] its `.card-close` button
 * @param {() => void} [opts.onClose]   fired AFTER the card hides, on every
 *        close route (button, Escape, programmatic). Clear selection, repaint
 *        the map, mirror URL state here.
 * @param {string} [opts.sheetVar='--sheet-h']  custom property stamped on
 *        <html> with the sheet's rendered height while it is docked. The theme
 *        hooks it in calc() twice: the bottom MapLibre control containers and
 *        the toast both lift by it. Cleared to '0px' on close, which makes
 *        every one of those calc()s inert again.
 * @returns {{open: (o?: {focus?: boolean}) => void,
 *            close: (o?: {restoreFocus?: boolean}) => void,
 *            isOpen: () => boolean, destroy: () => void}}
 */
export function initDetailCard({ card, closeBtn, onClose, sheetVar = '--sheet-h' } = {}) {
  if (!card) {
    console.warn('[ridr] initDetailCard: no card element');
    return { open() {}, close() {}, isOpen: () => false, destroy() {} };
  }

  const root = document.documentElement;
  let opener = null;
  let rafId = null;
  let ro = null;

  /* ── ARIA wiring (only what the markup is missing) ─────────────────────── */

  if (!card.hasAttribute('role')) card.setAttribute('role', 'dialog');
  // Explicitly FALSE, not omitted: it tells AT the rest of the page is still
  // live, which on this surface is the truth and the whole point.
  if (!card.hasAttribute('aria-modal')) card.setAttribute('aria-modal', 'false');
  // Programmatically focusable, not tab-reachable: focus is moved here on
  // open so the next Tab lands inside the card, but the card itself never
  // appears in the tab order of a page where it is closed.
  if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');

  function isOpen() { return !card.hidden; }

  /* ── Compact bottom sheet: stamp the rendered height ───────────────────── */

  function clearSheet() { root.style.setProperty(sheetVar, '0px'); }

  function stampSheet() {
    // Never read layout on a hidden element (it measures 0 and would stamp a
    // 0px sheet over a real one), and never on a floating card — only the
    // compact dock is what the corner controls need to clear.
    if (!isOpen() || !viewport.isCompact()) { clearSheet(); return; }
    const rect = card.getBoundingClientRect();
    // getBoundingClientRect includes the safe-area padding the compact rule
    // adds, which is exactly what the corner controls have to clear.
    root.style.setProperty(sheetVar, Math.round(rect.height) + 'px');
  }

  function scheduleStamp() {
    stampSheet();
    if (typeof requestAnimationFrame !== 'function') return;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      stampSheet();
    });
  }

  // Height changes with content (a longer county name wrapping), with device
  // rotation, and with a mobile URL bar showing or hiding. ResizeObserver
  // catches all three; the resize listener is the fallback where it isn't.
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (isOpen()) stampSheet(); });
    ro.observe(card);
  }
  function onResize() { if (isOpen()) scheduleStamp(); }
  window.addEventListener('resize', onResize);
  const unsubViewport = viewport.onChange(() => {
    // Crossing the compact edge flips the card between floating and docked:
    // stamp when it just became a sheet, clear when it stopped being one.
    if (isOpen()) scheduleStamp(); else clearSheet();
  });

  /* ── Open / close ──────────────────────────────────────────────────────── */

  function open({ focus = true } = {}) {
    // Remember who opened us — but only a real opener. Re-opening for a
    // second county while the card is already up must not capture the card
    // (or the close button inside it) as its own opener, or Escape would
    // return focus to an element that is about to be hidden.
    const active = document.activeElement;
    if (active && active !== document.body && !card.contains(active)) opener = active;
    card.hidden = false;
    // preventScroll: the dock-right variant enters under a translateX
    // animation, so at focus time the card can still overhang its scroll
    // ancestors — the default focus-scroll-into-view then drags an
    // overflow: hidden map row sideways and the shift outlives the
    // animation. The card is always fully in view once settled; this
    // focus never needs to scroll anything.
    if (focus && typeof card.focus === 'function') card.focus({ preventScroll: true });
    scheduleStamp();
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;    // also the re-entrancy guard for onClose()
    card.hidden = true;
    clearSheet();
    const back = opener;
    opener = null;
    // isConnected: the opener may have been re-rendered away while the card
    // was open (a search result row, a repainted list). Focusing a detached
    // node silently sends focus to <body>, losing the user's place.
    if (restoreFocus && back && typeof back.focus === 'function' && back.isConnected) {
      back.focus();
    }
    if (typeof onClose === 'function') onClose();
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  function onCloseClick() { close(); }
  if (closeBtn) closeBtn.addEventListener('click', onCloseClick);

  /** Is a modal <dialog> holding the top layer? If so it owns this Escape and
      the browser is already closing it — the card must not go down with it.
      `:modal` needs a try/catch: an engine that doesn't know the pseudo-class
      throws on the selector, and the conservative fallback (any open dialog)
      errs toward leaving the card alone. */
  function modalIsOpen() {
    try {
      return !!document.querySelector('dialog:modal');
    } catch (e) {
      return !!document.querySelector('dialog[open]');
    }
  }

  /** ESCAPE PRECEDENCE, this card's half of the contract (the other half is
      written out in ui/search.js):

        • a layer ABOVE us already consumed the key → do nothing. ui/search.js
          closes its dropdown with preventDefault + stopPropagation, and a
          modal <dialog> closes itself in the top layer.
        • this card consumes it → close AND preventDefault(), so every layer
          BELOW can tell the key is spoken for.

      That second half is the fix for a real defect: without the
      preventDefault() a single Escape dismissed the card AND the scrim
      underneath it, because a document-level handler further down the page had
      no flag to test — the card read `defaultPrevented` but never set it.
      Anything that listens for Escape below a card MUST check
      `event.defaultPrevented` and stand down when it is true. One Escape
      dismisses exactly one layer, top-down.

      Not stopPropagation(): every one of these handlers is on `document`, and
      stopping propagation between listeners on the SAME node needs
      stopImmediatePropagation(), which would silence layers by registration
      order — the opposite of a stacking contract. The flag is the contract. */
  function onKeyDown(e) {
    if (e.key !== 'Escape' || !isOpen()) return;
    if (e.defaultPrevented || modalIsOpen()) return;
    close();
    e.preventDefault();
  }
  // Document-level, not card-level: focus is usually on the map canvas or the
  // search field while the card is open, so a listener on the card would
  // never see the key. Esc needs no ?kbd=off opt-out — WCAG 2.1.4 covers
  // printable single-character shortcuts, which this is not.
  document.addEventListener('keydown', onKeyDown);

  return {
    open,
    close,
    isOpen,
    destroy() {
      if (rafId != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', onResize);
      unsubViewport();
      if (closeBtn) closeBtn.removeEventListener('click', onCloseClick);
      document.removeEventListener('keydown', onKeyDown);
      clearSheet();
    },
  };
}
