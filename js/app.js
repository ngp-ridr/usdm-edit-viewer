/* ============================================================================
   USDM Edit Viewer · js/app.js
   The application core: boot, state, URL, map, drawer, wiring.

   ── STATUS: THIS IS THE WP-A SCAFFOLD ──────────────────────────────────────
   What is here today is everything that has to exist before anything else can:
   a map on the ground js/basemap.js can get, the kit's chrome (drawer, docked
   card, About dialog, live region, toasts), the empty state, the drop target,
   the three view segments as controls, and the verification hook.

   What is NOT here is every behaviour — intake, comparison, painting, panels,
   cards, briefs. Those are WP-B through WP-E, and the seams they mount into are
   marked below with `WP-B` / `WP-C` / `WP-D` / `WP-E` and the module name from
   docs/contracts.md. THAT FILE IS THE CONTRACT; this file is one of its
   implementations, and where the two disagree the contract wins.

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

   Sections: Elements · State · Small helpers · Map · Chrome · About · Boot ·
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

/* ── THE SEAMS THE OTHER PACKAGES MOUNT INTO ──────────────────────────────────
   Commented rather than absent so the import paths are decided once, here, and
   every package writes its module to the name this file already calls.

   WP-B  intake, published bands, and the wiring that turns the rest on
   import { createLoader } from './load.js';
   import { createBandProvider } from './bands.js';

   WP-C  the map surface and the marks
   import { createMapView } from './map.js';
   import { assignMarks } from './marks.js';

   WP-D  the drawer's panels, the card, the re-check verdict, the briefs
   import { createPanels } from './panels.js';
   import { createCards } from './cards.js';
   import { recheckPackage } from './recheck.js';
   import { downloadBrief, copyBrief, downloadSessionBrief, linkTo } from './export.js';

   WP-E  the engine (DOM-free; docs/contracts.md §§ 2–8)
   import { createSession } from './session.js';
   import { compareGroup } from './compare.js';
   import { findSeams } from './seams.js';
   import { createPublishedProvider } from './published.js';
   ─────────────────────────────────────────────────────────────────────────── */

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

const state = {
  /** WP-E's Session, once it exists. */
  session: null,
  /** WP-C's Map<proposalId, Mark>. */
  marks: new Map(),
  /** The ranked findings: Region[] then Seam[]. */
  findings: [],
  comparisons: [],
  seams: [],
  /** Which of the three modes the map is in. */
  view: 'proposal',
  /** The proposal whose classes the Proposal view paints. */
  pick: null,
  /** Whose outlines draw. Empty means "everything loaded". */
  shown: new Set(),
  /** `{ kind, id }` or null. */
  selection: null,
};

let map = null;
let layers = null;
let liveRegion = null;
let drawerCtl = null;
let cardCtl = null;
let fitBtn = null;
let booted = false;

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
 * The note over the map — boot progress, and the intake's full problem list.
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

/* ── The URL ──────────────────────────────────────────────────────────────
   Written back with the kit's `replaceUrlState`, which drops every key whose
   value is null — so a view at defaults emits no query string at all.

   The camera is NOT written. See the header. */
function pushState() {
  const shown = state.shown.size ? [...state.shown].join(',') : null;
  replaceUrlState({
    view: state.view === 'proposal' ? null : state.view,
    pick: state.pick?.shortId ?? null,
    show: shown,
    focus: state.selection?.id ?? null,
    theme: getTheme() === 'high-contrast' ? null : getTheme(),
    drawer: drawerCtl && !drawerCtl.isOpen?.() && !isCompact() ? 'closed' : null,
  });
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
  /* WP-B: once a session exists, fit the union of every loaded AOI's bbox. */
  map?.easeTo({ center: NATIONAL_POSE.center, zoom: NATIONAL_POSE.zoom });
  return 'the lower 48';
}

/** Keep the fit button's name honest about WHICH thing it frames. */
function paintFitControl() {
  if (!fitBtn) return;
  const n = state.session?.size ?? 0;
  const name = n
    ? `Zoom to the loaded working areas`
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

/**
 * Build the layer stack and add every source and layer the editor's ladder owns.
 *
 * Called once from boot(), AFTER `addHillshade(map)` — which inserts under the
 * same anchor and therefore ends up beneath everything the stack adds. Relief
 * belongs to the ground.
 *
 * WP-C wraps this in `createMapView(map, { layers })` and adds the viewer's own
 * sources (`findings`, `seams`, `patches`, `anchors`) above it. The editor's
 * `usdm-changes`, `usdm-delta` and `band-*` sources stay EMPTY here — they are
 * the editor's surfaces, and an empty source is cheaper than a fork.
 */
async function addAppLayers() {
  layers = createLayerStack(map);
  await layers.addAll();
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
     either the published week or the change ramp, and neither has an author. */
  if (els.pickRow) els.pickRow.hidden = state.view !== 'proposal';
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
  /* WP-C: mapView.setView(next).  WP-D: panels.renderLegend(next). */
  pushState();
  live(`Map view: ${{
    proposal: 'one proposal’s classes, inside its working area',
    published: 'the published week',
    differences: 'the differences between the loaded proposals',
  }[next]}.`);
}

/** Show or hide the empty state. It is the map's own surface, not a dialog. */
function paintEmptyState() {
  const empty = (state.session?.size ?? 0) === 0;
  if (els.emptyState) els.emptyState.hidden = !empty;
  for (const id of ['proposalSection', 'findingsSection', 'legendSection']) {
    if (els[id]) els[id].hidden = empty;
  }
  if (els.btnBriefs) els.btnBriefs.disabled = state.findings.length === 0;
}

/**
 * The drop target is the WHOLE map frame, and the hint says so by covering it.
 *
 * `dragleave` fires on every child crossing, so the depth counter is not
 * defensive programming — without it the hint flickers off the moment the
 * pointer crosses the attribution control.
 */
function wireDropTarget() {
  const frame = els.mapFrame;
  if (!frame) return;
  let depth = 0;
  const show = (on) => { if (els.dropHint) els.dropHint.hidden = !on; };

  frame.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    depth++; show(true);
  });
  frame.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  frame.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  frame.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0; show(false);
    onFilesChosen(e.dataTransfer.files);
  });
}

/**
 * Files arrived — from the picker, from the empty state, or from a drop.
 *
 * WP-B replaces the body with `loader.fromFiles(files)`. Until then it says so
 * rather than doing nothing: a gesture that silently has no effect is
 * indistinguishable from a broken app, which is a bug this fleet has chased
 * twice.
 */
function onFilesChosen(files) {
  if (!files?.length) return;
  say(`Loading proposals is not wired up yet (${files.length} file(s) chosen).`);
}

/** The bundled example set. WP-B replaces the body with `loader.fromDemo()`. */
function onDemoChosen() {
  say('The example set is not bundled yet.');
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
       map and the findings row. WP-D re-reads this seam. */
    onClose: () => { state.selection = null; pushState(); },
  });

  /* NO `firstVisitKey`: the empty state IS the first-visit surface, and it is
     on the map where the two ways in are. A wall of prose over a blank map
     tells a new reader what the tool is, not where anything is. */
  initHelpModal({ dialog: els.infoModal, trigger: els.btnInfo });
  /* The kit's own `data-close-modal` handles the ×; this costs one line and
     keeps working if the attribute is ever dropped. */
  els.infoClose?.addEventListener('click', () => els.infoModal?.close());

  buildAboutModal();

  /* ── The controls that exist today ─────────────────────────────────────── */
  els.viewProposal?.addEventListener('click', () => setView('proposal'));
  els.viewPublished?.addEventListener('click', () => setView('published'));
  els.viewDifferences?.addEventListener('click', () => setView('differences'));

  els.btnLoad?.addEventListener('click', () => els.loadInput?.click());
  els.emptyChoose?.addEventListener('click', () => els.loadInput?.click());
  els.loadInput?.addEventListener('change', (e) => {
    onFilesChosen(e.target.files);
    /* Reset, or choosing the same file twice in a row fires nothing. */
    e.target.value = '';
  });
  els.btnDemo?.addEventListener('click', onDemoChosen);
  els.emptyDemo?.addEventListener('click', onDemoChosen);
  els.btnBriefs?.addEventListener('click', () => {
    /* WP-D: downloadSessionBrief(). Disabled while there are no findings, so
       this is only reachable once there is something to write. */
    say('Briefs are not wired up yet.');
  });

  wireDropTarget();

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
  await addAppLayers();

  paintViewControls();
  paintEmptyState();
  paintFitControl();

  /* ── The view, from the URL, re-validated ──────────────────────────────── */
  const urlView = params.get('view');
  if (VIEWS.includes(urlView) && urlView !== state.view) {
    state.view = urlView;
    paintViewControls();
  }

  /* WP-B: `?load=`, `?demo`, then `?pick` / `?show` / `?focus` once a session
     exists. They are applied LAST, after the map is up, so a failure to fetch
     a proposal leaves a working read-only map rather than no map. */

  booted = true;
  live('Ready. Load two or more proposals for the same week to compare them.');
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
  get proposals() { return state.session?.list() ?? []; },
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
  get layers() { return layers; },
  get els() { return els; },
  /* The kit's two controllers, handed on rather than re-initialised: the card
     is a singleton and a second `initDetailCard` over the same element wires a
     second Escape handler onto it. */
  get card() { return cardCtl; },
  get drawer() { return drawerCtl; },
  setView,
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
    /** Did the basemap fetch fall back to the blank ground? A degraded boot and
     *  a slow one are indistinguishable from outside without this. */
    get basemapDegraded() { return basemapDegraded; },
    ctx: () => ctx,
  }),
  writable: false,
  configurable: false,
});
