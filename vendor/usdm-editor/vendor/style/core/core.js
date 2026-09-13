/* ============================================================================
   NGP RIDR house-style kit · core/core.js · v0.2.0
   Framework-free shared utilities for NGP RIDR web apps.

   ES module, no build step, zero dependencies. Import it pinned to a release:

     import { setTheme, showToast, kitUrl }
       from '../vendor/style/core/core.js';

   Contents: constants · storage · strings · fetch · reduced motion (live) ·
   viewport (compact/touch) · toast · theme · live region · info modal ·
   collapsible · collapsible search · URL state · kit asset URLs.

   ── Attribution ────────────────────────────────────────────────────────────
   Ported from mt-climate-office/mco-web-style, core/mco-core.js (MIT).
   Deltas from that source:

     1. ES module with named exports — no IIFE, no `window.MCO` global. All
        module-level media-query wiring is guarded so the file can also be
        imported by a test runner outside a browser (browser behavior, incl.
        the load-time .is-compact/.is-touch stamp, is unchanged).
     2. Theme: THEME_KEY is 'ridr-theme'; THEMES is the two-value list
        ['light', 'high-contrast']; initThemeToggle() is a BINARY toggle
        driving aria-pressed + an aria-label swap. MCO's three-theme cycle
        with sun/moon icon swapping is deliberately not ported.
     3. Mountain-time helpers (TZ, todayMT, currentHourMT, hhmmNowMT,
        shiftDate, formatStampMT, formatDateMT, formatDateStr,
        lastCompleteHourMT, pad2) are NOT ported — MCO-specific. The kit's
        admission rule is to wait for two consumers that need them.
     4. Anti-flash / first-paint theme boot lives in the consumer page
        (snippets/anti-flash.html). Core only reads and writes the
        already-stamped documentElement.dataset.theme.
     5. NEW: kitUrl() / _kitRootFromModuleUrl() — resolve kit-root-relative
        asset paths against this module's own URL. MCO had no equivalent;
        their assets ride absolute CDN URLs.
     6. Class names on DOM this module creates are .ridr-* (.ridr-toast, not
        .mco-toast); the live region keeps the shared .sr-only utility class.
     7. getTheme() re-validates the stamped value against THEMES (house rule:
        re-validate anything a URL, another app, or an older build wrote).
   ========================================================================== */

/* ── Constants ───────────────────────────────────────────────────────────── */

/** Version of the kit this module ships in. Matches the /vX.Y.Z/ release dir. */
export const KIT_VERSION = '0.2.0';

// Deliberately shared across every sustainable-fsa.com app on the origin: a
// theme choice in one app follows the user into the others. App-private keys
// must be app-prefixed ('ridr-<app>-*') and re-validated on read like URL
// params — another app (or an old version) may have written something
// unexpected.
export const THEME_KEY = 'ridr-theme';

/** The only themes the kit ships. Anything else is treated as unset. */
export const THEMES = ['light', 'high-contrast'];

/* ── Storage (throw-safe: Safari private mode, disabled storage, etc.) ───── */

export function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}

/* ── Strings ─────────────────────────────────────────────────────────────── */

export function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── Fetch ───────────────────────────────────────────────────────────────── */

/**
 * GET JSON with a hard timeout.
 * @param {string} url
 * @param {{timeoutMs?: number, cache?: RequestCache}} [opts]
 *        cache is a passthrough — polling loops want 'no-store'.
 * @returns {Promise<any>} rejects on non-2xx and on timeout (AbortError).
 */
export function fetchJSON(url, { timeoutMs = 60000, cache } = {}) {
  const init = { signal: AbortSignal.timeout(timeoutMs) };
  if (cache) init.cache = cache;
  return fetch(url, init).then((res) => {
    if (!res.ok) throw new Error('API error ' + res.status);
    return res.json();
  });
}

/**
 * Promise cache: key → Promise. Storing promises (not values) dedupes
 * concurrent identical requests; failed promises evict themselves so a retry
 * refetches.
 * @returns {{cached: (key: string, maker: () => any) => Promise<any>,
 *            invalidate: (substr: string) => void, clear: () => void}}
 */
export function promiseCache() {
  const cache = new Map();
  return {
    cached(key, maker) {
      if (!cache.has(key)) {
        const p = Promise.resolve().then(maker).catch((err) => {
          cache.delete(key);
          throw err;
        });
        cache.set(key, p);
      }
      return cache.get(key);
    },
    invalidate(substr) {
      Array.from(cache.keys()).forEach((key) => {
        if (key.includes(substr)) cache.delete(key);
      });
    },
    clear() { cache.clear(); },
  };
}

/* ── Media queries (guarded so the module imports outside a browser) ─────── */

function _mq(query) {
  return (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    ? window.matchMedia(query)
    : null;
}

/* ── Reduced motion — LIVE, not a boot snapshot ──────────────────────────────
   Call reducedMotion() at animation time so toggling the OS setting
   mid-session takes effect immediately. CSS transitions are clamped by the
   blanket rule in the theme CSS; this gate is for JS-driven animation (map
   camera moves, timeouts that pace a reveal). */

let _rmMq;
export function reducedMotion() {
  if (_rmMq === undefined) _rmMq = _mq('(prefers-reduced-motion: reduce)');
  return !!(_rmMq && _rmMq.matches);
}

/* ── Viewport: compact + touch, as a tiny pub-sub ────────────────────────────
   "Compact" = a viewport where a ~320px anchored popup can't be shown whole
   inside the map: narrow phones AND short/landscape ones. Layout stays in real
   @media rules (no flash before deferred JS runs); these flags drive the
   choices JS has to make — sheet vs. anchored popup, panel auto-collapse.
   Stamps .is-compact / .is-touch on <html> for CSS hooks. */

// MUST match the breakpoint comment in theme CSS §6.
const COMPACT_MQ = '(max-width: 640px), (max-height: 560px)';

const _vpSubs = new Set();
const _compactMq = _mq(COMPACT_MQ);
const _touchMq = _mq('(hover: none)');

function _emitViewport() {
  const root = (typeof document !== 'undefined') ? document.documentElement : null;
  if (root) {
    root.classList.toggle('is-compact', !!(_compactMq && _compactMq.matches));
    root.classList.toggle('is-touch', !!(_touchMq && _touchMq.matches));
  }
  _vpSubs.forEach((fn) => {
    try { fn(); } catch (e) { console.error(e); }
  });
}

if (_compactMq) _compactMq.addEventListener('change', _emitViewport);
if (_touchMq) _touchMq.addEventListener('change', _emitViewport);
if (_compactMq || _touchMq) _emitViewport(); // stamp before first paint of JS-built UI

export const viewport = {
  COMPACT_MQ,
  isCompact() { return !!(_compactMq && _compactMq.matches); },
  isTouch() { return !!(_touchMq && _touchMq.matches); },
  /** Subscribe to compact/touch flips. @returns {() => void} unsubscribe */
  onChange(fn) {
    _vpSubs.add(fn);
    return () => { _vpSubs.delete(fn); };
  },
};

/* ── Toast ───────────────────────────────────────────────────────────────── */

/**
 * @param {{element?: HTMLElement, duration?: number}} [opts]
 * @returns {{element: HTMLElement, show: (msg: string, ms?: number) => void,
 *            hide: () => void}}
 * With no element, one is created and appended to <body> (class .ridr-toast,
 * styled by the theme CSS, announced politely via role="status").
 */
export function createToast({ element, duration = 2800 } = {}) {
  let el = element;
  if (!el) {
    el = document.createElement('div');
    el.className = 'ridr-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  let timer;
  return {
    element: el,
    show(msg, ms) {
      clearTimeout(timer);
      el.textContent = msg;
      el.classList.add('visible');
      timer = setTimeout(() => { el.classList.remove('visible'); }, ms || duration);
    },
    hide() {
      clearTimeout(timer);
      el.classList.remove('visible');
    },
  };
}

// Singleton convenience — most pages want exactly one toast.
let _toast = null;
export function showToast(msg, ms) {
  if (!_toast) _toast = createToast();
  _toast.show(msg, ms);
}

/* ── Theme ───────────────────────────────────────────────────────────────────
   The anti-flash snippet in the page <head> stamps
   documentElement.dataset.theme before first paint; core only reads and
   writes it from there. */

/** @returns {'light'|'high-contrast'} the stamped theme, re-validated. */
export function getTheme() {
  const t = (typeof document !== 'undefined')
    ? document.documentElement.dataset.theme
    : null;
  return THEMES.includes(t) ? t : 'light';
}

/**
 * @param {'light'|'high-contrast'} theme
 * @param {{persist?: boolean}} [opts]
 * @returns {string} the theme now in effect (unchanged if `theme` is invalid).
 */
export function setTheme(theme, { persist = true } = {}) {
  if (!THEMES.includes(theme)) {
    console.warn('[ridr] ignoring unknown theme:', theme);
    return getTheme();
  }
  document.documentElement.dataset.theme = theme;
  if (persist) lsSet(THEME_KEY, theme);
  return theme;
}

/** Binary flip: light ⇄ high-contrast. @returns {string} the new theme. */
export function toggleTheme() {
  const next = getTheme() === 'high-contrast' ? 'light' : 'high-contrast';
  return setTheme(next);
}

/**
 * Wire a binary theme-toggle button. The button is a pressed-state control:
 * aria-pressed is true exactly when the high-contrast theme is active. Map
 * re-styling, canvas repaints, etc. go in onChange:
 *
 *   initThemeToggle({ button, onChange: (t) => map.setStyle(styleFor(t)) });
 *
 * @param {{button: HTMLElement, onChange?: (theme: string) => void,
 *          setAriaLabel?: boolean}} opts
 * @returns {{sync: () => void, toggle: () => string}}
 */
export function initThemeToggle({ button, onChange = null, setAriaLabel = true }) {
  function sync() {
    const hc = getTheme() === 'high-contrast';
    button.setAttribute('aria-pressed', String(hc));
    if (setAriaLabel) {
      button.setAttribute('aria-label',
        hc ? 'Switch to standard theme' : 'Switch to high-contrast theme');
    }
  }
  function toggle() {
    const next = toggleTheme();
    sync();
    if (onChange) onChange(next);
    return next;
  }
  button.addEventListener('click', toggle);
  sync();
  return { sync, toggle };
}

/* ── Screen-reader live region ───────────────────────────────────────────────
   A polite aria-live region for announcing what just changed on a canvas or
   WebGL surface a screen reader can't see: "42 counties shown", "Kansas
   opened". Pair with the hidden-table twin. */

/** @returns {{element: HTMLElement, announce: (text: string) => void}} */
export function createLiveRegion() {
  const el = document.createElement('div');
  el.className = 'sr-only';
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');   // announce replacements whole
  document.body.appendChild(el);
  return {
    element: el,
    announce(text) { el.textContent = text; },
  };
}

/* ── Info modal (native <dialog>) ────────────────────────────────────────────
   Opener-captured focus restore (works with multiple openers), backdrop click
   to close, [data-close-modal] delegation for close buttons. Esc is handled
   natively by <dialog>. */

/**
 * @param {{dialog: HTMLDialogElement, trigger?: HTMLElement}} opts
 * @returns {{open: () => void, close: () => void}}
 */
export function initInfoModal({ dialog, trigger }) {
  let opener = null;

  function open() {
    opener = document.activeElement;
    dialog.showModal();
  }
  if (trigger) trigger.addEventListener('click', open);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.dataset.closeModal !== undefined) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (opener && opener.focus) opener.focus();   // a11y: return focus to the opener
    opener = null;
  });
  return { open, close: () => dialog.close() };
}

/* ── Collapsible panel ───────────────────────────────────────────────────────
   Wires a toggle button (gets aria-expanded) to a body element (gets
   [hidden]). Optional persistence and compact-viewport auto-collapse: on a
   phone the panel starts collapsed unless the user has expressed a
   preference — persisted or URL-driven state should win, so pass
   startCollapsed explicitly when you have one. */

/**
 * @param {{toggle: HTMLElement, body: HTMLElement, storageKey?: string,
 *          startCollapsed?: boolean, autoCollapseOnCompact?: boolean,
 *          onChange?: (collapsed: boolean) => void}} opts
 * @returns {{isCollapsed: () => boolean, collapse: () => void,
 *            expand: () => void}}
 */
export function initCollapsible({
  toggle, body, storageKey = null, startCollapsed,
  autoCollapseOnCompact = false, onChange = null,
}) {
  let collapsed = false;
  if (typeof startCollapsed === 'boolean') {
    collapsed = startCollapsed;
  } else if (storageKey && lsGet(storageKey) != null) {
    collapsed = lsGet(storageKey) === '1';
  } else if (autoCollapseOnCompact && viewport.isCompact()) {
    collapsed = true;
  }

  // Collapse animates (slide + fade via .is-collapsing in the theme CSS),
  // THEN sets [hidden] so collapsed content leaves the tab order and the
  // accessibility tree. The timeout is a fallback in case transitionend never
  // fires (display flips, interrupted transitions).
  const ANIM_FALLBACK_MS = 300;

  function apply(persist, animate) {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (persist && storageKey) lsSet(storageKey, collapsed ? '1' : '0');
    if (collapsed) {
      body.classList.add('is-collapsing');
      if (animate) {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (collapsed) body.hidden = true;   // unless re-expanded mid-animation
        };
        body.addEventListener('transitionend', function h(e) {
          if (e.target !== body) return;
          body.removeEventListener('transitionend', h);
          finish();
        });
        setTimeout(finish, ANIM_FALLBACK_MS);
      } else {
        body.hidden = true;
      }
    } else {
      body.hidden = false;
      if (animate) {
        body.classList.add('is-collapsing');
        void body.offsetHeight;                // reflow: start from collapsed
      }
      body.classList.remove('is-collapsing');
    }
    if (onChange) onChange(collapsed);
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(true, true);
  });
  apply(false, false);

  return {
    isCollapsed: () => collapsed,
    collapse() { collapsed = true; apply(true, true); },
    expand() { collapsed = false; apply(true, true); },
  };
}

/* ── Collapsible search ──────────────────────────────────────────────────────
   Below SEARCH_COLLAPSE_MQ a navbar search field collapses into a disclosure
   button and expands as an overlay bar (styling in the theme CSS). Keep this
   string in sync with the 640px block there. It matches the compact edge of
   the ladder but is width-only: viewport.COMPACT_MQ also fires on short
   landscape windows, which are still wide enough for the field.

     const searchCtl = initSearchCollapse({
       wrap: document.getElementById('search-wrap'),
       toggle: document.getElementById('btn-search-toggle'),
       input: searchInput,
       onClose: hideSearchDropdown,      // app clears its own suggestions
     });

   The app keeps control of Esc precedence and of its `/` shortcut:
     if (searchCtl.isCollapsed()) searchCtl.open(); else input.focus(); */

export const SEARCH_COLLAPSE_MQ = '(max-width: 640px)';

/**
 * @param {{wrap: HTMLElement, toggle: HTMLElement, input?: HTMLInputElement,
 *          onClose?: () => void, mq?: string}} opts
 * @returns {{isCollapsed: () => boolean, isOpen: () => boolean,
 *            open: () => void, close: (o?: {restoreFocus?: boolean}) => void,
 *            destroy: () => void}}
 */
export function initSearchCollapse({
  wrap, toggle, input, onClose = null, mq = SEARCH_COLLAPSE_MQ,
}) {
  const mql = _mq(mq);

  function isOpen() { return wrap.classList.contains('is-open'); }

  function open() {
    wrap.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    if (input) { input.focus(); if (input.select) input.select(); }
  }

  // restoreFocus: false when something else is about to take focus (a dialog
  // opening), so we don't yank it back to the toggle first.
  function close(o) {
    if (!isOpen()) return;
    wrap.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (onClose) onClose();
    if (input) input.value = '';
    if (!o || o.restoreFocus !== false) toggle.focus();
  }

  function onToggle() { if (isOpen()) close(); else open(); }

  // Pointerdown outside the overlay dismisses it (map, another control).
  function onDocDown(e) {
    if (!isOpen()) return;
    if (wrap.contains(e.target) || toggle.contains(e.target)) return;
    close({ restoreFocus: false });
  }

  // Widening past the breakpoint puts the field back in the bar — drop the
  // overlay state so aria-expanded can't go stale on a now-hidden toggle.
  function onMq() { close({ restoreFocus: false }); }

  toggle.addEventListener('click', onToggle);
  document.addEventListener('pointerdown', onDocDown);
  if (mql) mql.addEventListener('change', onMq);

  return {
    isCollapsed: () => !!(mql && mql.matches),
    isOpen,
    open,
    close,
    destroy() {
      toggle.removeEventListener('click', onToggle);
      document.removeEventListener('pointerdown', onDocDown);
      if (mql) mql.removeEventListener('change', onMq);
    },
  };
}

/* ── URL state ───────────────────────────────────────────────────────────────
   Convention: read once at boot with precedence URL param > localStorage >
   default, validating every value; mirror state back with replaceUrlState()
   on every mutation and map moveend. */

export function urlParams() { return new URLSearchParams(location.search); }

export function getParamLower(key, params = urlParams()) {
  const v = params.get(key);
  return v == null ? null : v.toLowerCase();
}

/** Split a list param on commas/whitespace ('+' arrives as a space). */
export function splitTokens(raw) {
  return raw == null ? null
    : raw.split(/[,\s]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Mirror state into the query string without touching history. Emits a clean
 * pathname (no '?') when paramsObj is empty, so an all-defaults view has a
 * tidy URL.
 */
export function replaceUrlState(paramsObj) {
  const qs = new URLSearchParams(paramsObj).toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

/* ── Kit asset URLs ──────────────────────────────────────────────────────────
   Unversioned kit assets (assets/, vendor/, vendor-esm/) live at the kit ROOT,
   not inside a vX.Y.Z/ release directory, so a page can pin its JS to a
   release while still pointing at one copy of the banner or a vendor bundle.
   Resolving against import.meta.url means the same call works from the dev
   tree (…/style/core/core.js), from a release (…/style/v0.2.0/core/core.js),
   and from a localhost workspace server (http://localhost:8000/style/…). */

/** A release directory segment: 'v0.2.0' but not 'v1', 'vNext', 'video'. */
const VERSION_SEG = /^v\d+\.\d+\.\d+$/;

/**
 * Pure path arithmetic behind kitUrl() — exported (underscored) for tests.
 * Cuts a module URL back to the kit root: everything up to and including the
 * '/style/' segment, which drops any 'vX.Y.Z/' release segment with it. Falls
 * back to the module's own known depth (<root>/[vX.Y.Z/]core/core.js) when the
 * kit is served from a directory not named 'style'.
 * @param {string} url an absolute module URL (import.meta.url)
 * @returns {string} the kit root, with a trailing slash
 */
export function _kitRootFromModuleUrl(url) {
  const segs = String(url).replace(/[?#].*$/, '').split('/');
  segs.pop();                                    // drop 'core.js'

  const styleIdx = segs.lastIndexOf('style');
  if (styleIdx > 0) return segs.slice(0, styleIdx + 1).join('/') + '/';

  if (segs[segs.length - 1] === 'core') segs.pop();
  if (VERSION_SEG.test(segs[segs.length - 1])) segs.pop();
  return segs.join('/') + '/';
}

const KIT_ROOT = _kitRootFromModuleUrl(import.meta.url);

/**
 * Resolve a kit-root-relative path.
 *   kitUrl('assets/sustainable-fsa-banner.svg')
 *     → '../vendor/style/assets/sustainable-fsa-banner.svg'
 * @param {string} path
 * @returns {string} absolute URL
 */
export function kitUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), KIT_ROOT).href;
}
