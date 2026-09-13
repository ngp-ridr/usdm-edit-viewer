/* ============================================================================
   USDM Edit Viewer · js/app.js
   The application core: boot, state, the URL, and the wiring between the five
   packages this app is made of.

   This file owns NO rendering. The map is js/map.js, the drawer is
   js/panels.js, the card is js/cards.js, the comparison is the engine
   (js/session.js, js/compare.js, js/seams.js). What lives here is the state
   those modules read through one frozen `ctx` of getters, the order things come
   up in, and the single recompute pass every change funnels into.
   docs/contracts.md § 12 is the contract; where the two disagree, it wins.

   ── The shape ──────────────────────────────────────────────────────────────
   ES module, no build step. Chrome comes from
   ../vendor/usdm-editor/vendor/style/; three vendored globals
   (window.maplibregl, window.turf, window.topojson) must exist first —
   index.html loads them as classic scripts, so this module is always last.

   The URL is the primary state: read ONCE at boot, URL > default, every value
   re-validated on read. A view entirely at defaults emits NO query string. The
   camera is deliberately ephemeral — a shared link opens on the comparison, not
   on somebody's pan. See docs/contracts.md § 14.

     ?load    comma-separated proposal urls (origin checked BEFORE the fetch)
     ?demo    the bundled example set
     ?view    published | differences        ('proposal' is the default)
     ?pick    <shortId>                      whose classes to paint
     ?show    <shortId>,…                    emitted only when not all
     ?focus   <findingId>                    briefs link back through this
     ?theme   light                          high-contrast is the DEFAULT; the
                                             anti-flash boot reads this and
                                             nothing else
     ?drawer  closed                         desktop only, and only when closed

   ── ONE RECOMPUTE PASS ─────────────────────────────────────────────────────
   Everything that changes the SET of loaded proposals lands in `afterIntake()`:
   marks, then the panels, then the published week, then the comparison, then
   the seams, then every paint call, then ONE live sentence. Nothing else may
   compare anything. The editor learned this as "a commit is ONE pass" after
   shipping three rule sweeps and four `deriveBands` per committed vertex; the
   same shape matters more here, where one pass is seconds rather than
   milliseconds.

   Everything that does NOT move the model — the view, the pick, the shown set,
   the selection — repaints and never recompares. A tool whose findings depend
   on which checkbox is ticked is a tool nobody can quote.

   ── WHO HOLDS THE PUNCH ────────────────────────────────────────────────────
   js/bands.js does (docs/contracts.md § 9), and js/map.js is handed it as its
   `punch` dependency. Both modules ship a cache and only one may hold it, or
   the 418–572 ms is paid twice; this file is where that is decided, in one
   line, at `createMapView`. app.js therefore feeds `setPublished` the NATIONAL
   bands and never punches anything itself — where the hole goes is a function
   of the view and the pick, and js/map.js is the only place that knows both.

   ── Two traps this file is written against ─────────────────────────────────
   FUNCTION DECLARATIONS, NOT `const` ARROWS, for anything a constructor or an
   early boot step might reach. Two editor modules shipped broken exactly that
   way: a constructor ran first, hit the temporal dead zone, and took the app
   down while the read-only map looked fine.

   NO INLINE `style` ATTRIBUTES, anywhere. The page runs `style-src 'self'` with
   no `'unsafe-inline'`, so a style attribute is silently dropped and the
   element renders unstyled — a failure that looks like a CSS bug. `el()` in the
   vendored js/dom.js throws if handed one. CSSOM writes (`.style.foo`) are how
   every swatch in this app gets its colour.

   ── Measured costs ─────────────────────────────────────────────────────────
   Week 2026-09-08, the demo set's week, measured under Node 22 against the
   live archive (2026-09-12) unless the row says otherwise:

   | what                          | number                                    |
   |-------------------------------|-------------------------------------------|
   | boot → `booted`, nothing loaded| **3,152–3,335 ms** (map style, the layer  |
   |                                | ladder, the kit, `vendor/aoi/neighbors`)  |
   | boot → `booted`, `?demo`       | **17.7–22.6 s** for twelve proposals over |
   |                                | five states, everything included          |
   | boot → `booted`, `?load=` two  | **8.6 s** (one state, one pair)           |
   | the whole compare sweep        | **7.9–8.4 s** for 5 groups / 9 pairs /    |
   |                                | 188 findings · `__viewer.lastCompareMs`   |
   |                                | (one pair, one state: **1.4 s**)          |
   | national `deriveBands`         | **206–213 ms** · `__viewer.lastDeriveMs`  |
   |                                | (234 ms under Node; the editor 200–231)   |
   | the punch, one state (MT)      | **266–270 ms** cold, 0 cached on          |
   |                                | (week, AOI) · `__viewer.lastPunchMs`      |
   | twelve packages parsed         | 83 ms for the whole demo set, gunzip and  |
   |                                | JSON.parse included (Node, no browser)    |

   Measured 2026-09-13, Chromium headless over `python3 -m http.server`, on the
   live archive. **The compare sweep is the cost of this app**, and it is spent
   once per load rather than per interaction: every view, pick, show and
   selection below repaints and recompares nothing.

   The compare loop TICKS with `setTimeout(0)` between groups so the note over
   the map paints its progress line; without it the main thread is held for the
   whole eight seconds and the app looks hung on the busiest thing it does. Five
   groups is five yields, which is why the note reads "Comparing Montana, 1 of
   5" and not nothing at all.

   Sections: Elements · State · Small helpers · The URL · Map · Chrome ·
   Intake · The recompute pass · Selection and focus · Briefs · About · Boot ·
   Verification hook
   ========================================================================== */

import {
  createLiveRegion, getTheme, replaceUrlState, showToast, urlParams,
} from '../vendor/usdm-editor/vendor/style/core/core.js';
import { initDrawer } from '../vendor/usdm-editor/vendor/style/ui/drawer.js';
import { initDetailCard } from '../vendor/usdm-editor/vendor/style/ui/card.js';
import { initHelpModal } from '../vendor/usdm-editor/vendor/style/ui/help.js';

import { addHillshade, resolveBaseStyle } from '../vendor/usdm-editor/js/basemap.js';
import { createLayerStack } from '../vendor/usdm-editor/js/layers.js';
import { el, heading } from '../vendor/usdm-editor/js/dom.js';
import { fetchWeek } from '../vendor/usdm-editor/js/archive.js';

/* WP-B — intake and the published week. */
import { createLoader } from './load.js';
import { createBandProvider } from './bands.js';

/* WP-C — the map surface and the marks. */
import { createMapView } from './map.js';
import { assignMarks, anyRepeated } from './marks.js';

/* WP-D — the drawer's panels, the detail card, and the one export this file
   calls (js/cards.js calls `downloadBrief` / `copyBrief` for itself, through
   `ctx.brief`, so there is one writer of markdown and not three). */
import { createPanels } from './panels.js';
import { createCards } from './cards.js';
import { downloadSessionBrief } from './export.js';

/* WP-E — the engine (DOM-free; docs/contracts.md §§ 2–8). */
import { createSession, rankFindings, resolveFindingIds } from './session.js';
import { worstDeltaFor } from './proposal.js';
import { compareGroup } from './compare.js';
import { findSeams } from './seams.js';
import { createPublishedProvider } from './published.js';
import { buildRegionBrief, buildSeamBrief, buildSessionBrief } from './brief.js';

/* ── Elements ─────────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const els = {
  map: $('#map'), mapFrame: $('#map-frame'), note: $('#app-note'),
  emptyState: $('#empty-state'), emptyChoose: $('#empty-choose'), emptyDemo: $('#empty-demo'),
  dropHint: $('#drop-hint'),

  /* Navbar utilities. `#load-file-input` lives beside its button — a file is
     something you bring to the app, not a fact about the comparison. */
  btnDrawer: $('#btn-drawer'), btnLoad: $('#btn-load'), loadInput: $('#load-file-input'),
  btnDemo: $('#btn-demo'), btnBriefs: $('#btn-briefs'), btnInfo: $('#btn-info'),

  /* Drawer */
  drawer: $('#drawer'), drawerTab: $('#drawer-tab'), drawerScrim: $('#drawer-scrim'),
  drawerScroll: $('.ridr-drawer-scroll'),
  sessionLine: $('#session-line'),
  viewProposal: $('#view-proposal'), viewPublished: $('#view-published'),
  viewDifferences: $('#view-differences'),
  pickRow: $('#pick-row'), pickSelect: $('#pick-select'),
  proposalSection: $('#proposal-section'), proposalList: $('#proposal-list'),
  findingsSection: $('#findings-section'), findingsStatus: $('#findings-status'),
  findingsConflicts: $('#findings-conflicts'), findingsOnesided: $('#findings-onesided'),
  findingsSeams: $('#findings-seams'),
  legendSection: $('#legend-section'), legendBody: $('#legend-body'), legendKey: $('#legend-key'),

  /* Card and dialogs */
  card: $('#detail-card'), cardClose: $('#card-close'), cardContent: $('#card-content'),
  cardTitle: $('#card-title'),
  infoModal: $('#info-modal'), infoBody: $('#info-body'), infoClose: $('#info-close'),
};

/* ── State ────────────────────────────────────────────────────────────────
   One object, read through `ctx`'s getters by every other module — never
   handed out, never copied into a closure. The editor's justification lived in
   a modal's closure once and vanished on reload while the geometry restored;
   this is that lesson, applied before it can happen again. */

const VIEWS = ['proposal', 'published', 'differences'];

/** Where js/seams.js reads adjacency from. Page-relative — see CLAUDE.md. */
const NEIGHBORS_URL = 'vendor/aoi/neighbors.json';

const state = {
  /** The engine's Session. Built at boot; never replaced. */
  session: null,
  /** Map<proposalId, Mark> — letters and dashes, from js/marks.js. */
  marks: new Map(),
  /** The ranked findings: Region[] then Seam[]. */
  findings: [],
  comparisons: [],
  seams: [],
  /** Which of the three modes the map is in. */
  view: 'proposal',
  /** The proposal whose classes the Proposal view paints. */
  pick: null,
  /**
   * Whose outlines draw and whose findings are not dimmed — proposal ids.
   *
   * EMPTY MEANS EVERY LOADED PROPOSAL. That convention is shared with
   * js/map.js's `setShown` and js/panels.js's `isShown`, and it is what makes
   * `?show=` emit nothing for a session nobody has narrowed: the default has
   * one spelling rather than "the list of everything", which would otherwise
   * have to be rewritten on every load.
   */
  shown: new Set(),
  /** `{ kind, id }` or null. */
  selection: null,
  /** Adjacency for the seam engine, or null when it could not be read. */
  neighbors: null,
  /**
   * Did anything in this session come off this computer?
   *
   * The answer the session line's "a link to this page opens empty" sentence
   * reads, and it is taken from the LOAD REPORT, because js/load.js is the only
   * thing that watched the bytes arrive. `Proposal.source` agrees — it is the
   * file's own url or null, never `pkg.baseline.source`, which is the archive's
   * parquet and stays under `baseline` (docs/contracts.md § 2) — and
   * js/panels.js checks both. Two signals, one answer, and the one that cannot
   * be wrong is this one.
   *
   * STICKY: a session that mixes a `?load=` url with a dropped file still
   * cannot travel in a link, so one local file is enough, forever.
   */
  anyLocal: false,
};

let map = null;
let layers = null;
let mapView = null;
let panels = null;
let cards = null;
let loader = null;
let bandProvider = null;
let publishedProvider = null;
let liveRegion = null;
let drawerCtl = null;
let cardCtl = null;
let fitBtn = null;
let booted = false;
let lastCompareMs = 0;
/**
 * How many recompute passes have FINISHED.
 *
 * For tools/verify.mjs, and it earns its two lines: `booted` is set once, and
 * everything after a load — the drawer's session line, the legend, the map's
 * findings — is written at the END of `afterIntake`, after the findings array
 * has already filled. A harness waiting on `findings.length` therefore races
 * the paint it is about to assert on, which is exactly the flake this counter
 * removes: wait for `passes` to go up and the pass is over.
 */
let passes = 0;

/** The parameters as they were at boot. Read once; never re-read. */
const params = urlParams();

/* ── Small helpers ────────────────────────────────────────────────────────── */

/** The polite live region. One sentence per event — never two for one thing. */
function live(message) {
  liveRegion?.announce(message);
}

/**
 * ONE toast. The kit's `showToast()` is a SINGLETON appending its own
 * `.ridr-toast`: two calls in one turn means the first was never read, so an
 * operation that also warns sends ONE sentence carrying both.
 */
function say(message) {
  showToast(message);
}

/**
 * The note over the map — boot progress, compare progress, and the intake's
 * full problem list.
 *
 * Politeness FIRST, then the text. A live region is read at the politeness it
 * carries when the mutation lands, so setting this afterwards announces a hard
 * failure at whatever politeness the previous message had.
 */
function note(message, { error = false } = {}) {
  if (!els.note) return;
  if (!message) { els.note.hidden = true; els.note.textContent = ''; return; }
  els.note.hidden = false;
  els.note.setAttribute('aria-live', error ? 'assertive' : 'polite');
  els.note.classList.toggle('is-error', error);
  els.note.textContent = message;
}

/** Is this a compact viewport? Matches the kit's own docking breakpoint. */
function isCompact() {
  return window.matchMedia('(max-width: 640px), (max-height: 560px)').matches;
}

/**
 * Padding that keeps a fit from putting its subject under the docked card.
 *
 * Read from the card's RECT rather than the media query: the kit's dock
 * breakpoint is narrower than `isCompact`, and a bottom sheet is recognisable
 * by shape (wider than the frame's 90%) in a way a query cannot express.
 */
function fitPadding(base) {
  const pad = { top: base, right: base, bottom: base, left: base };
  const frame = map?.getContainer()?.getBoundingClientRect();
  if (!frame) return pad;
  const card = els.card;
  if (!card || card.hidden || card.getClientRects().length === 0) return pad;
  const r = card.getBoundingClientRect();
  if (r.width >= frame.width * 0.9) pad.bottom += r.height;
  else pad.right += r.width;
  return pad;
}

/** Yield to the browser: one paint between two expensive synchronous steps. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `performance.now()` where there is one. */
function now() {
  return performance?.now ? performance.now() : Date.now();
}

/** The proposals, in load order — the order that assigned the letters. */
function proposals() {
  return state.session?.list() ?? [];
}

/** A proposal by its full id or by its `shortId`. Either is unambiguous. */
function proposalById(id) {
  if (!id) return null;
  return state.session?.byId(id)
    ?? proposals().find((p) => p.shortId === id)
    ?? null;
}

/** One finding — a region or a seam — by its deterministic id (§ 8). */
function findingById(id) {
  if (!id) return null;
  return state.findings.find((f) => f.id === id) ?? null;
}

/** A proposal's letter and dash. */
function markFor(proposalId) {
  return state.marks.get(proposalId) ?? null;
}

/** The letter alone, for a sentence. */
function letterOf(proposal) {
  return markFor(proposal?.id)?.letter ?? proposal?.shortId ?? '?';
}

/** An author's surname, which is how the sentences in § 15 name a side. */
function surnameOf(proposal) {
  const name = proposal?.author?.name;
  if (!name) return letterOf(proposal);
  return String(name).trim().split(/\s+/).pop();
}

/* ── The URL ──────────────────────────────────────────────────────────────
   Written back with the kit's `replaceUrlState`, which drops every key whose
   value is null — so a view at defaults emits no query string at all.

   `?show=` is emitted only when the shown set is a real subset: a list of every
   proposal is the default said the long way, and it would put twelve ids in the
   address bar of a session nobody has narrowed.

   `?load=` and `?demo` are CARRIED THROUGH unchanged. They are how the session
   was obtained, and dropping them would turn the address bar — which is this
   app's only Share — into a link that opens empty. The camera is not written.
   See the header. */
function pushState() {
  /* A SPARSE object: `replaceUrlState` hands whatever it is given straight to
     `URLSearchParams`, which stringifies a null into the four letters "null".
     Every key here is therefore added only when it applies — the editor's
     `pushState` is written the same way, for the same reason. */
  const out = {};

  /* How the session was obtained, carried through unchanged: the address bar
     is this app's only Share, and dropping these would hand somebody a link
     that opens empty. */
  if (params.get('load')) out.load = params.get('load');
  if (params.has('demo')) out.demo = '';

  if (state.view !== 'proposal') out.view = state.view;

  /* The pick is emitted only when it is NOT the one the app would choose for
     itself — the first proposal in load order. Same rule as every other
     parameter: a view at defaults says nothing. */
  const defaultPick = proposals()[0] ?? null;
  if (state.pick && state.pick.id !== defaultPick?.id) out.pick = state.pick.shortId;

  /* An empty `shown` IS "everything", so a non-empty one is always a real
     subset and always worth emitting. */
  if (state.shown.size) {
    const ids = [...state.shown].map((id) => proposalById(id)?.shortId).filter(Boolean);
    if (ids.length) out.show = ids.join(',');
  }

  if (state.selection?.id) out.focus = state.selection.id;

  const theme = getTheme();
  if (theme !== 'high-contrast') out.theme = theme;
  if (drawerCtl && !drawerCtl.isOpen?.() && !isCompact()) out.drawer = 'closed';

  replaceUrlState(out);
}

/* ══ Map ════════════════════════════════════════════════════════════════════ */

/** The pose the app opens at, and what "zoom to fit" means with nothing loaded. */
const NATIONAL_POSE = { center: [-98.5, 39.5], zoom: 3.4 };

/**
 * True when `resolveBaseStyle()` could not reach CARTO and handed back the
 * blank ground instead. Module scope, not a local in `buildMap`, because the
 * verification hook reads it — a degraded boot and a slow one look identical
 * from outside.
 */
let basemapDegraded = false;

/**
 * Build the map, on whichever ground js/basemap.js could get.
 *
 * ASYNC, because the style is fetched before the Map is constructed rather than
 * by it. That inversion is the whole safety property: hand MapLibre a style URL
 * that 404s, stalls, or answers with a captive portal's HTML, and the map may
 * never fire `load` — so boot's deadline rejects and the app is simply gone,
 * over a backdrop. `resolveBaseStyle()` never rejects; the worst case is
 * `degraded: true` and a blank ground that is known to load.
 */
async function buildMap() {
  const { style, degraded } = await resolveBaseStyle();
  basemapDegraded = degraded;
  const m = new maplibregl.Map({
    container: els.map,
    style,
    center: NATIONAL_POSE.center, zoom: NATIONAL_POSE.zoom,
    maxZoom: 12, minZoom: 2,
    /* Pitch is impossible by construction, not by handler — see NORTH-UP. */
    maxPitch: 0,
    attributionControl: { compact: true, customAttribution:
      'USDM: NDMC/USDA/NOAA · archive: Sustainable FSA' },
  });
  /* NORTH-UP, always: a rotated or pitched view makes "the seam runs along the
     north side" a question about the screen rather than the ground.

     PITCH is an invariant (`maxPitch: 0`, enforced by the transform). BEARING
     has no `maxBearing`, so it is exactly three handler disables: `dragRotate`,
     `touchZoomRotate` (rotation only — the handler STAYS enabled for
     pinch-zoom) and `keyboard`, which is the one everyone forgets.
     `showCompass: false` stays — a compass that cannot be turned is a control
     that does nothing. */
  m.dragRotate.disable();
  m.touchZoomRotate.disableRotation();
  m.keyboard.disableRotation();
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  /* Under the zoom pair, above the globe switch: zoom-to-fit is a navigation
     control and the projection switch is not. */
  m.addControl(new FitControl(), 'top-left');
  m.addControl(new maplibregl.GlobeControl(), 'top-left');
  m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'imperial' }), 'bottom-left');
  return m;
}

/**
 * Frame whatever is loaded — every loaded working area, or the lower 48.
 *
 * Returns the name of what it framed, so the caller can say it: a camera move a
 * screen reader cannot see has to be announced.
 */
function fitToLoaded() {
  const boxes = proposals().map((p) => p.aoi?.bbox).filter(Boolean);
  if (!boxes.length || !mapView) {
    map?.easeTo({ center: NATIONAL_POSE.center, zoom: NATIONAL_POSE.zoom });
    return 'the lower 48';
  }
  const bbox = boxes.reduce((acc, b) => [
    Math.min(acc[0], b[0]), Math.min(acc[1], b[1]),
    Math.max(acc[2], b[2]), Math.max(acc[3], b[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  mapView.focus(bbox);
  const areas = new Set(proposals().map((p) => p.aoi?.id));
  return areas.size === 1
    ? proposals()[0]?.aoi?.name ?? 'the loaded working area'
    : `the ${areas.size} loaded working areas`;
}

/** Keep the fit button's name honest about WHICH thing it frames. */
function paintFitControl() {
  if (!fitBtn) return;
  const n = state.session?.size ?? 0;
  const name = n
    ? 'Zoom to the loaded working areas'
    : 'Zoom to the lower 48';
  fitBtn.setAttribute('aria-label', name);
  fitBtn.title = name;
}

/** MapLibre's `IControl`: `onAdd` returns the element, `onRemove` tears it down. */
class FitControl {
  onAdd() {
    /* The kit owns no map-control component and MapLibre's own styling is keyed
       to these two classes, so the wrapper wears them and the button inside
       inherits the 29×29 box every other control on this map has. css/app.css
       adds only the centring of an inline SVG child, under `#btn-fit` — this
       app's own id, so it is placement rather than a kit-override. */
    const wrap = el('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' });
    const btn = el('button', { type: 'button' });
    btn.id = 'btn-fit';
    /* Four corner brackets — the conventional "frame this" mark, and one that
       does not collide with the `+`/`−` above it or the globe below. Built
       through createElementNS because SVG is not in the HTML namespace. */
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    for (const d of ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    btn.append(svg);
    btn.addEventListener('click', () => {
      const framed = fitToLoaded();
      /* `live()` and not a toast: this is confirmation, not news, and the toast
         is a singleton another operation would overwrite. */
      if (framed) live(`Framed ${framed}.`);
    });
    wrap.append(btn);
    this._wrap = wrap;
    fitBtn = btn;
    paintFitControl();
    return wrap;
  }

  onRemove() {
    this._wrap?.remove();
    this._wrap = null;
    fitBtn = null;
  }
}

/* ══ Chrome ═════════════════════════════════════════════════════════════════ */

/** Paint the three view segments' pressed state. `aria-pressed`, nothing else. */
function paintViewControls() {
  const byView = {
    proposal: els.viewProposal,
    published: els.viewPublished,
    differences: els.viewDifferences,
  };
  for (const [v, node] of Object.entries(byView)) {
    node?.setAttribute('aria-pressed', String(v === state.view));
  }
  /* The picker only means something in the proposal view — the other two paint
     either the published week or the change ramp, and neither has an author.
     Hidden as a ROW, so the label never outlives its select. */
  if (els.pickRow) els.pickRow.hidden = state.view !== 'proposal' || !state.session?.size;
}

/**
 * Change the view.
 *
 * ONE sentence out, always: the map is a canvas a screen reader cannot see, so
 * a mode change that is not announced is a mode change that did not happen for
 * a third of this app's readers.
 */
function setView(next) {
  if (!VIEWS.includes(next) || next === state.view) return;
  state.view = next;
  paintViewControls();
  /* js/map.js re-punches or un-punches for itself: whether the published fills
     go on whole or with a hole in them is a function of the view and the pick,
     and it is the only place that knows both. */
  mapView?.setView(next);
  panels?.renderLegend(next);
  pushState();
  live(`Map view: ${{
    proposal: 'one proposal’s classes, inside its working area',
    published: 'the published week',
    differences: 'the differences between the loaded proposals',
  }[next]}.`);
}

/**
 * Whose classes the Proposal view paints.
 *
 * Changing the pick moves THE HOLE in the published week, so it costs a punch —
 * cached on (week, AOI) inside js/bands.js, so flipping between two proposals
 * costs one each and then nothing.
 */
function setPick(id) {
  const p = proposalById(id);
  if (!p || p.id === state.pick?.id) return;
  state.pick = p;
  mapView?.setPick(p);
  paintPickControl();
  pushState();
  live(`Painting ${letterOf(p)} · ${p.author?.name ?? 'an unnamed author'} — ` +
    `${p.aoi?.name ?? 'their working area'}.`);
}

/** Keep `#pick-select` in step with the model, whoever moved it. */
function paintPickControl() {
  const sel = els.pickSelect;
  if (!sel) return;
  const all = proposals();
  sel.disabled = all.length === 0;
  if (!all.length) {
    sel.replaceChildren(el('option', {}, 'Nothing loaded'));
    return;
  }
  const wanted = all.map((p) => [
    p.shortId,
    `${markFor(p.id)?.letter ?? '?'} · ${p.author?.name ?? 'Unnamed author'} — ${p.aoi?.name ?? 'an unnamed area'}`,
  ]);
  /* A PRINTABLE SEPARATOR. This comparison only has to tell two rendered
     option lists apart, and it used to join value to text with a NUL — which
     made the whole module a binary file to every tool that samples the first
     few kilobytes: `file` said `data`, and a plain `grep -r` skipped it
     silently. A pipe cannot shift the boundary either way: every value is a
     hex shortId. */
  const SEP = ' | ';
  const current = [...sel.options].map((o) => `${o.value}${SEP}${o.textContent}`);
  const same = current.length === wanted.length
    && wanted.every(([v, t], i) => `${v}${SEP}${t}` === current[i]);
  if (!same) sel.replaceChildren(...wanted.map(([v, t]) => el('option', { value: v }, t)));
  if (state.pick) sel.value = state.pick.shortId;
}

/**
 * Which proposals' outlines draw, and whose findings are not dimmed.
 *
 * IT NEVER CHANGES THE ANSWER. The comparison is over everything loaded; this
 * is a way of looking at a crowded map, and a finding whose proposal is hidden
 * is dimmed in the list rather than removed from it.
 */
function setShown(ids) {
  const all = proposals();
  const valid = new Set(all.map((p) => p.id));
  let next = new Set([...(ids ?? [])]
    .map((id) => proposalById(id)?.id)
    .filter((id) => id && valid.has(id)));
  /* Everything, said the long way, is normalised back to the empty set — the
     one spelling of the default the map, the panels and the URL all share. */
  if (next.size === all.length) next = new Set();
  state.shown = next;
  mapView?.setShown([...next]);
  panels?.repaintDimming?.();
  pushState();
  const n = next.size || all.length;
  live(n === all.length
    ? 'Showing every loaded proposal.'
    : `Showing ${n} of ${all.length} proposals; the others’ outlines are hidden ` +
      'and their findings dimmed. Nothing about the comparison changed.');
}

/** Show or hide the empty state. It is the map's own surface, not a dialog. */
function paintEmptyState() {
  const empty = (state.session?.size ?? 0) === 0;
  if (els.emptyState) els.emptyState.hidden = !empty;
  for (const id of ['proposalSection', 'findingsSection', 'legendSection']) {
    if (els[id]) els[id].hidden = empty;
  }
  if (els.btnBriefs) els.btnBriefs.disabled = state.findings.length === 0;
  paintViewControls();
}

/* ══ Intake ═════════════════════════════════════════════════════════════════
   Four ways in, all of them js/load.js's. This file supplies the hooks and the
   element the drop target attaches to; it never reads a file itself. */

/** Files arrived — from the picker, from the empty state, or from a drop. */
function onFilesChosen(files) {
  if (!files?.length) return;
  loader?.fromFiles(files);
}

/** The bundled example set. */
function onDemoChosen() {
  loader?.fromDemo();
}

/* ══ The recompute pass ═════════════════════════════════════════════════════
   The ONE place anything is compared. See the header. */

/**
 * Everything that follows from "the set of loaded proposals changed".
 *
 * Order matters and is not arbitrary:
 *   marks first         — every later sentence and swatch names a letter
 *   panels next         — the drawer fills in before the slow part starts, so a
 *                         reader sees what loaded while the comparison runs
 *   the published week  — one fetch, one national `deriveBands`
 *   compare, then seams — the expensive half, ticking between groups
 *   paint, then ONE sentence
 *
 * Failures are NOT fatal. A comparison that throws leaves the proposals loaded
 * and painted with a sentence over the map: a reader who can still see two
 * proposals is better served than one looking at a blank app.
 */
async function afterIntake(report) {
  const all = proposals();
  if (report?.local) state.anyLocal = true;

  state.marks = assignMarks(all);
  if (anyRepeated(state.marks)) {
    /* The one toast CLAUDE.md's mark table promises. It runs before js/load.js
       says its own piece, so a load that also had problems overwrites this —
       deliberately: a file that would not open is the more urgent of the two,
       and the repeated dash is still readable in the legend beside its letter. */
    say('A working area holds more proposals than there are dash patterns, so a ' +
      'pattern repeats — the letters still tell them apart.');
  }

  /* Anything newly loaded is SHOWN, and a proposal already hidden stays hidden.
     Only a narrowed set has to be extended — an empty one already means all,
     and filling it in would turn the default into a list that has to be
     maintained. */
  if (state.shown.size) for (const p of all) state.shown.add(p.id);
  if (!state.pick || !state.session?.byId(state.pick.id)) state.pick = all[0] ?? null;

  paintEmptyState();
  paintFitControl();
  paintPickControl();
  panels?.renderProposals(all);
  panels?.renderLegend(state.view);

  if (!all.length) {
    panels?.renderSession(summaryOf());
    pushState();
    return;
  }

  /* The map, with everything that needs no comparison. */
  mapView?.setAois(all.map((p) => p.aoi).filter(Boolean));
  mapView?.setPatches(allPatches());
  mapView?.setPick(state.pick);
  mapView?.setShown([...state.shown]);
  mapView?.setView(state.view);
  fitToLoaded();

  await paintPublished();
  await recompare();

  mapView?.setFindings(state.findings.filter((f) => f.kind !== 'seam'));
  mapView?.setSeams(state.seams);
  repaintFindingsList();
  panels?.renderSession(summaryOf());
  paintEmptyState();
  note(null);
  pushState();

  live(sessionSentence());
  /* LAST, and after every paint above: a harness waiting on this has a settled
     app, not one whose model is ahead of its drawer. */
  passes += 1;
}

/**
 * The published week under the proposals — national, once.
 *
 * js/map.js decides whether it goes on whole or with a hole in it. A failure
 * here is not fatal: the proposals still paint and the note says the ground
 * under them could not be read, which is a truthful map with one layer missing
 * and beats no map.
 */
async function paintPublished() {
  const week = state.session?.week();
  if (!week || !bandProvider || !mapView) return;
  try {
    note(`Reading the published week of ${week}…`);
    mapView.setPublished(await bandProvider.weekBands(week));
  } catch (err) {
    console.warn('[viewer] the published week could not be painted', err);
    note(`The published week of ${week} could not be read, so the proposals are ` +
      'drawn over bare ground. Everything they say about themselves still holds.',
    { error: true });
  }
}

/**
 * Compare every group, then find every seam.
 *
 * TICKS BETWEEN GROUPS. `compareGroup` is synchronous and a state pair measured
 * ~0.7 s in the planning prototype; five groups would hold the main thread for
 * several seconds, and a note that cannot paint is a note nobody reads. One
 * `setTimeout(0)` per group buys the paint for the price of one task.
 *
 * A group that throws is reported and SKIPPED — one bad pair must not cost the
 * other four states their comparison.
 */
async function recompare() {
  const t0 = now();
  const groups = state.session?.groups() ?? [];
  const comparisons = [];
  let i = 0;

  for (const group of groups) {
    i += 1;
    const name = groupName(group);
    note(`Comparing ${group.proposals?.length ?? 0} proposals over ${name} — ${i} of ${groups.length}…`);
    live(`Comparing ${name}, ${i} of ${groups.length}.`);
    await tick();
    try {
      /* `crossAoi` is the GROUP's own flag: a group of two overlapping working
         areas must not re-compare the pairs that already have a group of their
         own, or the same disagreement is minted twice under two ids. */
      comparisons.push(...compareGroup(group.proposals, {
        ground: group.ground, crossAoi: group.crossAoi === true,
      }));
    } catch (err) {
      console.error('[viewer] comparison failed over', name, err);
      note(`The comparison over ${name} failed — ${err?.message ?? 'unknown error'}. ` +
        'The other working areas are unaffected.', { error: true });
    }
  }

  note('Looking for seams along the shared borders…');
  await tick();
  let seams = [];
  try {
    seams = await findSeams(state.session, {
      provider: publishedProvider, neighbors: state.neighbors,
    });
  } catch (err) {
    console.error('[viewer] the seam search failed', err);
    note(`The seam search failed — ${err?.message ?? 'unknown error'}. The regions ` +
      'above are unaffected.', { error: true });
  }

  state.comparisons = comparisons;
  state.seams = seams ?? [];
  state.findings = rankAllFindings(comparisons.flatMap((c) => c.regions ?? []), state.seams);
  lastCompareMs = Math.round(now() - t0);
  console.info(`[viewer] compared ${groups.length} groups in ${lastCompareMs} ms — ` +
    `${state.findings.length} findings`);
}

/** What to call a group in a progress line: the working area, or both of them. */
function groupName(group) {
  const named = (group?.aoiIds ?? [])
    .map((id) => group.proposals?.find((p) => p.aoi?.id === id)?.aoi?.name ?? id);
  return named.join(' and ') || 'a working area';
}

/**
 * The findings, ranked, in ONE list — regions first, then seams.
 *
 * The ranking is the ENGINE's — `rankFindings` in js/session.js, which is
 * `rankRegions` ++ `rankSeams` (docs/contracts.md § 5, "Seams against regions").
 * It is a CONCATENATION on purpose and not a merged sort: a seam has no area
 * and its size is a length, so a merged rank by area puts every seam last and a
 * merged rank by class step puts a two-class seam above every one-class
 * conflict. Either way the thing a reconciliation meeting exists to settle gets
 * buried. It is also the order of the drawer's three groups, so the list and
 * its text twin cannot disagree.
 *
 * This app held a second comparator here until the integration pass; it agreed
 * with the engine's on the demo set, which is exactly how a second copy of a
 * rule survives long enough to drift.
 */
function rankAllFindings(regions, seams) {
  /* § 8's collision rule runs over the WHOLE ranked list — regions and seams
     together, in the order the panel and the briefs will use — because the
     suffix is assigned by rank, and this is the one place that list exists.
     `resolveFindingIds` is idempotent, so a recompute never suffixes twice. */
  return resolveFindingIds(rankFindings(regions, seams ?? []));
}

/** Every patch of every proposal, stamped with its mark. docs/contracts.md § 10. */
function allPatches() {
  const out = [];
  for (const p of proposals()) {
    const mark = markFor(p.id);
    for (const patch of p.patches ?? []) {
      out.push({
        proposalId: p.id,
        key: patch.key,
        seq: patch.seq,
        mark: mark?.dash ?? 0,
        letter: mark?.letter ?? '?',
        geometry: patch.geometry,
        anchor: patch.anchor,
      });
    }
  }
  return out;
}

/** The patch with this key, and the proposal that owns it. */
function patchByKey(key) {
  for (const p of proposals()) {
    const patch = (p.patches ?? []).find((x) => x.key === key || x.id === key);
    if (patch) return { proposal: p, patch };
  }
  return null;
}

/**
 * What the drawer's top line and the `role="status"` sentence are built from.
 *
 * `proposals` and `findings` are the ARRAYS, not counts: js/panels.js's
 * `renderSession` counts them itself and falls back to `ctx` when a caller
 * hands it nothing, so handing it numbers would read as "nothing is loaded".
 * The scalar counts ride alongside for anything that wants them without a
 * second pass.
 */
function summaryOf() {
  const all = proposals();
  const conflicts = state.findings.filter((f) => f.kind === 'conflict').length;
  const oneSided = state.findings.filter((f) => f.kind === 'one-sided').length;
  const seams = state.findings.filter((f) => f.kind === 'seam').length;
  const areas = new Set(all.map((p) => p.aoi?.id)).size;
  const local = state.anyLocal;
  return {
    week: state.session?.week() ?? null,
    proposals: all,
    findings: state.findings,
    count: all.length,
    areas,
    conflicts, oneSided, seams,
    /* True when anything was loaded from this computer: the address bar cannot
       carry a local file, so a shared link would open empty, and pretending
       otherwise is the failure worth a sentence. */
    local,
    localNote: local
      ? 'Loaded from this computer — a link to this page opens empty. Use Briefs to share what you found.'
      : null,
    sentence: sessionSentence(),
  };
}

/**
 * The one sentence a screen reader hears when a comparison lands.
 * docs/contracts.md § 15: "12 proposals loaded for the week of 2026-09-08.
 * 3 conflicts, 41 one-sided differences and 4 seams found — conflicts are
 * listed first."
 */
function sessionSentence() {
  const all = proposals();
  if (!all.length) {
    return 'Nothing is loaded. Load two or more proposals for the same week to compare them.';
  }
  const week = state.session?.week();
  const conflicts = state.findings.filter((f) => f.kind === 'conflict').length;
  const oneSided = state.findings.filter((f) => f.kind === 'one-sided').length;
  const seams = state.findings.filter((f) => f.kind === 'seam').length;
  const head = `${all.length} ${all.length === 1 ? 'proposal' : 'proposals'} loaded ` +
    `for the week of ${week}.`;
  if (!state.findings.length) {
    return `${head} No conflicts, one-sided differences or seams found — ` +
      (all.length === 1
        ? 'load a second proposal to compare it against.'
        : 'they do not answer any of the same ground differently.');
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `${head} ${plural(conflicts, 'conflict', 'conflicts')}, ` +
    `${plural(oneSided, 'one-sided difference', 'one-sided differences')} and ` +
    `${plural(seams, 'seam', 'seams')} found — conflicts are listed first.`;
}

/**
 * Rebuild the findings list — the map's TEXT TWIN, in the same rank order.
 *
 * Dimming is NOT a rebuild: `repaintDimming()` toggles a class per row, so
 * hiding a proposal never moves focus out of the row a keyboard reader is on
 * and never changes the order. That is why `setShown` calls that and this
 * calls `renderFindings`.
 */
function repaintFindingsList() {
  if (!panels) return;
  panels.renderFindings(state.findings);
  panels.setStatus?.(sessionSentence());
}

/* ══ Selection and focus ════════════════════════════════════════════════════ */

/**
 * Point at a finding, a patch or a proposal — or at nothing.
 *
 * This is the ONE place selection changes. It moves the map's three `*-active`
 * filters, the list's `aria-current`, the URL's `?focus=` and, on a null, the
 * card — the kit's `close()` returns early when the card is already hidden, so
 * the card's own `onClose` calling back in here is one hop and not a loop.
 *
 * The `kind` is the one js/map.js's `highlight` filters on: `conflict`,
 * `one-sided`, `seam` or `change`. A generic 'finding' would match no layer and
 * leave the ring on the last thing selected.
 */
function select(sel) {
  state.selection = sel?.id ? { kind: sel.kind ?? 'conflict', id: sel.id } : null;
  mapView?.highlight(state.selection);
  panels?.setSelection?.(state.selection);
  if (!state.selection) cardCtl?.close?.();
  pushState();
}

/**
 * Open whatever was pointed at: select it, frame it, and card it.
 *
 * Every route in — a findings row, a click on the map, `?focus=` — comes
 * through here, so the three surfaces can never disagree about what is open.
 * This is `ctx.select`.
 */
function openSelection(sel, { fit = true } = {}) {
  if (!sel?.id) { select(null); return; }

  const finding = findingById(sel.id);
  if (finding) {
    select({ kind: finding.kind, id: finding.id });
    if (fit) mapView?.focus(finding);
    if (finding.kind === 'seam') cards?.showSeam(finding);
    else cards?.showFinding(finding);
    live(selectionSentence(finding));
    return;
  }

  if (sel.kind === 'change' || sel.kind === 'patch') {
    const owned = patchByKey(sel.id);
    if (!owned) return;
    select({ kind: 'change', id: sel.id });
    if (fit) mapView?.focus(owned.patch);
    cards?.showChange(owned.proposal, owned.patch.key ?? sel.id);
    live(`${owned.patch.name ?? 'A change'} by ${surnameOf(owned.proposal)} selected.`);
    return;
  }

  if (sel.kind === 'proposal') {
    const p = proposalById(sel.id);
    if (!p) return;
    select({ kind: 'proposal', id: p.id });
    if (fit) mapView?.focus(p.aoi);
    cards?.showProposal(p);
  }
}

/**
 * What a screen reader hears when something is selected.
 *
 * "Conflict near Big Sandy selected: D2 from Reyes against D1 from Teigen over
 * 184 square miles." — docs/contracts.md § 15. The wording degrades where a
 * finding carries no place name; the classes, the authors and the size are the
 * part a reader cannot get from the canvas, so they are never dropped.
 */
function selectionSentence(f) {
  if (f.kind === 'seam') {
    const where = (f.aoiIds ?? [])
      .map((id) => proposals().find((p) => p.aoi?.id === id)?.aoi?.name ?? id)
      .join(' and ');
    const both = f.reciprocal ? ', proposed from both sides' : ', proposed from one side';
    return `Seam along ${where || 'a shared border'} selected${both}` +
      (f.lengthKm ? `, ${areaWords(null, f.lengthKm)}.` : '.');
  }
  const A = proposalById(f.proposalA);
  const B = proposalById(f.proposalB);
  const kind = f.kind === 'conflict' ? 'Conflict' : 'One-sided difference';
  const where = f.aoiId
    ? ` in ${proposals().find((p) => p.aoi?.id === f.aoiId)?.aoi?.name ?? f.aoiId}`
    : '';
  return `${kind}${where} selected: ${f.classA} from ${surnameOf(A)} against ` +
    `${f.classB} from ${surnameOf(B)}${f.areaKm2 ? ` over ${areaWords(f.areaKm2)}` : ''}.`;
}

/**
 * Miles, spoken.
 *
 * The live region is READ ALOUD, so it takes words rather than the `mi²` glyph
 * the panels use — a screen reader says "mi squared" or nothing at all. The
 * numbers are the same ones `fmtMi2` prints; the conversion factors are
 * js/units.js's and are not re-derived here.
 */
function areaWords(km2, km = null) {
  if (km != null) {
    const mi = km * 0.621371192237334;
    return `${Math.round(mi).toLocaleString()} miles of border`;
  }
  const mi2 = km2 / 2.589988110336;
  return `${Math.round(mi2).toLocaleString()} square miles`;
}

/* ══ Briefs ═════════════════════════════════════════════════════════════════ */

/**
 * One finding's markdown. This is `ctx.brief`.
 *
 * A region's brief needs the comparison it came out of (for the pair's totals
 * and the published side); a seam carries everything it needs. js/cards.js's
 * Download and Copy buttons go through here rather than building markdown of
 * their own — one writer, so the file and the clipboard cannot disagree.
 *
 * BY THE PAIR, NEVER BY THE ID. A finding's id is a hash of its key and the
 * session may widen one (js/session.js `resolveFindingIds`); matching a
 * comparison's regions against it therefore MISSES, silently, and a miss hands
 * `buildRegionBrief` two nulls — which is a brief that says "an unnamed author"
 * seven times and "This side could not be read" twice, beside a card showing
 * both authors correctly. The pair is two proposal ids the region carries
 * verbatim, each pair is compared exactly once, and js/brief.js's own
 * `comparisonFor` is the same two comparisons in the same order.
 */
function brief(finding) {
  if (!finding) return '';
  const opts = { viewerUrl: `${location.origin}${location.pathname}` };
  if (finding.kind === 'seam') return buildSeamBrief(finding, opts);
  const comparison = state.comparisons.find((c) =>
    c.pair?.[0] === finding.proposalA && c.pair?.[1] === finding.proposalB)
    ?? state.comparisons.find((c) => (c.regions ?? []).includes(finding));
  return buildRegionBrief(finding, comparison, opts);
}

/**
 * Every finding in one markdown document. This is `ctx.sessionBrief`.
 *
 * Built HERE and not in js/export.js, for the same reason `brief()` is: the
 * engine's `buildSessionBrief` needs the session, the comparisons and the
 * seams, and this file is the only thing holding all three.
 *
 * It is handed the SAME `viewerUrl` one finding's brief gets — without it not
 * one of the hundreds of briefs in the file links back, and the README promises
 * every one of them does — and the session's own resolved, ranked findings, so
 * the index is that one list rather than a second walk of the comparisons.
 */
function sessionBrief() {
  return buildSessionBrief(state.session, state.comparisons, state.seams, {
    viewerUrl: `${location.origin}${location.pathname}`,
    findings: state.findings,
  });
}

/** Every finding as one markdown file — the thing reviewers talk from. */
function onBriefs() {
  if (!state.findings.length) return;
  let markdown;
  try {
    markdown = sessionBrief();
  } catch (err) {
    console.error('[viewer] the session brief could not be built', err);
    say(`The briefs could not be written — ${err?.message ?? 'unknown error'}.`);
    return;
  }
  /* js/export.js names the file and says its own sentence through `say`. */
  downloadSessionBrief({ markdown, ctx, week: state.session?.week() ?? null, say });
}

/* ══ About ══════════════════════════════════════════════════════════════════
   ONE explain-this dialog, opened by `?` and re-openable from nothing else.
   `initHelpModal` is called with NO `url`: passing one fetches that file and
   renders it over everything this function wrote. */

function buildAboutModal() {
  const body = els.infoBody;
  if (!body) return;
  body.replaceChildren(
    el('p', {},
      'This tool reads ', el('strong', {}, 'usdm-edit-proposal'),
      ' packages produced by the ',
      el('a', { href: 'https://ngp-ridr.github.io/usdm-editor/', rel: 'noopener' }, 'USDM Editor'),
      ' and shows where two of them answer the same ground differently. ',
      el('strong', {}, 'It never changes a proposal.')),

    heading('What it looks for'),
    el('ul', {},
      el('li', {}, el('strong', {}, 'Conflicts'),
        ' — two proposals change the same ground to different resulting classes. ',
        'These are listed first, because they are what a reconciliation has to settle.'),
      el('li', {}, el('strong', {}, 'One-sided differences'),
        ' — one proposal changes ground the other leaves as published.'),
      el('li', {}, el('strong', {}, 'Seams'),
        ' — a step along a shared working-area border that the published map did not have. ',
        'A two-class step at a jurisdiction line is almost never physical.')),

    heading('How to load proposals'),
    el('ul', {},
      el('li', {}, 'Choose or drop ', el('code', {}, '.json.gz'), ' or ',
        el('code', {}, '.json'), ' files — anywhere over the map.'),
      el('li', {}, 'Open the bundled example set, twelve proposals over five states.'),
      el('li', {}, 'Link to published packages with ', el('code', {}, '?load='), '.')),
    el('p', {}, 'Every proposal in one session must be for the same week. ',
      'A proposal for another week is refused by name rather than quietly compared.'),

    heading('Reading the map'),
    el('p', {},
      'Each proposal gets a ', el('strong', {}, 'letter'), ' and a ',
      el('strong', {}, 'dash pattern'), ', and both appear in the legend beside the ',
      'author’s name. The drought colours are the US Drought Monitor’s own ',
      'published encoding and never vary; the change colours are NDMC’s. Both ',
      'ramps are hard to tell apart in the middle, so every swatch in this app ',
      'carries its name.'),
    el('p', {},
      'The list in the panel is the map’s text twin: everything the map marks ',
      'is a row there, in the same order, with the same words.'),

    heading('What it is not'),
    el('p', {},
      'Not the official USDM authoring tool, and nothing here reaches the published ',
      'map. A difference between two proposals is a conversation, not an error — ',
      'which is why every finding can be downloaded as a markdown brief with both ',
      'authors’ reasoning in it.'),
  );
}

/* ══ Boot ═══════════════════════════════════════════════════════════════════ */

async function boot() {
  liveRegion = createLiveRegion();

  drawerCtl = initDrawer({
    drawer: els.drawer, tab: els.drawerTab, toggle: els.btnDrawer, scrim: els.drawerScrim,
    storageKey: 'ridr-usdm-viewer-drawer',
    startOpen: params.get('drawer') === 'closed' ? false : undefined,
    onToggle: () => { map?.resize(); pushState(); },
  });

  cardCtl = initDetailCard({
    card: els.card, closeBtn: els.cardClose,
    /* Closing the card clears the selection, which is what un-highlights the
       map and the findings row. `select(null)` calls `close()` straight back;
       the kit's close returns early when the card is already hidden, so this is
       one hop and not a loop. */
    onClose: () => { select(null); },
  });

  /* NO `firstVisitKey`: the empty state IS the first-visit surface, and it is
     on the map where the two ways in are. A wall of prose over a blank map
     tells a new reader what the tool is, not where anything is. */
  initHelpModal({ dialog: els.infoModal, trigger: els.btnInfo });
  /* The kit's own `data-close-modal` handles the ×; this costs one line and
     keeps working if the attribute is ever dropped. */
  els.infoClose?.addEventListener('click', () => els.infoModal?.close());

  buildAboutModal();

  /* ── The model, before anything can hand it something ──────────────────── */
  state.session = createSession();
  bandProvider = createBandProvider({ fetchWeek, live });
  /* The engine's published-week provider shares THIS cache: one fetch serves
     both the fills and every seam's far side. */
  publishedProvider = createPublishedProvider({ fetchWeek: bandProvider.fetchWeek });
  loader = createLoader({
    session: state.session, say, live, note, onLoaded: afterIntake,
  });

  /* ── The controls ──────────────────────────────────────────────────────── */
  els.viewProposal?.addEventListener('click', () => setView('proposal'));
  els.viewPublished?.addEventListener('click', () => setView('published'));
  els.viewDifferences?.addEventListener('click', () => setView('differences'));
  els.pickSelect?.addEventListener('change', (e) => setPick(e.target.value));

  els.btnLoad?.addEventListener('click', () => els.loadInput?.click());
  els.emptyChoose?.addEventListener('click', () => els.loadInput?.click());
  els.loadInput?.addEventListener('change', (e) => {
    onFilesChosen(e.target.files);
    /* Reset, or choosing the same file twice in a row fires nothing. */
    e.target.value = '';
  });
  els.btnDemo?.addEventListener('click', onDemoChosen);
  els.emptyDemo?.addEventListener('click', onDemoChosen);
  els.btnBriefs?.addEventListener('click', onBriefs);

  /* The drop target is the WHOLE map frame; the hint says so by covering it.
     js/load.js owns the events and their depth counter; this file owns the
     element that hint is. */
  loader.attachDropTarget(els.mapFrame, {
    onDragState: (over) => { if (els.dropHint) els.dropHint.hidden = !over; },
  });

  /* ── The map ───────────────────────────────────────────────────────────── */
  map = await buildMap();
  await new Promise((resolve, reject) => {
    map.on('load', resolve);
    map.on('error', (e) => console.warn('[viewer] map error', e?.error ?? e));
    setTimeout(() => reject(new Error('the map did not finish loading')), 30000);
  });
  /* Relief FIRST, so it lands at the bottom of the app's own stack: both this
     and the drought fills insert before the same anchor (the basemap's first
     symbol layer), and MapLibre puts the later insertion closer to it. Terrain
     under the data, data under the labels. Tile failures here are warnings. */
  addHillshade(map);
  layers = createLayerStack(map);
  mapView = createMapView(map, {
    layers,
    /* ONE punch cache, and it is js/bands.js's — see the header. */
    punch: (unusedBands, aoi, week) => bandProvider.punched(week, aoi),
    fitPadding,
    /* A click resolves through `hitTest`, which reads SOURCE data:
       `queryRenderedFeatures` is blind to holes and returns tile-simplified
       geometry. A MISS IS ANSWERED OUT LOUD — a click that silently does
       nothing is indistinguishable from a broken map, chased twice in this
       fleet. */
    onPick: (hit) => {
      if (!state.session?.size) return;
      if (!hit) { say('Nothing proposed here.'); return; }
      openSelection(hit, { fit: false });
    },
  });
  await mapView.ready;

  /* The drawer's three callbacks. js/panels.js falls back to `ctx` when they
     are absent; they are passed explicitly so every route into `openSelection`
     is one route — the findings row, the map click and `?focus=` cannot end up
     opening three slightly different things. */
  panels = createPanels(els, ctx, {
    onToggleShown: (ids) => setShown(ids),
    onOpenProposal: (p) => openSelection({ kind: 'proposal', id: p?.id }),
    onOpenFinding: (f) => openSelection({ kind: f?.kind, id: f?.id }),
  });
  /* The card's two callbacks, for the same reason: a "Zoom" button and a
     cross-link to another finding are the same two verbs the list and the map
     already use, and they go to the same two functions. */
  cards = createCards(els, ctx, {
    onZoom: (target) => mapView?.focus(target),
    onOpenFinding: (f) => openSelection({ kind: f?.kind, id: f?.id }),
  });

  paintViewControls();
  paintEmptyState();
  paintFitControl();
  panels.renderSession(summaryOf());
  panels.renderLegend(state.view);

  /* ── The view, from the URL, re-validated ──────────────────────────────── */
  const urlView = params.get('view');
  if (VIEWS.includes(urlView) && urlView !== state.view) {
    state.view = urlView;
    paintViewControls();
    mapView.setView(state.view);
    panels.renderLegend(state.view);
  }

  /* Adjacency for the seam engine. OPTIONAL: a failure costs neighbour
     ENUMERATION — a seam between two loaded proposals still comes out of their
     own `edgeEffects` — and must not cost the app. */
  state.neighbors = await fetch(NEIGHBORS_URL)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!state.neighbors) {
    console.warn(`[viewer] ${NEIGHBORS_URL} could not be read; seams will be ` +
      'enumerated from the loaded proposals’ edge effects alone.');
  }

  /* ── Intake, LAST ──────────────────────────────────────────────────────── */
  /* After the map is up, so a proposal that fails to fetch leaves a working
     read-only map rather than no map at all. */
  if (params.has('demo')) {
    await loader.fromDemo();
  } else if (params.get('load')) {
    await loader.fromUrls(params.get('load').split(',').map((s) => s.trim()).filter(Boolean));
  }

  applyUrlSelection();

  booted = true;
  if (!state.session.size) {
    live('Ready. Load two or more proposals for the same week to compare them.');
  }
}

/**
 * `?pick`, `?show` and `?focus`, once there is a session for them to name.
 *
 * Every value is re-validated. A shortId that names nothing is dropped in
 * silence — it is a stale link into a set that has changed — but an unknown
 * `?focus=` SAYS SO: a brief's link that quietly opens the wrong thing is worse
 * than one that admits the finding is not in this set.
 */
function applyUrlSelection() {
  if (!state.session?.size) return;

  const pick = params.get('pick');
  if (pick) {
    const p = proposalById(pick);
    if (p) { state.pick = p; mapView?.setPick(p); paintPickControl(); }
  }

  const show = params.get('show');
  if (show) {
    const ids = show.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => proposalById(s)?.id).filter(Boolean);
    /* Set directly rather than through `setShown`: this is the URL being
       applied, not a reader narrowing anything, and `setShown`'s sentence would
       land on top of the one the comparison just announced. A `?show=` naming
       everything normalises back to the empty default. */
    if (ids.length && ids.length < state.session.size) {
      state.shown = new Set(ids);
      mapView?.setShown(ids);
      panels?.renderProposals(proposals());
      panels?.repaintDimming?.();
    }
  }

  const focus = params.get('focus');
  if (focus) {
    const finding = findingById(focus);
    if (finding) openSelection({ kind: finding.kind, id: finding.id });
    else say('That link points at a finding this set does not contain.');
  }

  pushState();
}

boot().catch((err) => {
  console.error('[viewer] boot failed', err);
  note(`This tool could not start — ${err?.message ?? 'unknown error'}.`, { error: true });
});

/* ══ Verification hook ══════════════════════════════════════════════════════
   A deliberately NARROW surface for tools/verify.mjs. It exposes the session
   and the findings so the harness can assert on the real model rather than
   scraping the DOM for numbers it would have to re-derive.

   Exposed unconditionally rather than behind a flag, because a debug path that
   only exists under test is a debug path nobody has tested — and because
   everything here is already reachable from the page's own modules by anyone
   with a console open. There is no privilege to leak: this app has no
   credentials, no backend, and no state that is not already in the URL.

   `ctx` is the same frozen getter object every other module is handed
   (docs/contracts.md § 12); it is a function so the harness never holds a stale
   reference across a reload.
   ══════════════════════════════════════════════════════════════════════════ */

const ctx = Object.freeze({
  get session() { return state.session; },
  get proposals() { return proposals(); },
  get week() { return state.session?.week() ?? null; },
  get marks() { return state.marks; },
  get findings() { return state.findings; },
  get comparisons() { return state.comparisons; },
  get seams() { return state.seams; },
  get view() { return state.view; },
  get pick() { return state.pick; },
  get shown() { return state.shown; },
  get selection() { return state.selection; },
  get viewerUrl() { return `${location.origin}${location.pathname}`; },
  get map() { return map; },
  get mapView() { return mapView; },
  get layers() { return layers; },
  get els() { return els; },
  /* The kit's two controllers, handed on rather than re-initialised: the card
     is a singleton and a second `initDetailCard` over the same element wires a
     second Escape handler onto it. */
  get card() { return cardCtl; },
  get drawer() { return drawerCtl; },
  get cards() { return cards; },
  setView, setPick, setShown,
  select: openSelection,
  focus: (target) => mapView?.focus(target),
  /* The same two verbs the panels and the card reach for by name when they are
     built without handlers. Aliases, not second implementations. */
  openFinding: (f) => openSelection({ kind: f?.kind, id: f?.id }),
  openProposal: (p) => openSelection({ kind: 'proposal', id: p?.id }),
  markFor, proposalById, findingById, brief, sessionBrief,
  /* "2-class degradation" on a change card, from NDMC's own arithmetic through
     js/proposal.js's memoized change map — the same numbers `findings-fill`
     paints with, rather than a second reading of the same two contours. */
  worstDeltaFor,
  say, live, note,
  fitPadding,
  pushState,
});

Object.defineProperty(window, '__viewer', {
  value: Object.freeze({
    get booted() { return booted; },
    get session() { return state.session; },
    get findings() { return state.findings; },
    get seams() { return state.seams; },
    get view() { return state.view; },
    get lastCompareMs() { return lastCompareMs; },
    /** Finished recompute passes. See the declaration: this is the settled
     *  signal a harness waits on, where `findings.length` is not. */
    get passes() { return passes; },
    get lastPunchMs() { return mapView?.lastPunchMs || bandProvider?.lastPunchMs || 0; },
    get lastDeriveMs() { return bandProvider?.lastDeriveMs ?? 0; },
    /** Did the basemap fetch fall back to the blank ground? A degraded boot and
     *  a slow one are indistinguishable from outside without this. */
    get basemapDegraded() { return basemapDegraded; },
    ctx: () => ctx,
  }),
  writable: false,
  configurable: false,
});
