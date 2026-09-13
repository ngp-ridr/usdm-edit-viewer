/* ============================================================================
   USDM Editor · js/aoi.js
   The AOI loader: kind + key → the one record the rest of the app agrees on,

       { kind, key, id, name, state, label, geometry, bbox, neighbors }

   geometry always MultiPolygon, bbox always true WGS84. js/aois.js is the
   generated INDEX (keys, names, labels — nothing else); the polygons live in
   three TopoJSON files it names but never opens.

   APP-SIDE ON PURPOSE: this module is allowed `fetch` — the quarantine that
   keeps the rules engine (topology/changeset/session/heuristic) Node-runnable.
   Nothing here decides anything about drought.

   ── The id grammar — `kind:key`, carried by the URL, session archives and
   draft scope strings:
       state    two-letter USPS code               state:MT
       aiannh   GNIS + '-' + LSAD                  aiannh:01934337-OT
       climdiv  four-character NCEI FIPS_CD        climdiv:3005
   (`county:` five-digit FIPS was the fourth form until 2026-09 — retired with
   the FSA LFP switch; `parseAOIParam` nulls it like any unknown kind and the
   caller falls through to its default.)
   The tribal key CONTAINS A HYPHEN and must: GNIS is not unique in TIGER — a
   nation's Reservation and its Off-Reservation Trust Land share one
   (`00023763-86` Tohono O'odham Nation Reservation, `00023763-OT` its trust
   land). GNIS+LSAD is unique across all 867 rows; a bare GNIS is not an AOI
   and `parseAOIParam` refuses it (vendor/aoi/PROVENANCE.md). NEVER match a
   tribal area by name; parse by splitting on the FIRST colon only, never on
   a hyphen.

   ── key / id / fid: `key` is the bare index key, unique within a kind only.
   `id` is the canonical `kind:key` — the string in URLs, js/drafts.js's
   `week::aoiId` scope, js/session.js archives and the package; a bare `3005`
   answers "which 3005?" with silence. `parseAOIParam(record.id)` round-trips
   by construction. `fid` never leaves this module: vendor/aoi/states.json
   keys states by FIPS ('30'), not the USPS code an author types.

   ── Antimeridian, applied at load time: Alaska's Aleutians cross 180°, so
   the raw state envelope is [-179.1, 51.2, 179.8, 71.4] — a box around the
   planet. When a geometry has vertices beyond -150° AND beyond +150°, the
   bbox keeps the WESTERN-HEMISPHERE span (the archive's own western limit is
   -159.79°). Measured over all three vendored files, EXACTLY ONE reachable
   AOI trips this: state:AK — no tribal area (file limit -174.24°), no
   climdiv (CONUS). The BBOX loses the eastern
   span but the GEOMETRY keeps it (Attu out to +179.78°), so for Alaska
   `bbox` is NOT the envelope of `geometry` — safe for
   `clipToAOI(parts, geometry, bbox)` (bbox prefilter first, intersect against
   the full polygon), unsafe for anything treating the bbox as authoritative
   for the geometry. Pad is 0.01°, not the old extent 0.15°: an AOI boundary
   IS the thing scoped to, and 0.15° is up to 17 km of somebody else's ground.

   Does NOT clip drought (js/topology.js `clipToAOI`), build changesets, or
   draw. It fetches, normalizes, measures.
   ========================================================================== */

import { AOI_KINDS, AOIS, aoiEntry, aoiLabel } from './aois.js';
import { T, asMulti, asFeature } from './topology.js';

/** Padding added to every side of a computed AOI envelope, in degrees. */
const BBOX_PAD = 0.01;

/** Beyond this longitude, in both directions, is where a shape may be wrapping. */
const ANTIMERIDIAN_GUARD = 150;

/** Where the same-kind adjacency table lives, relative to the document. */
const NEIGHBORS_FILE = 'vendor/aoi/neighbors.json';

/* ── caches ───────────────────────────────────────────────────────────────
   Keyed by kind, holding the PROMISE rather than the parsed result, so that
   two picker selections racing each other share one download instead of
   starting two. states.json is 4.4 MB (unsimplified on purpose); fetching it
   twice because two states were chosen in quick succession is the exact cost
   this avoids. A rejected promise is evicted so a later attempt can retry a
   transient failure — a cached rejection would make one flaky network moment
   permanent for the life of the page. */
const kindCache = new Map();
let neighborsPromise = null;

/* One warning per kind for adjacency keys that no longer resolve, not one per
   key. A boundary vintage changing under a stale neighbors.json could produce
   hundreds, and a console that scrolls is a console nobody reads. */
const warnedNeighbors = new Set();

/* ── parsing ──────────────────────────────────────────────────────────────── */

/**
 * Read a `kind:key` AOI parameter, from the URL or from localStorage.
 *
 * Returns `{ kind, key, id }` or `null` — a stored value gets the same
 * suspicion as a URL one. Unknown kind, key not in the index, bare GNIS with
 * no LSAD, stray second colon: all null; the caller falls through to its
 * default. Split on the FIRST colon only (splitting on every colon would
 * silently accept `state:MT:extra` as `state:MT`). Nothing is case-folded:
 * `OT` in a tribal LSAD is uppercase and `9C` is mixed, so no fold is right
 * for all three kinds — case leniency lives only in `legacyExtentToAOI`.
 *
 * @param {string} raw  e.g. 'state:MT'
 * @returns {{kind: string, key: string, id: string}|null}
 */
export function parseAOIParam(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const cut = s.indexOf(':');
  if (cut < 1 || cut === s.length - 1) return null;

  const kind = s.slice(0, cut);
  const key = s.slice(cut + 1);
  if (!Object.prototype.hasOwnProperty.call(AOI_KINDS, kind)) return null;
  if (!aoiEntry(kind, key)) return null;

  return { kind, key, id: `${kind}:${key}` };
}

/**
 * Read a retired `?extent=` value. A state code (`?extent=MT`) still means
 * Montana and maps to `state:MT`; a bare `w,s,e,n` rectangle names no
 * jurisdiction and returns null, dropping the visitor at the default view.
 * Case-insensitive, because a human typed or bookmarked it.
 *
 * @param {string} raw
 * @returns {{kind: string, key: string, id: string}|null}
 */
export function legacyExtentToAOI(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;      // 'w,s,e,n' lands here, and is retired
  if (!aoiEntry('state', code)) return null;
  return { kind: 'state', key: code, id: `state:${code}` };
}

/* ── loading ──────────────────────────────────────────────────────────────── */

/**
 * The full record for one AOI: identity, label, geometry, envelope, neighbours.
 *
 * Accepts `{ kind, key }` and also `{ kind, id }`, because a session archive
 * stores the identity under `id` and restoring one should not have to rename
 * the field on the way in. An `id` is kind-qualified (`state:MT` — see the
 * header), so its `kind:` prefix is stripped when it matches; a bare key under
 * `id` is tolerated for the same reason `key` is.
 *
 * Throws — with a `[usdm/aoi]` message naming what was asked for — on an
 * unknown kind, an unknown key, or a fetch that fails. A working area that
 * cannot be resolved is not a degraded map, it is the wrong map, and returning
 * null here would let a caller edit ground it never showed anyone.
 *
 * @param {{kind: string, key?: string, id?: string}} sel
 * @returns {Promise<object>} frozen AOI record
 */
export async function loadAOI(sel) {
  const kind = sel?.kind;
  const rawKey = sel?.key ?? sel?.id;
  const key = typeof rawKey === 'string' && rawKey.startsWith(`${kind}:`)
    ? rawKey.slice(kind.length + 1)
    : rawKey;
  const spec = AOI_KINDS[kind];
  if (!spec) {
    throw new Error(`[usdm/aoi] unknown AOI kind ${JSON.stringify(kind)} — ` +
      `expected one of: ${Object.keys(AOI_KINDS).join(', ')}`);
  }
  const entry = aoiEntry(kind, key);
  if (!entry) {
    throw new Error(`[usdm/aoi] no ${kind} with key ${JSON.stringify(key)} in the AOI index ` +
      `(js/aois.js lists ${AOIS[kind].length})`);
  }

  const store = await loadKind(kind);
  const geometry = geometryFor(store, kind, entry);

  return Object.freeze({
    kind,
    key: entry.key,
    id: `${kind}:${entry.key}`,
    name: entry.name,
    /* Present for county and climdiv, absent from the index for state and
       aiannh (a state IS its state; a tribal area may span several). Null
       rather than missing, so a consumer can read it without a guard. */
    state: entry.state ?? null,
    label: aoiLabel(kind, entry.key),
    geometry,
    bbox: aoiBBox(geometry),
    neighbors: await loadNeighbors(kind, entry.key),
  });
}

/**
 * The neighbouring AOIs' geometry — the edge-effects deriver needs rings, not
 * names (drought does not stop at a state line). Reads from the SAME cached
 * kind files `loadAOI` already downloads, so neighbours cost no extra parse;
 * same normalization, every geometry comes back a MultiPolygon.
 *
 * Neighbours may be CROSS-KIND (a tribal area's list names states, and a
 * state's names the tribal areas that cross its line — see `cross` in
 * neighbors.json), so each entry is resolved in ITS OWN kind's store: the
 * entries carry `kind` from `loadNeighbors` and the stores come through the
 * same promise cache everything else reads.
 *
 * @param {object} aoi  a record from `loadAOI`
 * @returns {Promise<Array<{id: string, name: string, geometry: object}>>}
 */
export async function loadNeighborGeometries(aoi) {
  const kind = aoi?.kind;
  if (!AOI_KINDS[kind]) {
    throw new Error(`[usdm/aoi] loadNeighborGeometries needs an AOI record; got kind ` +
      `${JSON.stringify(kind)}`);
  }
  const list = Array.isArray(aoi.neighbors) ? aoi.neighbors : [];
  if (!list.length) return [];

  const out = [];
  for (const n of list) {
    const nKind = AOI_KINDS[n.kind] ? n.kind : kind;
    const entry = aoiEntry(nKind, n.key ?? n.id);
    if (!entry) continue;                       // already warned in loadNeighbors
    let geometry = null;
    try {
      const store = await loadKind(nKind);
      geometry = geometryFor(store, nKind, entry);
    } catch (err) {
      console.warn(`[usdm/aoi] neighbour ${nKind}:${entry.key} has no geometry in ` +
        `${AOI_KINDS[nKind].file}; skipped`, err);
      continue;
    }
    out.push({ id: `${nKind}:${entry.key}`, name: entry.name, geometry });
  }
  return out;
}

/**
 * One kind's raw TopoJSON, from the same cache `loadAOI` fills.
 *
 * js/layers.js draws whole-kind reference meshes (state, tribal), which is a
 * question about the topology rather than about one area — so it needs the
 * document, not a record. Sharing `loadKind`'s cache is the whole point: tribal
 * areas are 655 KB and states are 4.4 MB, and drawing a kind's outlines and
 * then choosing an area from it must not download or parse the file twice.
 * (Counties are not a kind here at all — they stream as PMTiles, display only.)
 *
 * Throws the same `[usdm/aoi]` errors `loadAOI` does, for the same reasons.
 *
 * @param {string} kind
 * @returns {Promise<object>} the parsed TopoJSON document
 */
export async function loadKindTopology(kind) {
  if (!AOI_KINDS[kind]) {
    throw new Error(`[usdm/aoi] unknown AOI kind ${JSON.stringify(kind)} — ` +
      `expected one of: ${Object.keys(AOI_KINDS).join(', ')}`);
  }
  const store = await loadKind(kind);
  return store.topo;
}

/**
 * A Feature covering everything OUTSIDE the AOI — a world rectangle with the
 * AOI punched out, so the dim paint lands on every pixel the author is NOT
 * editing and not one they are (nothing paints a fill over the USDM classes;
 * see CLAUDE.md). `turf.mask` keeps only the exterior ring of each part as a
 * hole, which is correct: a lake inside a county is still inside the county.
 *
 * @param {object} aoi  a record from `loadAOI`
 * @returns {object} Feature<Polygon> — world minus the AOI
 */
export function aoiMask(aoi) {
  const turf = T();
  const feature = asFeature(aoi?.geometry);
  if (!feature) {
    throw new Error('[usdm/aoi] aoiMask needs an AOI record with geometry');
  }
  return turf.mask(feature);
}

/* ── internals ────────────────────────────────────────────────────────────── */

/* `function` declarations throughout, not `const` arrows — the TDZ trap has
   shipped broken twice in this repo (see CLAUDE.md); hoisting is cheap
   insurance in a file whose exports call downward. */

/**
 * Fetch and index one kind's TopoJSON, once per page.
 *
 * The index is a Map from the TopoJSON's own feature id to its geometry object,
 * built once. The alternative — `topojson.feature(topo, topo.objects.aiannh)`
 * and then a scan — decodes all 867 tribal areas' arcs to answer a question
 * about one of them.
 */
function loadKind(kind) {
  if (!kindCache.has(kind)) {
    kindCache.set(kind, fetchKind(kind).catch((err) => {
      kindCache.delete(kind);     // a transient failure must not become permanent
      throw err;
    }));
  }
  return kindCache.get(kind);
}

async function fetchKind(kind) {
  const spec = AOI_KINDS[kind];
  let topo;
  try {
    const res = await fetch(spec.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topo = await res.json();
  } catch (err) {
    throw new Error(`[usdm/aoi] could not load ${kind} boundaries from ${spec.file}: ` +
      `${err.message}`);
  }
  const collection = topo?.objects?.[spec.object];
  if (!collection?.geometries) {
    throw new Error(`[usdm/aoi] ${spec.file} has no TopoJSON object named ` +
      `${JSON.stringify(spec.object)}`);
  }
  const byId = new Map();
  for (const g of collection.geometries) byId.set(String(g.id), g);
  return { topo, byId };
}

/**
 * One entry's geometry, as a MultiPolygon.
 *
 * `entry.fid` is the bridge over the one place the index's key and the
 * TopoJSON's feature id disagree: states.json keys states by FIPS, the app
 * keys them by USPS code. The other two files (aiannh, climdiv) were built
 * with `id = key` precisely so this never grows a second case.
 */
function geometryFor(store, kind, entry) {
  const topojson = requireTopojson();
  const fid = String(entry.fid ?? entry.key);
  const geom = store.byId.get(fid);
  if (!geom) {
    throw new Error(`[usdm/aoi] ${kind} ${entry.key} is in the index but its geometry ` +
      `(feature id ${JSON.stringify(fid)}) is not in ${AOI_KINDS[kind].file} — ` +
      `regenerate js/aois.js with tools/build-aois.mjs`);
  }
  /* Decodes exactly this one geometry's arcs. topojson.feature() returns a
     Polygon for a single-part area and a MultiPolygon for the rest; asMulti()
     flattens that fork, which is the same normalization the rules engine
     applies at every boundary and for the same reason — reading a Polygon at
     MultiPolygon depth yields "rings" that are really coordinate pairs, and the
     error surfaces far downstream as degenerate two-vertex rings. */
  const multi = asMulti(topojson.feature(store.topo, geom));
  if (!multi) {
    throw new Error(`[usdm/aoi] ${kind} ${entry.key} decoded to empty geometry`);
  }
  return multi;
}

/**
 * The envelope, in true WGS84, with the antimeridian rule applied.
 *
 * See the module header for why this rule exists and for the measurement that
 * exactly one reachable AOI — `state:AK` — trips it.
 */
function aoiBBox(multi) {
  const points = [];
  for (const part of multi.coordinates) {
    for (const ring of part) {
      for (const p of ring) points.push(p);
    }
  }
  if (!points.length) {
    throw new Error('[usdm/aoi] cannot take the envelope of an empty geometry');
  }

  /* "Wraps" is not "has a negative longitude". It is vertices at BOTH far ends
     of the range: a shape reaching past -150° and past +150° is one shape drawn
     on two sides of the cut, not a shape spanning the Pacific. */
  const farWest = points.some((p) => p[0] < -ANTIMERIDIAN_GUARD);
  const farEast = points.some((p) => p[0] > ANTIMERIDIAN_GUARD);
  let used = points;
  if (farWest && farEast) {
    const west = points.filter((p) => p[0] < 0);
    /* Guard, not decoration: a hypothetical area lying wholly east of +150°
       would leave nothing to keep, and an empty envelope is worse than a wide
       one. Nothing js/aois.js lists is in that position — Guam and the Northern
       Marianas are, and the USDM publishes no polygons there, so they are not
       in the index at all. */
    if (west.length) used = west;
  }

  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of used) {
    if (x < w) w = x;
    if (y < s) s = y;
    if (x > e) e = x;
    if (y > n) n = y;
  }
  return [
    w - BBOX_PAD,
    Math.max(-90, s - BBOX_PAD),
    e + BBOX_PAD,
    Math.min(90, n + BBOX_PAD),
  ];
}

/**
 * The adjacency list for one AOI, resolved through the index.
 *
 * `vendor/aoi/neighbors.json` is generated alongside js/aois.js; this turns
 * its keys into something a UI can print. Two tables feed one list: the
 * same-kind table (bare keys — a state's bordering states), and `cross`
 * (kind-qualified — a tribal area names every state its ground touches, a
 * state names the tribal areas that CROSS a state line). Keys that no longer
 * resolve are skipped rather than fatal — a stale adjacency entry should cost
 * one neighbour and a warning, not the whole working area.
 */
async function loadNeighbors(kind, key) {
  let table;
  try {
    table = await loadNeighborsTable();
  } catch (err) {
    /* Adjacency is context, not data. Losing it costs the edge-effects prompt;
       it must not cost the area the author came to edit. */
    console.warn('[usdm/aoi] neighbours unavailable', err);
    return [];
  }
  const keys = table?.[kind]?.[key];
  const crossKeys = table?.cross?.[`${kind}:${key}`];

  const out = [];
  let missing = 0;
  for (const k of Array.isArray(keys) ? keys : []) {
    const entry = aoiEntry(kind, k);
    if (!entry) { missing++; continue; }
    out.push({ kind, key: entry.key, id: `${kind}:${entry.key}`, name: entry.name });
  }
  for (const q of Array.isArray(crossKeys) ? crossKeys : []) {
    /* Kind-qualified on purpose (`state:MT`) — split on the FIRST colon, the
       same grammar as everywhere else (a tribal key contains a hyphen and may
       someday contain worse; it will never contain a colon). */
    const cut = typeof q === 'string' ? q.indexOf(':') : -1;
    if (cut < 1) { missing++; continue; }
    const nKind = q.slice(0, cut);
    const entry = AOI_KINDS[nKind] ? aoiEntry(nKind, q.slice(cut + 1)) : null;
    if (!entry) { missing++; continue; }
    out.push({ kind: nKind, key: entry.key, id: `${nKind}:${entry.key}`, name: entry.name });
  }
  if (missing && !warnedNeighbors.has(kind)) {
    warnedNeighbors.add(kind);
    console.warn(`[usdm/aoi] ${missing} ${kind} neighbour key(s) are not in the AOI index — ` +
      `${NEIGHBORS_FILE} and js/aois.js are out of step; regenerate both with ` +
      `tools/build-aois.mjs`);
  }
  return out;
}

function loadNeighborsTable() {
  if (!neighborsPromise) {
    neighborsPromise = (async () => {
      const res = await fetch(NEIGHBORS_FILE);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${NEIGHBORS_FILE}`);
      return res.json();
    })().catch((err) => {
      neighborsPromise = null;
      throw err;
    });
  }
  return neighborsPromise;
}

/* The two classic-script globals index.html loads before any module runs. Named
   here rather than imported, the same way js/app.js reads window.topojson and
   js/topology.js reads globalThis.turf — there is one copy of each on the page
   and it is not an ES module. The check exists so that a missing script tag
   says so, instead of throwing `undefined is not a function` three frames deep. */

function requireTopojson() {
  const t = globalThis.topojson;
  if (!t?.feature) {
    throw new Error('[usdm/aoi] topojson-client is not loaded — index.html must include ' +
      'vendor/topojson-client-3.1.0/topojson-client.min.js before any module');
  }
  return t;
}
