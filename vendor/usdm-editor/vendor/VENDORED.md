# vendor/

Every third-party byte this app loads, committed here and served from our own
origin. Nothing is fetched from a CDN at runtime, which is what lets the page's
CSP stay at `script-src 'self'` with no external script origin.

Update with `./update.sh`, which re-fetches every pinned version below and
asserts the two things a silent CDN change would break (see *Things that will
bite you*). Bumping a version means editing `update.sh`, running it, and
re-running `tools/verify.mjs` — never hand-editing a file in here.

Two directories are exceptions and `update.sh` touches neither:

- `vendor/style/` — a **fork** with local edits, not a pinned copy.
  See [style/PROVENANCE.md](style/PROVENANCE.md).
- `vendor/aoi/` — third-party boundary data this repo **generates** rather than
  fetches: FSA LFP state boundaries (verbatim, unsimplified), Census tribal
  areas and NOAA/NCEI climate divisions (simplified), all TopoJSON out of
  `tools/build-aois.mjs`, plus the adjacency table derived from them. All
  sources are public domain; the origins, checksums and the two build phases
  are in [aoi/PROVENANCE.md](aoi/PROVENANCE.md).

| directory | package | version | form | why this form |
|---|---|---|---|---|
| `style/` | *(fork)* `sustainable-fsa/style` | v0.2.0 | source | Re-tokenized for NGP RIDR — see [style/PROVENANCE.md](style/PROVENANCE.md) |
| `maplibre-gl-5.18.0/` | `maplibre-gl` | 5.18.0 | UMD + CSS | classic script → `window.maplibregl`; Terra Draw's adapter takes it as `lib` |
| `turf-7.4.0/` | `@turf/turf` | 7.4.0 | UMD | classic script → `window.turf`; the single-file build avoids bundling ~40 ESM packages |
| `terra-draw-1.32.3/` | `terra-draw` | 1.32.3 | ESM | zero deps |
| `terra-draw-maplibre-gl-adapter-1.4.1/` | `terra-draw-maplibre-gl-adapter` | 1.4.1 | ESM | imports the bare specifier `"terra-draw"` — resolved by the **import map** in `index.html`, not by a bundler |
| `topojson-client-3.1.0/` | `topojson-client` | 3.1.0 | UMD | classic script → `window.topojson`; `vendor/style/county/county.js` requires the global |
| `hyparquet-1.28.2/` | `hyparquet` | 1.28.2 | ESM bundle | ships multi-file ESM; jsDelivr `/+esm` collapses it to one self-contained module |
| `fzstd-0.1.1/` | `fzstd` | 0.1.1 | ESM bundle | the ZSTD codec hyparquet needs — pure JS, see below |
| `pmtiles-4.5.0/` | `pmtiles` | 4.5.0 | ESM bundle | registers the `pmtiles://` protocol for the county reference tiles; lazily imported by relative path so a vendor 404 costs only the county lines — the Squire pattern. Ships with its one dependency (`fflate` 0.8.3) vendored beside it — see below |
| `squire-rte-2.4.8/` | `squire-rte` | 2.4.8 | ESM | MIT. One file, zero deps, and it ships **no CSS and no toolbar** — the chrome stays the kit's. Its six style-writing methods are never wired; see below |

## Things that will bite you

**We ship `fzstd`, not `hyparquet-compressors`, and that is a CSP decision.**
The obvious choice is `hyparquet-compressors`, which covers ZSTD, SNAPPY, GZIP,
BROTLI and LZ4 in one import. Its Snappy codec is a **WebAssembly** module, and
instantiating WASM requires `'wasm-unsafe-eval'` in the page's `script-src` —
the app failed to boot with exactly that error when the bundle was in place.
Adding that directive to support a codec the archive has never used is a bad
trade, so the app builds a one-entry codec table over `fzstd`, which is pure
JavaScript.

**The USDM archive is ZSTD, and always has been.** Every column of every weekly
file from 2000-01-04 to 2026-08-11 — checked across the span, not assumed.
`compressors` is not optional: `parquetReadObjects` without it throws on the
first row group. `js/archive.js` names any other codec in the error it throws,
so a change in the archive's encoding surfaces as a specific message rather than
as corrupt geometry.

**hyparquet decodes GeoParquet natively.** It reads the file's `geo` metadata and
returns real GeoJSON geometries from the WKB column — no separate WKB decoder is
needed anywhere in this app. A full national week (260,722 vertices across 2,068
polygon parts) decodes in ~90 ms.

**The boundary data must be the TRUE-coordinate product.** The origin that
publishes the FSA LFP boundaries also publishes the fleet's usual boundary
source, `fsa-counties-dd22.topojson`, which is a **shifted composite** — it puts
Alaska at 18–29°N off the Californian coast — while the USDM archive publishes
Alaska at 51–71°N where it is. Drawing one against the other misaligns the
reference layer by thousands of kilometres and throws no error. The
`fsa-lfp-counties` family this app uses is true WGS84, and
`tools/build-aois.mjs`'s `--states` job asserts it (state vertices north of
60°N, the Aleutian antimeridian split present) so the distinction stays
enforced rather than remembered.

Boundary data is LOCAL with one deliberate exception: the AOI polygons a
working area is clipped to and the state/nation/tribal/climdiv reference lines
all come out of `vendor/aoi/`, while the COUNTY reference lines stream at
runtime as **PMTiles** (`fsa-lfp-counties-geo.pmtiles`) from
`data.sustainable-fsa.com` — the origin the app already trusts for the archive
itself, over the same open-CORS range-request pattern hyparquet uses. Display
only: nothing reads county rings, and a blocked fetch costs exactly the county
lines.

`connect-src` still lists one DATA origin and, since the basemap landed, three
keyless TILE origins:

```
https://data.sustainable-fsa.com    the USDM GeoParquet archive + its manifest,
                                    and the county reference PMTiles
https://basemaps.cartocdn.com       the CARTO Positron style.json
https://*.basemaps.cartocdn.com     its vector tiles, sprite and glyphs
https://s3.amazonaws.com            Mapzen/AWS terrarium DEM tiles
```

None of them takes an API key, and none of them is a `script-src`: a style.json
is data MapLibre interprets, not code the page executes — and so is a PMTiles
archive. **The app still ships no remote code.** See the header of
`js/basemap.js` for why keyless, and `tools/verify.mjs` § 1, which pins that set
exactly — a missing origin fails silently, because `resolveBaseStyle()` catches
the blocked fetch by design and the app comes up looking like a deliberate
no-basemap build.

**jsDelivr's `/+esm` build of pmtiles is NOT self-contained.** Unlike hyparquet
and fzstd, it leaves its one dependency as an absolute
`import … from "/npm/fflate@0.8.3/+esm"` that only jsDelivr can serve — under
`script-src 'self'` it would fail, silently, at the first county tile.
`update.sh` therefore vendors fflate's own `/+esm` (which IS self-contained)
beside it and rewrites the import to a relative path, then greps both files for
any surviving `"/npm/` — the fzstd guard, doubled.

**`terra-draw` is a bare specifier.** The adapter does `import … from "terra-draw"`.
With no bundler, the only thing that resolves that is the `<script type="importmap">`
in `index.html`, which must appear **before** any module script in the document.

**Squire is imported by RELATIVE path, and that is deliberate.** `js/mdtext.js`
does `import('../vendor/squire-rte-2.4.8/squire.mjs')` — no import-map entry, so
adding it changed neither inline script and the CSP hashes are untouched. It is
also a DYNAMIC import behind a `.catch(() => null)`: a vendor file that fails to
load degrades the narrative field to its markdown source plus preview instead of
taking the whole module graph — and therefore the wizard — down with it.

**Squire's default sanitizer is DOMPurify, which this app does not ship.** The
stock `sanitizeToDOMFragment` calls a bare `DOMPurify.sanitize(…)`, and
`DOMPurify` appears exactly once in the bundle — in that default. Overriding the
hook is therefore mandatory rather than a hardening option: leave it alone and
the first paste or `setHTML` throws `ReferenceError: DOMPurify is not defined`.
`js/mdtext.js` passes its own allowlist sanitizer, which covers all three entry
points — `setHTML`, `insertHTML`, and the paste handler that routes through
`insertHTML`. The hook's signature is `(html, squireInstance) => DocumentFragment`,
and the fragment must belong to the *target* document; the module's sanitizer
builds every node with the page's own `document`, so no `importNode` is needed.

**Squire writes inline styles in six places and none of them is reachable here.**
Four are `setFontFace`, `setFontSize`, `setTextColour` and `setHighlightColour`,
which `js/mdtext.js` never wires; one is the image-resize overlay, unreachable
because `img` is not in the sanitizer's ALLOWED set and `insertImage` is never
called; one is a transient 1px capture `<div>` on a legacy paste branch that
browsers with `text/html` clipboard data never take. They are `style:` KEYS on
an attribute object, passed to a generic `setAttribute` loop — invisible to a
grep for `setAttribute("style"`, which is why `update.sh` guards the COUNT as
well as the literal spellings. Under this page's `style-src 'self'` the worst a
reached one could do is drop the attribute and log a console message; none
carries behaviour. Squire's `.style.prop =` CSSOM writes are a different thing
and are not blocked by CSP at all.
