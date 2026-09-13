# USDM Edit Viewer

A zero-build, serverless MapLibre app: `index.html` + ES modules under `js/`,
served by GitHub Pages from the repo root. It reads
`usdm-edit-proposal/2` packages produced by the
[USDM Editor](https://github.com/ngp-ridr/usdm-editor), finds where two of them
answer the same ground differently, and writes a markdown discussion brief per
disagreement. **It never edits a proposal and it never writes anything back.**
No backend, no build step. Start with [README.md](README.md); the interfaces
every module is written against are [docs/contracts.md](docs/contracts.md) and
deferred work is in [docs/deferred.md](docs/deferred.md).

## What this app is for

Once several authors submit proposals for the same week, somebody has to
reconcile them. Two Montana proposals may disagree about the same ground; a
Wyoming proposal may push D3 up to the Montana line while Montana's proposal
leaves the other side at D2. The editor is deliberately one author, one area, so
nothing there can show that. This is the reconciliation view.

Three kinds of finding, and the wording matters because they ask different
questions of a reviewer:

- **Conflict** — two proposals change the same ground to DIFFERENT resulting
  classes. **Listed first, always.** This is what a reconciliation meeting
  exists to settle.
- **One-sided** — one proposal changes ground the other leaves as published.
  Usually not a disagreement at all; often just two people working different
  parts of a state.
- **Seam** — a step along a shared working-area border that the published map
  did not have. A two-class step at a jurisdiction line is almost never
  physical.

The output is the on-screen comparison **plus a markdown brief** per finding:
the ground, both authors, each side's rationale and evidence in full, the class
disagreement in ordinals, and questions chosen by case. The tool's job is to
make differences visible and give reviewers something to talk from. It resolves
nothing.

## THE VENDORED COPY IS THE FIRST RULE

`vendor/usdm-editor/` is a **pinned, byte-identical copy** of the parts of the
editor this app reads — 19 modules, the style kit, seven vendored libraries —
written by `tools/sync-from-editor.mjs` and recorded in `MANIFEST.json` with the
editor commit it came from.

- **Never edit a byte of it.** Not a comment, not a whitespace fix.
  `node tools/sync-from-editor.mjs --check` fails on a changed sha256, on an
  unlisted file under the mirror, on a relative import that resolves to nothing,
  and on a missing page-relative data file. It runs in CI on every push.
- Behaviour this app needs differently gets a **small wrapper in `js/`** that
  calls into the copy — `js/bands.js`'s punch (12 lines of the editor's
  `app.js:616–632`), `js/recheck.js`'s magnitude grading over
  `verifyPackage`, `js/map.js`'s composition of `createLayerStack`. A drifted
  copy is a copy nobody can re-sync, and re-syncing is how this app inherits an
  editor fix.
- **The prefix MIRRORS THE EDITOR'S ROOT** (`js/` beside `vendor/`) because
  every editor module imports its libraries by relative path — `archive.js` →
  `../vendor/hyparquet-1.28.2/…`, `mdtext.js` → a guarded
  `../vendor/squire-rte-2.4.8/squire.mjs`, `layers.js` → a lazy
  `../vendor/pmtiles-4.5.0/…`. Under one mirrored prefix every one of those
  resolves unchanged and no specifier is ever rewritten. The kit therefore lives
  at `vendor/usdm-editor/vendor/style/`, and this app's `js/*` import it from
  there.
- **`vendor/aoi/` is the exception and sits at the PAGE ROOT**, because
  `js/aois.js` names its TopoJSON as page-relative urls and `js/aoi.js`
  `fetch`es them — they resolve against the document, not the module.
  `climdiv.json` is deliberately not copied: this app resolves no climate
  division.
- **Never call `vendor/style/ui/legend.js`.** It writes inline `style`
  attributes, which this page's CSP drops, and the legend renders unstyled.
  Legends here are hand-built through CSSOM writes.
- Re-syncing after an editor change is two commands and a commit:
  `node tools/sync-from-editor.mjs --write && node tools/sync-from-editor.mjs --check`.

## Inherited house rules

These came from the editor, they cost real hunts there, and they apply here
unchanged.

- **No inline `style` attributes, anywhere.** The page runs `style-src 'self'`
  with no `'unsafe-inline'`, so a style attribute is silently dropped and the
  element renders unstyled — a failure that looks like a CSS bug. `el()` in
  `vendor/usdm-editor/js/dom.js` throws if handed one. CSSOM writes
  (`.style.background`) are fine — that is how every swatch gets its colour.
- **ONE inline script, CSP-hashed**: the anti-flash theme boot. The editor has
  two because Terra Draw's adapter needs an import map; **this app has no import
  map and must not grow one** without a second hash and an edit to verify § 1.
  `node tools/csp-hash.mjs --write` after touching the boot; never hand-edit the
  hash.
- **The engine is DOM-free**: `js/proposal.js`, `js/session.js`, `js/compare.js`,
  `js/seams.js`, `js/brief.js`, `js/marks.js` and `js/recheck.js` run under Node
  (`tools/compare.test.mjs`, `tools/marks.test.mjs`). No `window`, `document` or
  `fetch`; turf comes through `topology.js`'s exported `T()` shim.
  `js/published.js` is the ONE exception and is allowed `fetch` alone, because
  the published far side of a seam is the only thing that needs the network.
  `tools/compare.test.mjs` § 0 greps the source text for all of it.
- **`css/app.css` is app layout only.** Any rule touching a kit selector is
  tagged `/* kit-override: <why> */` and the header counts them. Keep the count
  truthful; it is **1** (the MapLibre attribution lift). `#detail-card`'s width
  is this app's own id and is placement, which the kit says in as many words is
  the app's job.
- **The USDM colours are data, not brand — two ramps, both in
  `vendor/usdm-editor/js/color.js`.** `D0 #ffff00 … D4 #730000`, plus NDMC's
  published class-change ramp (`USDM_CHANGE_COLORS`, ±5). Never in the theme,
  never varying by theme; `tools/tokens.test.mjs` fails if either leaks into the
  token blocks OR if `css/app.css` carries a raw hex at all. Both ramps are
  CVD-hostile in their middles, so **wherever either colour appears its NAME
  appears with it**. `#cccccc` no-change is documented and never painted: the
  zero band stays unpainted and the legend carries a labelled hole.
- **Everything a reader SEES is in miles; everything the JSON carries is
  metric, under keys that say so.** `vendor/usdm-editor/js/units.js` owns the
  conversion and the formatting — `fmtMi2`, `fmtMi2Fine`, `fmtMi`, the `MI2`
  string — and every sentence, table cell, aria-label and markdown brief goes
  through it. `areaKm2` / `lengthKm` in this app's own objects stay km².
- **The kit's `showToast()` is a SINGLETON** appending its own `.ridr-toast`
  (read toasts with `querySelectorAll('.ridr-toast')`). Two toasts in one turn
  means the first was never read — an operation that also warns sends ONE
  sentence.
- **`.ridr-modal` is a transparent positioning shell** — the visible panel is
  `.info-modal-box` inside it; omit the box and the text floats over the map
  with no background or scrolling. One dialog is left (About), and
  `.ridr-modal.wide` does not exist here.
- **Watch for `const` arrow functions reached before their declaration** — two
  editor modules shipped broken this way (a constructor ran first, hit the TDZ,
  and took the app down while the read-only map looked fine). Use a `function`
  declaration for anything a constructor might reach.
- **Safari has no `requestIdleCallback`.** This app is public; Chromium-only
  profiling is not evidence about Safari.
- **Never a naked `turf.intersect` over an extent** — `clipToExtent` (bbox
  prefilter + per-part `bboxClip`) is 125–340× faster at identical results.
  `clipToAOI` is the editor's one sanctioned exception and stays the only one.
- **Turf boolean ops return `Polygon` OR `MultiPolygon`.** Normalize with
  `asMulti()` at every boundary; read at the wrong depth you get "rings" that
  are coordinate pairs.

## The module map

| module | owns | and NOT |
|---|---|---|
| `js/app.js` | boot, state, the URL, the frozen `ctx` every module reads through, the empty state, the drop target | any rendering — the panels, the cards and the map are their own modules |
| `js/load.js` | intake: files / drag-drop / `?load=` / `?demo` → packages plus **sentences**; the origin check that happens BEFORE the fetch | the session's rules (`js/session.js`) |
| `js/bands.js` | the published week: `fetchWeek` → `deriveBands` → the punch per AOI, cached on (week, AOI) | anything about a proposal |
| `js/map.js` | `createLayerStack` plus the viewer's own sources and layers; `hitTest` over SOURCE data | the letters and dashes (`js/marks.js`) |
| `js/marks.js` | letter + dash assignment per proposal; DOM-free | any colour |
| `js/panels.js` | the drawer: session line, view segments, proposals, findings, legend | the findings themselves |
| `js/cards.js` | the detail card: proposal / change / finding / seam | the brief text (`js/brief.js`) |
| `js/recheck.js` | `verifyPackage` plus **magnitude grading** (pass / residue / defect); DOM-free | the sentence's placement |
| `js/export.js` | brief download, copy, filenames, `?focus=` links | the markdown (`js/brief.js`) |
| `js/proposal.js` | one package → a frozen `Proposal`, its memoized partitions, `classAt`, `checkIntegrity` | the network |
| `js/session.js` | the set: one week, dedup by id, the groups worth comparing | the comparison itself |
| `js/compare.js` | regions — the exact-polygon comparison and its ranking | seams |
| `js/seams.js` | shared lines, sampling, runs, `Seam` | the published far side (`js/published.js`) |
| `js/published.js` | the ONE module allowed `fetch` in the engine: the published week near a bbox | any grading or labelling |
| `js/brief.js` | deterministic markdown; miles only | turf, the DOM, and any colour of its own |

Import direction is one way — `brief → color/units/prose`;
`compare, seams → proposal → vendor/usdm-editor/{topology, changeset, changes,
submit}`; `session → proposal, compare`; `published → vendor/usdm-editor/
{archive, topology}` — and **no engine module imports `dom.js`**.

## Marks: how a proposal is identified on the map

Two channels per proposal, because colour alone can never separate them (the
class fills already own every colour on screen and must not be tinted).

| dash | `line-dasharray` | legend swatch |
|---|---|---|
| 0 | solid | `border-top-style: solid` |
| 1 | `[2, 1.5]` | `dashed` |
| 2 | `[0.2, 1.6]` round | `dotted` |
| 3 | `[2.5, 1.2, 0.4, 1.2]` | `double` |

**Letters A, B, C… in load order across the session; the dash index cycles
0–3 WITHIN an AOI** — proposals in different working areas never overlap, so
the pattern only has to separate the ones that can. A fifth proposal in one AOI
repeats pattern 0, the letter carries it, and the app toasts once.

`line-dasharray` is **not data-driven** in MapLibre, so the four patterns are
four layers (`patches-line-0` … `patches-line-3`) filtered on `mark`. Do not try
to collapse them.

**THE ANCHOR LETTER IS A DOCUMENTED DOCTRINE EXCEPTION.** `anchors-label` is a
symbol layer drawn over the USDM classes. The editor's rule is that nothing
paints over that ramp, and the reason is that a translucent fill makes one
drought read as two classes. A glyph does not blend — it REPLACES pixels, the
way the basemap's place names already do (which is the other allowed symbol) —
and it is the text twin of the dash, which is the only channel a
colour-blind reader has. It is allowed here, it is allowed nowhere else, and
this paragraph is the record.

Everything else on the map follows the editor's rule unchanged: the class fills
are opaque 1.0 and nothing tints them; `findings-fill` paints NDMC's OTHER
published encoding at 1.0 in the Differences view, where the class fills are
hidden.

## Views

Three modes, not layers. `aria-pressed` on these three controls and nowhere
else in this app.

| view | what the map shows |
|---|---|
| **A proposal** | the picked proposal's classes inside its working area, the published week around it with that area **punched out** — so exactly one group covers any pixel. Without the punch an improvement changes nothing on screen, since an opaque fill can only add. |
| **Published** | the week as NDMC shipped it, nothing punched, no proposal painted. |
| **Differences** | the class fills hidden, `findings-fill` painting the change ramp over every finding, both outline kinds and the seams on, patch outlines off. |

`setMapView` takes `'changes'`, not `'change'` — the editor's spelling, and the
viewer's Differences view maps onto it.

## URL grammar

Read ONCE at boot, URL > default, every value re-validated. **A view at defaults
emits no query string.** The camera is deliberately ephemeral: it fits the
loaded AOIs, or the `?focus=` finding, so a shared link opens on the comparison
rather than on somebody's pan.

```
?load=<url>,…   origin must be location.origin or https://data.sustainable-fsa.com,
                CHECKED BEFORE THE FETCH — a CSP block is silent and would read
                as a network failure
?demo           the bundled example set
?view=          published | differences
?pick=          <shortId>            8 hex of pkg.id, 12 on collision
?show=          <shortId>,…          emitted only when not all are shown
?focus=         <findingId>          disc:<8 hex> or seam:<8 hex> — docs/contracts.md § 8
?theme=light    high-contrast is the DEFAULT and this is the only route back;
                the anti-flash boot reads the URL and nothing else
?drawer=closed  desktop only, and only when closed
```

**A new `?load=` origin means editing the CSP AND verify § 1, never one without
the other.** After a local-file load the session line says a link will open
empty — local files cannot travel in a URL, and pretending otherwise is the
failure worth a sentence.

## Intake sentences

Every refusal names what was wrong and what to do, in one sentence.
`docs/contracts.md` § 15 is the full table; the shape is:

- not gzip or JSON · not readable JSON · not a proposal file (naming the schema
  it found) · `/1` cannot be compared · **drawn against another week — load it
  in a session of its own, naming both weeks** · already loaded · too large ·
  different sha256, same week → load it, with one warning.

One toast per turn. The full list lands in `#app-note.is-error`; progress goes
to the live region only.

## The re-check, and why magnitude grading is not optional

**8 of the 10 original example packages FAIL `verifyPackage`'s
`derivedBands ⇔ changes[].after` mutual-containment rule** — every failure
0–0.4 mi², all of it clipper residue that `deriveBands` drops under
`MIN_PART_AREA_M2` and the `deriveContours` round trip cannot restore. Worst
measured: 0.984 km² at 9.1 m mean width.

So `js/recheck.js` grades by MAGNITUDE, with the same two-channel test
`validateDerivedBands` already uses for band overlap: ≤ 100 m² is ignored;
≤ 1 km² AND ≤ 50 m mean width is `'residue'`; anything else is `'defect'`, and
only then is the verifier's own sentence shown. A `residue` grade is **not** a
warning and must not be painted as one — a tool that flags eight of ten
reference proposals as suspect has told the reader nothing.

## Accessibility

- `createLiveRegion()` once; **one sentence per event**.
- **The findings list is the map's text twin.** A screen reader cannot see a
  WebGL canvas, so everything the map marks is a row in the panel, in the same
  rank order, with the same words the card uses. The count is mirrored in a
  `role="status"` sentence.
- Colour is never the only channel, for either ramp or for any mark. Every pair
  of marks differs on at least two axes.
- **No accessible name on one screen may contain another's** — the navbar, the
  drawer and an open card are swept together (the editor's § 9f rule).
- Real `<label for>` on every control that has a visible label; `aria-pressed`
  on the three view segments alone.

## Before you push

Two lanes. The static gates run on every commit; the browser lanes are CI's.

Development gate, every commit:

```sh
node tools/parse.test.mjs && node tools/tokens.test.mjs && node tools/csp-hash.mjs \
  && node tools/sync-from-editor.mjs --check \
  && node tools/marks.test.mjs && node tools/compare.test.mjs \
  && node tools/verify.mjs --fast \
  && npx --prefix tools html-validate index.html
```

Full pre-release gate: the same with `node tools/verify.mjs` unabridged and
`node tools/a11y-audit.mjs`.

CI (`.github/workflows/audit.yaml`) runs `static` and `engine` on every push and
PR, `verify --fast` on push/PR, and `verify-full` + `a11y` nightly and on
dispatch. A superseded push's run is cancelled by the next one.

Serve locally with `python3 -m http.server 8000 -d .` — **from the repo root**,
because `vendor/aoi/*.json` is fetched page-relative and a server rooted
anywhere else 404s it.
