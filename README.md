# USDM Edit Viewer

**View and compare proposed US Drought Monitor edits.**
→ **[ngp-ridr.github.io/usdm-edit-viewer](https://ngp-ridr.github.io/usdm-edit-viewer/)**

Load several `usdm-edit-proposal` packages for one week, see every proposed
change on one map with who proposed it and why, and let the tool find and rank
the places the proposals disagree — the same ground with two different answers,
and the borders where a step appeared that the published map did not have.

It never changes a proposal, and nothing here reaches the published US Drought
Monitor.

---

## Why

The [USDM Editor](https://github.com/ngp-ridr/usdm-editor) is deliberately one
author, one working area. Once several authors submit proposals for the same
week, somebody has to reconcile them — and nothing showed those disagreements.
Two Montana proposals may answer the same county differently; a Wyoming proposal
may push D3 right up to the Montana line while Montana's proposal leaves the
other side at D2.

This tool makes those differences visible and gives reviewers something to talk
from. It resolves nothing on its own; that is the point.

## What it finds

| kind | means | listed |
|---|---|---|
| **Conflict** | two proposals change the same ground to **different** resulting classes | first, always |
| **One-sided** | one proposal changes ground the other leaves as published | second |
| **Seam** | a step along a shared working-area border that the published week did not have | third |

Each finding carries the ground it covers in square miles, both authors, the
class each side proposes, and the span between them in classes. A **two-class
step at a jurisdiction line is almost never physical**, and the tool says so.

## Three ways to load proposals

1. **Choose or drop files.** `.json.gz` or `.json`, several at once, anywhere
   over the map.
2. **`?load=`** — comma-separated URLs of published packages. The origin must be
   this site or the USDM archive; anything else is refused with a sentence
   before the fetch, because a blocked request would otherwise look like a
   network failure.
3. **`?demo`** — the bundled example set: twelve proposals over five Northern
   Great Plains states for the week of 2026-09-08, each by a different fictional
   author, including deliberately **dissenting** pairs so both kinds of conflict
   have a worked example.

Every proposal in one session must be for the **same week**. One for another
week is refused by name rather than quietly compared.

## Reading it

Each proposal gets a **letter** (A, B, C… in load order) and a **dash
pattern**, and both appear in the legend beside the author's name and on the map
beside the ground. Two channels, never colour alone — the drought colours are
the USDM's own fixed published encoding and this app does not get to tint them.

Three map views:

- **A proposal** — one proposal's classes inside its working area, the published
  week around it.
- **Published** — the week as NDMC shipped it.
- **Differences** — NDMC's class-change encoding painted over every finding,
  with the class fills hidden.

The findings list in the panel is **the map's text twin**: everything the map
marks is a row there, in the same order, with the same words. A screen reader
cannot see a WebGL canvas, so the list is not a summary of the map — it is the
map.

## Briefs

Every finding can be downloaded or copied as a **markdown discussion brief**:
the ground, both authors with their affiliations, each side's rationale and
evidence **in full**, the disagreement stated in ordinals, and three to five
questions chosen to fit the case. Every brief links back to the exact finding
with `?focus=`, so a reader can open what the brief is about in one click.

"Export briefs" writes the whole session as one file: a header table, an
integrity table, the ranked index, a "Not compared" section, then every brief.

Areas are in **square miles** everywhere a person reads one. The JSON keys stay
metric, under names that say so.

## Layout

```
index.html            ONE inline script (the anti-flash theme boot), no import map
css/app.css           app layout only; kit-override count: 1
js/
  app.js              boot, state, URL, the frozen ctx every module reads through
  load.js             intake: files / drop / ?load= / ?demo → packages + sentences
  bands.js            the published week, punched per working area
  map.js  marks.js    the map surface; letters and dashes
  panels.js  cards.js  recheck.js  export.js
  proposal.js  session.js  compare.js  seams.js  brief.js  published.js   ← the engine
vendor/
  usdm-editor/        SYNCED, byte-identical — MANIFEST.json + PROVENANCE.md
  aoi/                SYNCED, at the PAGE ROOT (fetched page-relative)
demo/                 the bundled example set
tools/                the gates
```

`vendor/usdm-editor/` **mirrors the editor's root** (`js/` beside `vendor/`) so
that every relative import inside the copy resolves unchanged and no specifier
is ever rewritten. `vendor/aoi/` sits at the page root instead, because those
files are fetched against the document rather than the module. Details, and the
rule that the copy is never edited, are in
[vendor/usdm-editor/PROVENANCE.md](vendor/usdm-editor/PROVENANCE.md).

## Development

No build step. Serve the repo root and open it:

```sh
python3 -m http.server 8000 -d .
```

**From the repo root** — `vendor/aoi/*.json` is fetched page-relative and a
server rooted anywhere else 404s it.

Re-sync the vendored editor copy after an editor change:

```sh
node tools/sync-from-editor.mjs --write --source=../usdm-editor
node tools/sync-from-editor.mjs --check
```

`--write` refuses a dirty source: the commit it records is the provenance claim,
and a copy taken from a working tree cannot be reproduced from it.

### Gates

```sh
node tools/parse.test.mjs && node tools/tokens.test.mjs && node tools/csp-hash.mjs \
  && node tools/sync-from-editor.mjs --check \
  && node tools/marks.test.mjs && node tools/compare.test.mjs \
  && node tools/verify.mjs --fast \
  && npx --prefix tools html-validate index.html
```

| gate | what it proves |
|---|---|
| `parse.test.mjs` | every module — the vendored copy included — parses as an ES module, which `node --check` (CommonJS) does not |
| `tokens.test.mjs` | every design token resolves in both themes, the measured contrast contract holds, neither published ramp leaked into the theme, `css/app.css` has no raw hex, and its kit-override count is true |
| `csp-hash.mjs` | the one inline script's hash is current |
| `sync-from-editor.mjs --check` | the vendored copy is still the editor's bytes, nothing unlisted is under it, every relative import resolves, and the page-relative data files exist |
| `marks.test.mjs` | letters and dash patterns, under Node |
| `compare.test.mjs` | the comparison engine against the real example packages |
| `verify.mjs` | the app in a real browser |
| `a11y-audit.mjs` | axe over the app's real states |

`node tools/verify.mjs --fast` skips the expensive, low-signal sections and
prints the roster it skipped. CI runs the static and engine gates plus the fast
lane on every push and pull request; the full lane and the accessibility audit
run nightly and on dispatch.

Node 22 (`.nvmrc`). Tool dependencies live in `tools/`:
`npm ci --prefix tools`.

## Architecture notes

- **Zero build, no backend, no remote code.** Every third-party byte is
  vendored and served from this origin, which is what lets the CSP stay at
  `script-src 'self'` with one inline hash. `connect-src` is four origins: the
  USDM archive and three keyless basemap/DEM hosts.
- **The comparison engine is DOM-free** and runs under Node against the real
  packages. `js/published.js` is the one module allowed `fetch`.
- **Published bands are reconstructable from a package alone** —
  `contours[c] = changes.find(c).before` — so comparing two proposals for one
  working area needs no network at all. Measured: the two packages of every
  state agree to 0.0000 km² per class.
- **Re-check grades by magnitude.** Eight of the ten original example packages
  fail `verifyPackage`'s containment rule by 0–0.4 mi² of clipper residue, so a
  pass/fail verdict would call eight of ten reference proposals broken. Residue
  is reported as residue; only a real defect is reported as a problem.

The full engineering doctrine — every trap, every measurement, every rule and
why — is in [CLAUDE.md](CLAUDE.md), and the interfaces every module is written
against are in [docs/contracts.md](docs/contracts.md).

## License and provenance

Code is MIT. The US Drought Monitor is produced by the National Drought
Mitigation Center, USDA and NOAA; raw USDM data are public domain and the
processed archive is CC0. Boundary reference geometry is the USDA FSA Livestock
Forage Program determination boundaries (FOIA 2025-FSA-08431-F, ancestry US
Census TIGER; NDMC's own coastline) via the
[sustainable-fsa](https://github.com/sustainable-fsa/data-tiles) archive —
states vendored as TopoJSON, county reference lines streamed as PMTiles from the
same origin as the USDM archive itself. Tribal areas are US Census TIGER 2025.
All public domain.

The style kit under `vendor/usdm-editor/vendor/style/` is a fork of
`sustainable-fsa/style` v0.2.0, re-tokenized for NGP RIDR; its own
[PROVENANCE.md](vendor/usdm-editor/vendor/style/PROVENANCE.md) lists the deltas.

---

Part of the **Northern Great Plains Regional Incubator for Drought Resiliency**,
supported by the National Science Foundation R2I2 program. Built and maintained
by the [Montana Climate Office](https://climate.umt.edu), University of Montana.
