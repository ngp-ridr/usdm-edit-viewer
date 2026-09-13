/* ============================================================================
   NGP RIDR house-style kit · ui/drawer.js · v0.2.0
   The control drawer: a real column of the app's map row on desktop, an
   off-canvas overlay with a scrim on compact viewports.

   ES module, no build step. Imports only core/core.js.

     import { initDrawer }
       from '../vendor/style/ui/drawer.js';

   Markup is the shell documented in theme/ridr-theme.css § "Control drawer" —
   this module manages those elements, it does not build them:

     <main>                            <!-- display:flex; position:relative -->
       <aside id="drawer" class="ridr-drawer" aria-label="Map controls">
         <div class="ridr-drawer-scroll">
           <section class="ridr-drawer-section"> … </section>
         </div>
       </aside>
       <!-- NEXT SIBLING of the drawer: the theme selects the tab's closed
            position and its chevron direction through
            `.ridr-drawer.is-closed + .ridr-drawer-tab`. -->
       <button id="drawer-tab" class="ridr-drawer-tab" aria-expanded="true"
               aria-controls="drawer" aria-label="Hide controls"> … </button>
       <div id="drawer-scrim" class="ridr-drawer-scrim" hidden aria-hidden="true"></div>
       <div id="map-frame"> … </div>

     const drawerCtl = initDrawer({
       drawer:     document.getElementById('drawer'),
       tab:        document.getElementById('drawer-tab'),   // desktop handle
       toggle:     document.getElementById('btn-drawer'),   // navbar hamburger
       scrim:      document.getElementById('drawer-scrim'),
       storageKey: 'ridr-<app>-drawer',
       onToggle:   (open, { compact }) => { … },
     });

   TWO SURFACES, ONE MODULE. On desktop the drawer is a FIXTURE: a column of the
   row, part of the page, and collapsing it gives its width to the map. Under
   compact it is a LAYER: an overlay over the map with a scrim, which is why
   only the compact half takes focus, raises a scrim, and answers Escape. Every
   one of those differences is decided from the live `viewport` helper, never
   from a boot snapshot — a phone rotates, and a desktop window gets dragged
   narrow.

   The drawer's own accessible name is the app's (`aria-label` on the element).
   The TOGGLES' names are this module's: both are icon-only, both carry
   `aria-expanded`, and both get the swapped `aria-label` from `labels` — synced
   in the same call that flips `.is-closed`, so the accessible state cannot
   drift from the geometry (HOUSE-STYLE §5.7, the disclosure sibling of the
   aria-pressed idiom).

   REGISTRATION ORDER: INIT THIS BEFORE ui/card.js
   ──────────────────────────────────────────────
   One Escape dismisses exactly one layer, top-down, and the layers coordinate
   through `event.defaultPrevented` (ui/card.js § ESCAPE PRECEDENCE). Every
   handler in that contract is on `document`, and listeners on the SAME node run
   in REGISTRATION ORDER — whoever called addEventListener first sees the key
   first. The compact drawer sits at --z-drawer (70), above the detail surface at
   --z-detail (60), so `initDrawer` must run BEFORE `initDetailCard` or a single
   Escape would close the card underneath an open drawer and leave the drawer up.
   Modal `<dialog>`s are outside the ordering: they hold the browser's top layer
   and every handler here stands down for them.

   MAP RESIZE IS NOT THE KIT'S JOB
   ───────────────────────────────
   Opening or closing the desktop fixture changes the map container's width, and
   MapLibre has to be told. That is deliberately not wired here — the kit does
   not know the app has a map, or which of several it is. `onToggle` is the seam,
   and the recipe is:

     onToggle: (open, { compact }) => {
       if (!compact) {
         const settle = () => { map.resize(); zoomFloor.refresh(); };
         // AFTER the slide: the theme animates margin-left over --transition
         // (0.2s), and a resize measured mid-slide reads a width the container
         // is about to leave — which is how you get a letterboxed canvas.
         if (reducedMotion()) settle(); else setTimeout(settle, 240);
       }
       pushState();
     }

   Under reduced motion the CSS blanket clamps the transition to ~0ms, so the
   240ms wait would be a visible stall: resize immediately instead. Read
   `reducedMotion()` at call time, not at wiring time (WCAG 2.3.3).

   ── Attribution ────────────────────────────────────────────────────────────
   Ported from mt-climate-office/mesonet-explorer (MIT) — the `#sidebar` CSS and
   app.js's `setSidebarOpen` / sidebar wiring / `onViewportChange` block. Deltas
   from that source:

     1. ES module with a named export, and generic: `.ridr-drawer` rather than
        one app's `#sidebar`, with the state class on the DRAWER (`.is-closed`)
        instead of on `<body>` (`body.sidebar-closed`) — a page may hold two.
     2. ARIA on BOTH toggles. The original syncs `aria-expanded`, `aria-label`
        and `title` on the edge handle but sets only `aria-expanded` on the
        hamburger, so the compact button's name stays frozen at "Show controls"
        while it is showing an open drawer.
     3. NEW: Escape participation. The original drawer answers no key at all, so
        on a phone the overlay is pointer-dismiss-only. Here Escape closes it
        when — and only when — it is compact and open, yielding to a handled
        event and to an open modal `<dialog>`, and marking the key consumed so
        the layers below stand down.
     4. NEW: focus management, the ui/card.js pattern (guarded opener capture,
        move in on open, put it back on close). The original moves no focus, so
        the compact overlay opens with the reader's cursor still underneath the
        scrim and closes leaving it nowhere.
     5. NEW: a closed drawer leaves the tab order. The theme transitions
        `visibility` with the slide, and this module moves focus out BEFORE that
        lands. The original's closed sidebar keeps its whole control set
        tab-reachable off-screen — a keyboard user tabs through invisible
        controls at every width.
     6. Compact NEVER persists, and entering compact force-closes. Same policy
        as the original, but the desktop preference is also remembered in memory
        so a rotation cannot lose a URL-driven `startOpen` or a session where
        localStorage is unavailable.
     7. `layoutControls()` is NOT ported: moving controls between the drawer and
        the navbar by breakpoint is app-specific, and this fleet's apps author
        their drawer sections statically in HTML instead.
     8. Map resize is the caller's, through `onToggle` (see above). The original
        calls `map.resize()` from inside the setter.
   ========================================================================== */

import { lsGet, lsSet, viewport } from '../core/core.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.drawer  the `.ridr-drawer` element
 * @param {HTMLElement} [opts.tab]   its `.ridr-drawer-tab` edge handle, which
 *        MUST be the drawer's next sibling (theme sibling contract). Desktop.
 * @param {HTMLElement} [opts.toggle] the `.ridr-drawer-toggle` navbar
 *        hamburger, shown by the theme only under compact.
 * @param {HTMLElement} [opts.scrim] the `.ridr-drawer-scrim`, `hidden` at rest.
 *        Shown only while the drawer is open AND compact.
 * @param {string} [opts.storageKey] app-prefixed localStorage key holding the
 *        DESKTOP preference, 'open' | 'closed'. Compact state is never written:
 *        a phone visit must not decide how the next desktop visit opens.
 * @param {boolean} [opts.startOpen] override for the desktop initial state —
 *        this is where a validated URL param goes (URL > storage > default open).
 * @param {{open?: string, close?: string}} [opts.labels] accessible names for
 *        the two icon-only toggles: `open` names the action when the drawer is
 *        closed, `close` when it is open.
 * @param {(open: boolean, ctx: {compact: boolean}) => void} [opts.onToggle]
 *        fired AFTER every state CHANGE, on every route (either toggle, the
 *        scrim, Escape, a viewport flip, programmatic). Not fired for the
 *        initial state — the app is still booting and has nothing to mirror.
 *        Hook `map.resize()` and URL state here; see § MAP RESIZE above.
 * @returns {{open: (o?: {focus?: boolean}) => void,
 *            close: (o?: {restoreFocus?: boolean}) => void,
 *            toggle: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function initDrawer({
  drawer, tab = null, toggle = null, scrim = null,
  storageKey = null,
  startOpen = undefined,
  labels = { open: 'Show controls', close: 'Hide controls' },
  onToggle = null,
} = {}) {
  if (!drawer) {
    console.warn('[ridr] initDrawer: no drawer element');
    return { open() {}, close() {}, toggle() {}, isOpen: () => false, destroy() {} };
  }

  // A caller that passes only one half of `labels` gets the house wording for
  // the other: a partial object REPLACES the default parameter above, it does
  // not merge with it, and a toggle whose name goes `undefined` is a nameless
  // button (axe: button-name).
  const LABEL = { open: 'Show controls', close: 'Hide controls', ...labels };

  /* The desktop preference, resolved once: an explicit startOpen (a URL param
     the app validated) beats storage, storage beats open. It is remembered here
     as well as in localStorage because leaving compact has to restore what THIS
     session last chose — storage may be unavailable (Safari private mode), and
     a URL override has no business being forgotten by a device rotation. */
  let desktopOpen = (typeof startOpen === 'boolean')
    ? startOpen
    : (!storageKey || lsGet(storageKey) !== 'closed');

  let opener = null;

  /* ── ARIA wiring (only what the markup is missing) ─────────────────────── */

  // Decoration: it dims, it says nothing, and it holds nothing focusable.
  if (scrim && !scrim.hasAttribute('aria-hidden')) scrim.setAttribute('aria-hidden', 'true');

  function isOpen() { return !drawer.classList.contains('is-closed'); }

  /* ── Render: the class and the ARIA, always together ───────────────────── */

  function render(open) {
    drawer.classList.toggle('is-closed', !open);
    const name = open ? LABEL.close : LABEL.open;
    for (const el of [tab, toggle]) {
      if (!el) continue;
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.setAttribute('aria-label', name);
      // A hover affordance for the same wording. Both controls are icon-only,
      // and aria-label already outranks title for AT, so the two cannot
      // disagree — they are written from one string.
      el.title = name;
    }
    // The scrim belongs to the compact overlay only. Re-derived on every render
    // so a viewport flip cannot leave a live scrim over a desktop fixture.
    if (scrim) scrim.hidden = !(open && viewport.isCompact());
  }

  /* ── Focus ─────────────────────────────────────────────────────────────── */

  /** The handle that is actually on screen at this size: the navbar hamburger
      under compact (§6 of the theme hides the edge tab there), the edge tab
      otherwise. Picked from the media query rather than from offsetParent,
      because it has to agree with the CSS, not with a layout pass. */
  function currentHandle() {
    const compact = viewport.isCompact();
    const first = compact ? toggle : tab;
    const second = compact ? tab : toggle;
    if (first && first.isConnected) return first;
    if (second && second.isConnected) return second;
    return null;
  }

  /** Remember who opened us — but only a real opener. Re-opening while the
      drawer is already up must not capture something inside the drawer as its
      own opener, or the close would return focus to an element that is about to
      go `visibility: hidden` (the guard ui/card.js documents). */
  function captureOpener() {
    const active = document.activeElement;
    if (active && active !== document.body && !drawer.contains(active)) opener = active;
  }

  function focusIn() {
    if (typeof drawer.focus !== 'function') return;
    // Programmatically focusable, not tab-reachable — the same idiom as
    // ui/card.js. Stamped lazily, and only if the app did not already give the
    // drawer a tabindex of its own.
    if (!drawer.hasAttribute('tabindex')) drawer.setAttribute('tabindex', '-1');
    // Synchronous, and it leans on the theme transitioning `visibility` in the
    // CLOSING direction only (theme § Control drawer): an element that still
    // computes as visibility:hidden in this style pass refuses focus silently,
    // and the reader's cursor stays under the scrim. Don't "tidy" that
    // asymmetry out of the CSS.
    drawer.focus();
  }

  /** FOCUS NEVER RIDES THE SLIDE OUT. The theme transitions `visibility`
      alongside the close, and the moment that lands the browser blurs whatever
      was focused inside to `<body>` — the reader loses their place with no
      warning and no way back. So focus moves out first, BEFORE the class flips,
      in every mode: the desktop fixture is only "always there" while it is
      open.

      Where to: the remembered opener if the drawer is what has focus (a real
      restore), otherwise the handle that is still on screen. If focus is
      already outside the drawer, nothing moves — yanking the cursor off
      something the reader has moved to since is its own defect. */
  function moveFocusOut(restoreFocus) {
    const active = document.activeElement;
    const inside = !!(active && drawer.contains(active));
    const back = opener;
    opener = null;
    if (!inside) return;
    // isConnected: the opener may have been re-rendered away while the drawer
    // was open. Focusing a detached node silently sends focus to <body>.
    if (restoreFocus && back && typeof back.focus === 'function' && back.isConnected) {
      back.focus();
      // …and VERIFY it took. A remembered opener can become display:none
      // between the open and the close — the compact hamburger, once the window
      // is wide again — and focus() on a hidden element silently does nothing,
      // which would leave the cursor inside a drawer that is about to vanish.
      if (document.activeElement === back) return;
    }
    // restoreFocus:false means "something else is placing focus" — but a focus
    // sitting inside a drawer that is about to be hidden still has to be
    // rescued, so it goes to the handle rather than to nowhere.
    const handle = currentHandle();
    if (handle && typeof handle.focus === 'function') handle.focus();
    else if (typeof active.blur === 'function') active.blur();
  }

  /* ── State ─────────────────────────────────────────────────────────────── */

  /**
   * @param {boolean} open
   * @param {object} [o]
   * @param {boolean} [o.persist=true]  record this as the desktop preference
   *        (memory + localStorage). False for the initial state and for
   *        viewport-driven changes, which are not choices the reader made.
   * @param {boolean} [o.focus=true]    move focus into a compact overlay.
   * @param {boolean} [o.restoreFocus=true] hand focus back to the opener.
   */
  function setOpen(open, { persist = true, focus = true, restoreFocus = true } = {}) {
    const compact = viewport.isCompact();
    const was = isOpen();
    if (was && !open) moveFocusOut(restoreFocus);
    render(open);
    if (persist && !compact) {
      desktopOpen = open;
      if (storageKey) lsSet(storageKey, open ? 'open' : 'closed');
    }
    // Focus follows the OVERLAY in, not the fixture: the compact drawer covers
    // the map, so the next Tab has to land inside it. The desktop fixture is
    // part of the page — moving the cursor there because a column appeared
    // would be taking it from wherever the reader was working.
    if (open && !was && compact && focus) focusIn();
    if (was !== open && typeof onToggle === 'function') onToggle(open, { compact });
  }

  function open({ focus = true } = {}) {
    if (isOpen()) return;
    captureOpener();
    setOpen(true, { focus });
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    setOpen(false, { restoreFocus });
  }

  function toggleOpen() { if (isOpen()) close(); else open(); }

  /* ── Events ────────────────────────────────────────────────────────────── */

  function onHandleClick() { toggleOpen(); }
  function onScrimClick() { close(); }

  if (tab) tab.addEventListener('click', onHandleClick);
  if (toggle) toggle.addEventListener('click', onHandleClick);
  // The scrim is the pointer route out of the compact overlay. Escape below is
  // its keyboard twin — a pointer-only dismissal over a surface that has taken
  // focus is a keyboard trap.
  if (scrim) scrim.addEventListener('click', onScrimClick);

  /** Is a modal <dialog> holding the top layer? If so it owns this Escape and
      the browser is already closing it. `:modal` needs a try/catch: an engine
      that doesn't know the pseudo-class throws on the selector, and the
      conservative fallback (any open dialog) errs toward leaving the drawer
      alone. Same helper, same reasoning, as ui/card.js. */
  function modalIsOpen() {
    try {
      return !!document.querySelector('dialog:modal');
    } catch (e) {
      return !!document.querySelector('dialog[open]');
    }
  }

  /** ESCAPE PRECEDENCE, this drawer's half of the contract:

        • DESKTOP IS NOT A LAYER. The fixture is part of the page — the reader
          set its width and expects it to stay — so Escape falls straight
          through to whatever is stacked over the map. Escape does not
          "un-arrange" a page.
        • Compact and open → close AND preventDefault(), because the overlay IS
          a layer, and the layers below (ui/card.js's sheet, an app's scrim) read
          that flag to know the key is spoken for.
        • A layer ABOVE us already consumed the key (defaultPrevented), or a
          modal <dialog> owns it → do nothing.

      Registered on `document` in the bubble phase, not on the drawer: focus is
      usually on the map canvas or a navbar control while the drawer is open. See
      § REGISTRATION ORDER — this handler must be added before ui/card.js's. */
  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (!viewport.isCompact() || !isOpen()) return;
    if (e.defaultPrevented || modalIsOpen()) return;
    close();
    e.preventDefault();
  }
  // Esc needs no ?kbd=off opt-out — WCAG 2.1.4 covers printable
  // single-character shortcuts, which this is not.
  document.addEventListener('keydown', onKeyDown);

  const unsubViewport = viewport.onChange(() => {
    if (viewport.isCompact()) {
      // Crossing INTO compact turns the fixture into an overlay over the map.
      // Force it closed — and don't persist that, or a rotation would rewrite
      // the desktop preference. restoreFocus:false: nobody asked for this
      // close, so there is no opener to go back to; a focus that was inside is
      // still rescued to the handle.
      setOpen(false, { persist: false, restoreFocus: false });
    } else {
      // Crossing back OUT restores the preference this session is holding.
      setOpen(desktopOpen, { persist: false });
    }
  });

  /* Initial state. Compact starts CLOSED, always — a drawer that opens itself
     over a phone's map is worse than useless — and that is not a preference, so
     it is neither persisted nor announced. Desktop takes the resolved
     preference. Straight through render(), not setOpen(): the initial state is
     not a change, so it neither persists nor fires onToggle — the app is still
     wiring itself up and has nothing to mirror yet. */
  render(viewport.isCompact() ? false : desktopOpen);

  return {
    open,
    close,
    toggle: toggleOpen,
    isOpen,
    destroy() {
      unsubViewport();
      if (tab) tab.removeEventListener('click', onHandleClick);
      if (toggle) toggle.removeEventListener('click', onHandleClick);
      if (scrim) scrim.removeEventListener('click', onScrimClick);
      document.removeEventListener('keydown', onKeyDown);
      // The scrim comes DOWN. Everything else is left exactly as it stands (the
      // class, the ARIA, the tabindex) — destroy() tears down the controller,
      // not the page, the same way ui/card.js leaves a hidden card hidden. But
      // an orphaned scrim is a full-bleed pointer blocker with nothing left
      // listening to dismiss it, which is a trap rather than a state.
      if (scrim) scrim.hidden = true;
      opener = null;
    },
  };
}
