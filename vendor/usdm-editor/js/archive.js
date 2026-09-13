/* ============================================================================
   USDM Editor · js/archive.js
   Reads the canonical US Drought Monitor archive directly, in the browser.

   No backend, no proxy, no derived copy of the data living in this repo. The
   app fetches the same GeoParquet files the archive publishes, decodes them
   client-side, and that is the whole data layer. Two facts make that possible:

     · data.sustainable-fsa.com sends `access-control-allow-origin: *` and
       `accept-ranges: bytes`.
     · hyparquet reads GeoParquet 1.1.0 natively — it parses the file's `geo`
       metadata and returns real GeoJSON from the WKB geometry column, so there
       is no WKB decoder anywhere in this app. A full national week (5 rows,
       ~10,800 vertices across 129 parts, ~165 KB ZSTD) decodes in a few ms.

   Archive: https://sustainable-fsa.com/usdm/  ·  pipeline: sustainable-fsa/usdm
   Raw USDM data are public domain; the processed archive is CC0/MIT.

   ── WHICH product: the UNCLIPPED parquet (since 2026-09) ───────────────────
   The archive publishes two GeoParquet products per week with the same schema
   and DIFFERENT row semantics:

     data/parquet/            the masked ('M') product — NDMC's polygons clipped
                              to the coastline and territorial boundaries, one
                              row per class as MUTUALLY EXCLUSIVE bands
     data/parquet_unclipped/  NDMC's cumulative D0–D4 layers as the authors drew
                              them, NOT masked: one row per class as NESTED
                              CONTOURS — each covers its class and every more
                              severe one (D1 ⊂ D0 ⊂ …)

   This app reads the UNCLIPPED product, and its rows are already the shape
   the rules engine edits (js/topology.js). The authors of the USDM draw and
   move contours, not coastlines: the masked product carried the whole US
   shoreline in D0's outer ring (1,025 parts, 137,784 vertices for D0 alone on
   2026-08-11, against 27 parts and ~3,200 vertices unclipped), which is where
   most of the vertex budget in the masked-era measurements in js/topology.js
   went. Those numbers stand as UPPER BOUNDS; the invariants they protect
   (bbox-clip over naked intersect, never recompute the nation per edit) are
   unchanged. Unclipped polygons extend past the shoreline, so an area in km²
   over an open-coast working area includes water the USDM never classifies;
   the working-area clip (the FSA LFP boundary) bounds that for any edit.

   ── The rows are HEALED on the way in ──────────────────────────────────────
   Nesting is not strict archive-wide: measured over one week per year, 10 of
   31 had an inner class leaking outside its outer one (0.05–84 km²; 2014-07-08
   D3 lies 1,185 km² outside D2), which fails the engine's containment gate
   raw (100 m²). `fetchWeek` runs `healContours` — the suffix union, a no-op
   on a clean week and the archive's own stated derivation re-accumulated on a
   leaky one (~250 ms nationally, `nesting.ms`) — and MEASURES the leak per
   class from the area delta (`nestingLeaks`, four area calls). Only a class
   that actually leaked pays for its geometry (`nestingLeakGeometry`, one
   difference), which js/app.js shows the author as a Checks-panel advisory
   clipped to the working area, and js/submit.js records in
   `pkg.baseline.nesting` so a reviewer diffing `changes[].before` against the
   raw row knows the heal, not the author, moved that ground.

   ── Schema, confirmed by inspection, not assumption (both products) ────────
   GeoParquet 1.1.0 · EPSG:4326 · ZSTD · one row group · exactly 5 rows/week:

     date         Date32          the Tuesday the map is valid for
     usdm_class   String          'D0' … 'D4'
     geometry     BYTE_ARRAY/WKB  MultiPolygon, counterclockwise
     geometry_bbox struct<xmin,ymin,xmax,ymax>   GeoParquet 1.1 covering

   The rows are CUMULATIVE CONTOURS. Verified on the republished 2026-08-11:
   area(D(n) ∩ D(n+1)) / area(D(n+1)) = 1.000000 for all four pairs.
   ========================================================================== */

import { parquetMetadata, parquetReadObjects } from '../vendor/hyparquet-1.28.2/hyparquet.esm.js';
import { decompress as zstdDecompress } from '../vendor/fzstd-0.1.1/fzstd.esm.js';
import {
  CLASSES, CONTAINMENT_TOLERANCE_M2, healContours, nestingLeakGeometry, nestingLeaks,
} from './topology.js';

/* ── Codecs ────────────────────────────────────────────────────────────────
   ZSTD only, from fzstd, which is pure JavaScript.

   The obvious choice here is `hyparquet-compressors`, which covers ZSTD,
   SNAPPY, GZIP, BROTLI and LZ4 in one import. It is not used, for one concrete
   reason: its Snappy codec is a **WebAssembly** module, and instantiating WASM
   requires `'wasm-unsafe-eval'` in this page's `script-src`. Paying that for a
   codec the archive has never used would be loosening the CSP for nothing.

   And it never has: every column of every weekly file from 2000-01-04 through
   2026-08-11 is ZSTD (checked on the clipped product; the unclipped product is
   written by the same pipeline step and its 2026-08-11 footer reads ZSTD too) — checked across the archive's span, not assumed. If that
   ever changes, this throws by name rather than returning wrong bytes, and the
   fix is one line plus a CSP decision made deliberately.

   hyparquet hands the codec the compressed page and the decompressed length;
   fzstd reads the length from the frame header itself, so the hint is unused. */
export const compressors = {
  ZSTD: (input) => zstdDecompress(input),
};

/**
 * Named so a codec change fails loudly instead of silently decoding garbage.
 * Called from `fetchWeek` against the file's own footer BEFORE any page is
 * decoded — otherwise hyparquet fails naming one page, not the archive-wide
 * encoding change that caused it.
 *
 * TWO NAMES, AND NOT A NUMBER: the vendored hyparquet decodes the Thrift enum
 * into its NAME ('ZSTD', 'UNCOMPRESSED', 'SNAPPY'). Never whitelist '1' as a
 * raw-enum fallback — in Parquet's `CompressionCodec` 1 is SNAPPY, not ZSTD,
 * so it would wave through the exact surprise this exists to catch.
 */
export function assertCodecs(metadata) {
  const seen = new Set();
  for (const rg of metadata?.row_groups ?? []) {
    for (const col of rg.columns ?? []) {
      const c = col.meta_data?.codec;
      if (c != null) seen.add(String(c));
    }
  }
  const unsupported = [...seen].filter((c) => c !== 'ZSTD' && c !== 'UNCOMPRESSED');
  if (unsupported.length) {
    throw new Error(
      `[usdm/archive] this week uses ${unsupported.join(', ')} compression, and this ` +
      `app ships only ZSTD (see the Codecs note in js/archive.js). The archive has ` +
      `been ZSTD for its whole history, so this means its encoding changed.`);
  }
}

export const ARCHIVE_ORIGIN = 'https://data.sustainable-fsa.com/usdm';
export const MANIFEST_URL = `${ARCHIVE_ORIGIN}/usdm-manifest.json`;
/* The unclipped product — see the header. `data/parquet/` is the masked one. */
export const PARQUET_PREFIX = 'data/parquet_unclipped/';

/** Archive URL for a week, given an ISO date string. */
export const weekUrl = (week) => `${ARCHIVE_ORIGIN}/${PARQUET_PREFIX}USDM_${week}.parquet`;

const ISO_WEEK = /^\d{4}-\d{2}-\d{2}$/;

/* ── manifest ─────────────────────────────────────────────────────────────── */

/**
 * Fetch the archive manifest and reduce it to the week list.
 *
 * The manifest is ~875 KB and covers every artifact in the BagIt archive —
 * metadata XML, raw zips, quality logs, summaries — of which we want one
 * directory. It is `max-age=3600` at the edge, and we keep only the parquet
 * rows, so the cost is paid once per session.
 *
 * Each week keeps its `sha256`. That is what a proposal package pins to say
 * exactly which archive bytes an edit was drawn against — a week can in
 * principle be re-issued, and a proposal that does not name the bytes it edited
 * is not reviewable.
 *
 * @returns {Promise<{weeks: string[], byWeek: Map<string,{week,path,url,size,sha256}>, latest: string}>}
 */
export async function fetchManifest({ signal } = {}) {
  const res = await fetch(MANIFEST_URL, { signal });
  if (!res.ok) throw new Error(`[usdm/archive] manifest → HTTP ${res.status}`);
  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error('[usdm/archive] manifest is not an array');

  const byWeek = new Map();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || !e.path.startsWith(PARQUET_PREFIX)) continue;
    const week = e.path.slice(PARQUET_PREFIX.length).replace(/^USDM_|\.parquet$/g, '');
    if (!ISO_WEEK.test(week)) continue;
    byWeek.set(week, {
      week, path: e.path, url: `${ARCHIVE_ORIGIN}/${e.path}`,
      size: e.size ?? null, sha256: e.hash ?? null,
    });
  }
  const weeks = [...byWeek.keys()].sort();
  if (!weeks.length) throw new Error('[usdm/archive] manifest listed no weekly parquet files');
  return { weeks, byWeek, latest: weeks[weeks.length - 1] };
}

/** The published week immediately before `week`, or null if it is the earliest. */
export function priorWeek(weeks, week) {
  const i = weeks.indexOf(week);
  return i > 0 ? weeks[i - 1] : null;
}

/* ── weekly geometry ──────────────────────────────────────────────────────── */

/**
 * Fetch and decode one week into
 * `{ week, date, contours: {D0..D4}, nesting, bytes }`.
 *
 * `contours` values are GeoJSON MultiPolygon geometries in EPSG:4326 — the
 * archive's nested rows, HEALED (see the header) — or null for a class absent
 * that week (common for D4). Classes are keyed exactly as the archive spells
 * them, so `contours.D2` is always "D2 or worse", never an index the caller
 * has to remember.
 *
 * `nesting` says what the heal did: `leaksM2` per class D0..D3 (the area the
 * next severer class lay outside this one), `leaks` the geometry of each leak
 * above `CONTAINMENT_TOLERANCE_M2` (and only those — a clean week computes
 * none), `healed` whether any did, and `ms` what the heal cost. One
 * `console.warn` per healed week: the author cannot act on an archive defect,
 * but the console is where whoever maintains the archive looks first.
 *
 * `compressors` is not optional: every column of every weekly file is ZSTD, and
 * hyparquet without it throws on the first row group.
 */
export async function fetchWeek(week, { signal, onProgress } = {}) {
  if (!ISO_WEEK.test(week)) throw new Error(`[usdm/archive] bad week "${week}", expected YYYY-MM-DD`);
  const url = weekUrl(week);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`[usdm/archive] ${week} → HTTP ${res.status}`);
  const buf = await readWithProgress(res, onProgress);

  /* The footer first. `parquetMetadata` is a synchronous read of the last few
     kilobytes we already have in hand, so checking the codecs costs nothing and
     buys the difference between "the archive's encoding changed" and hyparquet
     throwing about one page halfway through a row group. */
  assertCodecs(parquetMetadata(buf));

  const rows = await parquetReadObjects({
    file: buf, compressors, columns: ['date', 'usdm_class', 'geometry'],
  });

  const raw = Object.fromEntries(CLASSES.map((c) => [c, null]));
  let date = null;
  for (const r of rows) {
    if (!CLASSES.includes(r.usdm_class)) continue;   // 'None' exists in the factor levels
    raw[r.usdm_class] = r.geometry;
    date ??= r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date);
  }
  if (CLASSES.every((c) => !raw[c])) {
    throw new Error(`[usdm/archive] ${week} decoded to no drought classes at all`);
  }

  const t0 = performance.now();
  const contours = healContours(raw);
  const leaksM2 = nestingLeaks(raw, contours);
  const leaks = {};
  for (const c of Object.keys(leaksM2)) {
    if (leaksM2[c] > CONTAINMENT_TOLERANCE_M2) leaks[c] = nestingLeakGeometry(raw, contours, c);
  }
  const healed = Object.keys(leaks).length > 0;
  const nesting = { leaksM2, leaks, healed, ms: Math.round(performance.now() - t0) };
  if (healed) {
    const worst = Object.keys(leaks).sort((a, b) => leaksM2[b] - leaksM2[a])[0];
    const inner = `D${Number(worst.slice(1)) + 1}`;
    console.warn(`[usdm/archive] ${week}: ${inner} extends ` +
      `${(leaksM2[worst] / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} km² ` +
      `outside ${worst} in the archive's rows (${Object.keys(leaks).length} of 4 pairs leak); ` +
      `nested before use.`);
  }
  return { week, date: date ?? week, contours, nesting, bytes: buf.byteLength };
}

/**
 * Read a response body, reporting bytes as they arrive.
 *
 * A week is ~2–4 MB and the boot fetches two of them, which is long enough on a
 * field connection that silence reads as a hang. Falls back to a plain
 * arrayBuffer() when the body is not streamable or no callback was given.
 */
async function readWithProgress(res, onProgress) {
  if (!onProgress || !res.body?.getReader) return res.arrayBuffer();
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

/* ── caching ──────────────────────────────────────────────────────────────── */

/**
 * In-memory week cache, keyed by week AND by the manifest's sha256 where one is
 * known. Keying on the hash rather than the date alone means a re-issued week
 * is a cache miss instead of a stale hit — the failure that would otherwise
 * have someone editing last month's bytes under this month's label.
 *
 * Deliberately in-memory only. Draft EDITS belong in IndexedDB (they are the
 * user's work and must survive a reload); archive bytes are reproducible from
 * the network and are not worth the eviction and invalidation surface.
 */
export function createWeekCache() {
  const cache = new Map();
  const key = (week, sha256) => `${week}@${sha256 ?? '-'}`;
  return {
    async get(week, { sha256 = null, signal, onProgress } = {}) {
      const k = key(week, sha256);
      if (!cache.has(k)) cache.set(k, fetchWeek(week, { signal, onProgress })
        .catch((err) => { cache.delete(k); throw err; }));
      return cache.get(k);
    },
    has: (week, sha256 = null) => cache.has(key(week, sha256)),
    clear: () => cache.clear(),
    get size() { return cache.size; },
  };
}

/**
 * Everything the editor needs to open a week: the week itself and the week
 * before it — the baseline the change-magnitude heuristic (js/heuristic.js,
 * handoff §3b) compares against. Both arrive healed (`fetchWeek`), so the
 * `contours` contract is one contract. The prior week is ADVISORY and a second
 * request, so the two fetches run concurrently and the prior one fails on its
 * own (a bare Promise.all reported "could not load" for a week whose bytes
 * downloaded perfectly). A prior week absent from the archive (only January
 * 2000) and one that failed both arrive as `previous: null`; the caller can
 * tell them apart with `priorWeek()` and should say so. The cache evicts a
 * rejected entry, so re-opening refetches rather than serving the failure back.
 */
export async function openWeek(week, { manifest, cache = createWeekCache(), signal, onProgress } = {}) {
  const mf = manifest ?? await fetchManifest({ signal });
  if (!mf.byWeek.has(week)) throw new Error(`[usdm/archive] ${week} is not in the archive`);
  const prior = priorWeek(mf.weeks, week);
  const shaOf = (w) => (w ? mf.byWeek.get(w)?.sha256 ?? null : null);

  const [current, previous] = await Promise.all([
    cache.get(week, { sha256: shaOf(week), signal, onProgress }),
    prior
      ? cache.get(prior, { sha256: shaOf(prior), signal }).catch((err) => {
          console.warn('[usdm/archive] prior week unavailable', err);
          return null;
        })
      : Promise.resolve(null),
  ]);
  return {
    manifest: mf, cache, current, previous,
    baseline: { week, url: weekUrl(week), sha256: shaOf(week) },
    priorBaseline: prior ? { week: prior, url: weekUrl(prior), sha256: shaOf(prior) } : null,
  };
}
