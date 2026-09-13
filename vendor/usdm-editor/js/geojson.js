/* ============================================================================
   USDM Editor · js/geojson.js
   The proposal as one RFC 7946 FeatureCollection — openable in QGIS or
   geojson.io, where `usdm-edit-proposal/2` has no reader — plus the
   cross-border note beside it. DOM-free like the rest of the rules engine; no
   Turf either: nothing here looks inside a ring, and the only import is
   js/color.js (asserted by tools/topology.test.mjs § 11n's source scan set).

   A PROJECTION of the package, never a second computation: every value comes
   from `buildProposalGeoJSON`'s argument; nothing is re-derived and the ~15 s
   national fold never runs twice. If the package is wrong this is wrong the
   same way — the only relationship between two files describing one proposal
   that can be kept true. See CLAUDE.md.

   FLAT PROPERTIES, DUPLICATED METADATA, on purpose. Consumers ignore foreign
   members (QGIS shows the attribute TABLE), so the top-level block is for a
   person reading the file and every feature ALSO carries week, checksum, area
   and author — a feature dragged into another layer keeps its provenance.
   Values are strings, numbers and booleans only; lists join with `;`
   (`"D1;D2"`), which shapefile/GeoPackage round trips show intact where a
   nested object is silently flattened or dropped.

   THE CLASS NAMES TRAVEL WITH THE COLOURS: `usdm_color` never appears without
   `class_label` — the USDM ramp is hue-only and CVD-hostile (js/color.js).

   `description` uses the NAMED kind of change ("A new D3 area appeared."), not
   the direction word — "grew" is the same word for a new island, a split and
   an edge move. THE PHRASE IS READ, NOT BUILT: `derivePatches` stamps it
   (js/changes.js); importing the phrase function would drag the rules engine
   in for a string.

   RING WINDING IS PRESERVED EXACTLY AS PUBLISHED — RFC 7946 § 3.1.6's CCW rule
   is a SHOULD and this file does not rewind to comply: a coordinate an author
   did not touch must come out as the number that went in (the same rule that
   set Terra Draw's coordinatePrecision), and rewinding reverses coordinate
   ORDER, making the identity-fold guarantee (tools/topology.test.mjs § 7c)
   unverifiable from the export. Nothing that reads this cares: the right-hand
   rule matters only across the antimeridian (none here — js/aoi.js), and QGIS,
   GDAL/OGR, geojson.io, turf and shapely all find interior rings by
   containment, not winding.
   ========================================================================== */

import { USDM_COLORS, USDM_LABELS } from './color.js';
import { fmtMi, fmtMi2, MI2 } from './units.js';

/** The export's own schema id. Bumped independently of the package's. */
export const GEOJSON_SCHEMA = 'usdm-edit-proposal-geojson/1';

/* Declarations, not `const` arrows, for everything reachable from an export —
   the temporal-dead-zone rule this repo has been bitten by twice (CLAUDE.md). */

/**
 * The whole proposal as one FeatureCollection.
 *
 * @param {object} pkg  a built `usdm-edit-proposal/2` package
 * @returns {object} FeatureCollection with foreign members; see the header
 */
export function buildProposalGeoJSON(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('[usdm/geojson] buildProposalGeoJSON needs a built package');
  }

  /* The facts every feature repeats. Read once so a feature and the top-level
     block cannot disagree about the same value. */
  const common = {
    proposal_id: pkg.id ?? null,
    baseline_week: pkg.baseline?.week ?? null,
    baseline_sha256: pkg.baseline?.sha256 ?? null,
    aoi_id: pkg.aoi?.id ?? null,
    aoi_name: pkg.aoi?.name ?? null,
    author_name: pkg.author?.name ?? null,
    created: pkg.created ?? null,
  };

  const features = [];

  /* ── the changes, in the order the author's numbering runs ─────────────── */
  for (const change of asArray(pkg.proposedChanges)) {
    if (!change?.geometry) continue;
    features.push(feature(change.geometry, {
      role: 'change',
      id: change.id ?? null,
      seq: numberOrNull(change.seq),
      name: change.name ?? null,
      area_km2: round(change.areaKm2, 3),
      classes: joinValues(change.classes, 'class'),
      /* The full names, always beside the ids — the CVD rule, one level out
         from the map. An attribute table showing "D1;D2" and a hex is a table
         where the class is a colour. */
      class_labels: joinLabels(change.classes),
      directions: joinValues(change.classes, 'direction'),
      categories: joinValues(change.classes, 'category'),
      description: describeChange(change.classes),
      rationale: change.rationale ?? null,
      reviewed: change.reviewed === true,
      annotated: change.annotated === true,
      ...common,
    }));
  }

  /* ── the per-class contours, before and after ──────────────────────────── */
  for (const change of asArray(pkg.changes)) {
    const c = change?.class;
    if (!c) continue;
    const shared = {
      class: c,
      class_label: change.label ?? USDM_LABELS[c] ?? null,
      usdm_color: USDM_COLORS[c] ?? null,
      area_km2_before: round(change.areaKm2?.before, 3),
      area_km2_after: round(change.areaKm2?.after, 3),
      area_km2_delta: round(change.areaKm2?.delta, 3),
      parts_before: numberOrNull(change.parts?.before),
      parts_after: numberOrNull(change.parts?.after),
      ...common,
    };
    /* A class that did not exist in the working area before the edit, or does
       not exist after it, is a NULL geometry rather than an empty polygon —
       and a null-geometry Feature, while legal in RFC 7946, is what a GIS
       shows as an unselectable blank row. Skipped; the areas above still say
       what happened, on the row that does have geometry. */
    if (change.before) features.push(feature(change.before, { role: 'baseline-contour', ...shared }));
    if (change.after) features.push(feature(change.after, { role: 'proposed-contour', ...shared }));
  }

  /* ── what this proposal says across a border ───────────────────────────── */
  for (const effect of asArray(pkg.edgeEffects)) {
    const geometry = lineGeometry(effect?.segments);
    if (!geometry) continue;
    features.push(feature(geometry, {
      role: 'edge-effect',
      id: effect.patchKey ?? null,
      seq: numberOrNull(effect.seq),
      name: effect.name ?? null,
      neighbors: joinStrings(effect.neighborNames),
      neighbor_ids: joinStrings(effect.neighborIds),
      classes: joinStrings(effect.classes),
      class_labels: joinStrings(asArray(effect.classes).map((c) => USDM_LABELS[c] ?? c)),
      directions: joinStrings(effect.directions),
      categories: joinStrings(effect.categories),
      statement: effect.statement ?? null,
      length_km: round(effect.lengthKm, 3),
      ...common,
    }));
  }

  /* ── the working area itself, last ─────────────────────────────────────── */
  if (pkg.aoi?.geometry) {
    features.push(feature(pkg.aoi.geometry, {
      role: 'aoi',
      kind: pkg.aoi.kind ?? null,
      id: pkg.aoi.id ?? null,
      name: pkg.aoi.name ?? null,
      ...common,
    }));
  }

  return {
    type: 'FeatureCollection',
    /* Foreign members. RFC 7946 § 6.1 permits them and requires consumers to
       ignore what they do not know, so nothing below can break a reader — and
       a person who opens the file in a text editor gets the whole provenance
       in the first twenty lines. */
    schema: GEOJSON_SCHEMA,
    proposal_id: pkg.id ?? null,
    created: pkg.created ?? null,
    app: pkg.app ?? null,
    baseline: pkg.baseline ?? null,
    aoi: pkg.aoi
      ? { kind: pkg.aoi.kind ?? null, id: pkg.aoi.id ?? null, name: pkg.aoi.name ?? null }
      : null,
    author: pkg.author ?? null,
    justification: pkg.justification ?? null,
    validation: {
      scope: pkg.validation?.scope ?? null,
      passed: pkg.validation?.passed === true,
    },
    /* The WORKING AREA's envelope, not the union of the features'. The
       proposal is scoped to a jurisdiction and every feature in it is inside
       that jurisdiction, so this is the extent a reader should be zoomed to —
       and it is the same rectangle the package pins, rather than a second
       number computed a second way. */
    bbox: pkg.aoi?.bbox ?? undefined,
    features,
  };
}

/* ── the cross-border brief ───────────────────────────────────────────────── */

/**
 * A short Markdown note for the authors next door.
 *
 * One section per neighbouring jurisdiction, because that is who reads it: an
 * author in North Dakota wants the paragraph about the Montana / North Dakota
 * line and has no use for the Idaho one. An edge effect that names two
 * neighbours therefore appears in BOTH sections — the statement is true of each
 * border it names, and splitting it so that each sentence appeared once would
 * mean sending someone half a proposal.
 *
 * Markdown rather than prose in the package: this is a document a person
 * forwards, pastes into an email, or opens in any editor. It carries no
 * geometry at all — the GeoJSON export is where that lives — and it closes on
 * the baseline checksum, so a recipient can pin what it is talking about.
 *
 * @param {object} pkg  a built `usdm-edit-proposal/2` package
 * @returns {string} Markdown; a one-line note when nothing touches a border
 */
export function buildEdgeBrief(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    throw new Error('[usdm/geojson] buildEdgeBrief needs a built package');
  }
  const effects = asArray(pkg.edgeEffects);
  const aoiName = pkg.aoi?.name ?? pkg.aoi?.id ?? 'the working area';
  const week = pkg.baseline?.week ?? 'an unrecorded week';

  const lines = [];
  lines.push(`# Cross-border note — ${aoiName}, ${week}`);
  lines.push('');
  lines.push(`This note accompanies a proposed edit to the US Drought Monitor for ` +
    `**${week}**, drawn inside **${aoiName}**. It lists only the changes that run ` +
    `along a shared boundary, for the authors working on the other side of it. ` +
    `Nothing here has been published, and nothing here changes the official map.`);
  lines.push('');
  lines.push(`- **Proposal** \`${pkg.id ?? '(no id)'}\``);
  lines.push(`- **Baseline week** ${week}`);
  lines.push(`- **Working area** ${aoiName}${pkg.aoi?.id ? ` (\`${pkg.aoi.id}\`)` : ''}`);
  lines.push(`- **Prepared by** ${authorLine(pkg.author)}`);
  lines.push(`- **Written** ${pkg.created ?? '(no timestamp)'}`);
  lines.push('');

  if (!effects.length) {
    lines.push('No change in this proposal reaches a shared boundary, so there is ' +
      'nothing here for a neighbouring jurisdiction to act on.');
    lines.push('');
    lines.push(...pinLines(pkg));
    return lines.join('\n');
  }

  /* Areas live on the proposed change, not on the edge effect — one patch is
     one place, and its size is a property of the place rather than of the
     border it happens to touch. Indexed once here rather than scanned per
     section. */
  const areaByKey = new Map();
  for (const c of asArray(pkg.proposedChanges)) {
    if (c?.id) areaByKey.set(c.id, c.areaKm2);
  }

  /* Keyed by neighbour ID, not name (WP-D) — an id is stable and a display
     name is a rendering choice, and it is what `justification.borderNotes` is
     keyed by (js/wizard.js `paintEdgeEffects`, which builds the SAME map for
     the same reason: the brief and the screen an author wrote the note on
     must file it under the same border). An effect can name several
     neighbours at once (a patch on a tripoint), so it is filed under every one
     it carries, exactly as before. */
  const byNeighbor = new Map();
  for (const effect of effects) {
    const ids = asArray(effect?.neighborIds);
    const names = asArray(effect?.neighborNames);
    /* An effect with no named neighbour never reaches here — deriveEdgeEffects
       drops it (js/changes.js) — but a hand-built package could carry one, and
       an unaddressed section is better than a thrown export. */
    const count = Math.max(ids.length, names.length) || 1;
    for (let i = 0; i < count; i++) {
      const id = ids[i] ?? null;
      const name = names[i] ?? 'Unnamed neighbour';
      /* An id-less neighbour still needs a section; grouped by name in that
         case, and it never gets a note printed — there is nothing in
         `borderNotes` that could address it. */
      const key = id ?? `name:${name}`;
      if (!byNeighbor.has(key)) byNeighbor.set(key, { id, name, effects: [] });
      byNeighbor.get(key).effects.push(effect);
    }
  }

  const borderNotes = (pkg.justification && isPlainObject(pkg.justification.borderNotes))
    ? pkg.justification.borderNotes : {};

  /* Distinct CHANGES, not effects: an effect is one (change, neighbour) pair
     since js/changes.js split them per border, so a change on a tripoint is
     two effects and one change. */
  const total = new Set(effects.map((e) => e?.patchKey ?? e)).size;
  lines.push(`${total} change${total === 1 ? '' : 's'} in this proposal ` +
    `${total === 1 ? 'runs' : 'run'} along the ${aoiName} boundary, ` +
    `touching ${byNeighbor.size} neighbouring ` +
    `jurisdiction${byNeighbor.size === 1 ? '' : 's'}.`);
  lines.push('');

  const groups = [...byNeighbor.values()].sort((a, b) => compareStrings(a.name, b.name));
  for (const { id, name, effects: group } of groups) {
    lines.push(`## ${aoiName} / ${name}`);
    lines.push('');
    /* THE BORDER'S OWN NOTE, in that border's own section — ahead of the
       per-change recaps, because it is the author speaking to this neighbour
       directly rather than a fact about one patch. Printed only when there is
       one: an author who wrote nothing for this border gets no empty heading. */
    const note = id != null ? borderNotes[id] : null;
    if (typeof note === 'string' && note.trim()) {
      lines.push(note.trim());
      lines.push('');
    }
    for (const effect of group) {
      lines.push(`### ${effect.name ?? 'A change'}`);
      lines.push('');
      lines.push(effect.statement ?? 'A change runs along this boundary.');
      lines.push('');
      const classes = asArray(effect.classes);
      const phrases = asArray(effect.phrases);
      /* The category phrase, when there is one, rather than the raw direction
         word — "a hole opened in D2" says more than "D2 (Severe Drought,
         shrank)" does, for the same reason `describeChange` replaces
         `directions` above. Falls back to nothing rather than to the bare
         direction: a stale `edgeEffects` array from before this change carries
         no `phrases` at all, and a half-true fallback reads as a fact. */
      lines.push(`- **Classes** ${classes.length
        ? classes.map((c, i) => `${c} (${USDM_LABELS[c] ?? 'unnamed class'})` +
            (phrases[i] ? ` — ${phrases[i]}` : '')).join(', ')
        : 'none recorded'}`);
      lines.push(`- **Shared boundary** ${km(effect.lengthKm)}`);
      const area = areaByKey.get(effect.patchKey);
      if (Number.isFinite(area)) lines.push(`- **Changed area** ${km2(area)}`);
      lines.push('');
    }
  }

  lines.push(...pinLines(pkg));
  return lines.join('\n');
}

/* ── internals ────────────────────────────────────────────────────────────── */

function pinLines(pkg) {
  const sha = pkg.baseline?.sha256;
  return [
    '---',
    '',
    sha
      ? `Drawn against the published archive file for ${pkg.baseline?.week ?? 'this week'}, ` +
        `pinned by \`sha256:${sha}\`${pkg.baseline?.source ? ` (${pkg.baseline.source})` : ''}. ` +
        'A proposal that does not pin its baseline cannot be reproduced.'
      : 'The baseline archive file for this week carries no published checksum, so the ' +
        'exact bytes this edit was drawn against are unpinned.',
    '',
  ];
}

function authorLine(author) {
  if (!author) return '(not recorded)';
  const bits = [author.name, author.affiliation].filter((s) => typeof s === 'string' && s.trim());
  let who = bits.length ? bits.join(', ') : '(not recorded)';
  /* `onBehalfOf` (WP-D): an author speaking for a body rather than only for
     themselves — a drought task force, a tribal water board. Parenthetical
     and last, before the email, so the line still reads as "who" first and
     "on whose behalf" second rather than the other way round. */
  if (typeof author.onBehalfOf === 'string' && author.onBehalfOf.trim()) {
    who += ` (on behalf of ${author.onBehalfOf.trim()})`;
  }
  return author.email ? `${who} <${author.email}>` : who;
}

function feature(geometry, properties) {
  return { type: 'Feature', properties, geometry };
}

/**
 * "A new D3 area appeared. D1's edge advanced." — one sentence per class that
 * moved under a patch, in `categoryPhrase`'s vocabulary. `null` for a patch
 * with no classes recorded, which RFC 7946 allows a property to be but an
 * empty string would read as "there is a description and it is blank".
 */
function describeChange(classes) {
  const list = asArray(classes).filter((c) => c && typeof c.class === 'string');
  if (!list.length) return null;
  return list.map((c) => capitalize(`${c.phrase ?? `${c.class} changed`}.`)).join(' ');
}

function capitalize(s) {
  return typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * A MultiLineString of one string is a LineString.
 *
 * Not pedantry: a single-part MultiLineString is legal and every reader
 * accepts it, but a GIS shows it as a multipart feature and a person then has
 * to explain why one stretch of border is "multi". The rest of this app
 * normalizes UPWARD to Multi (`asMulti`, for the read-at-the-wrong-depth
 * hazard); this is the one place that goes the other way, because the output
 * is read by people rather than by boolean ops.
 */
function lineGeometry(segments) {
  if (!segments) return null;
  if (segments.type === 'LineString') {
    return segments.coordinates?.length ? segments : null;
  }
  if (segments.type !== 'MultiLineString') return null;
  const strings = asArray(segments.coordinates).filter((s) => Array.isArray(s) && s.length);
  if (!strings.length) return null;
  return strings.length === 1
    ? { type: 'LineString', coordinates: strings[0] }
    : { type: 'MultiLineString', coordinates: strings };
}

function asArray(x) { return Array.isArray(x) ? x : []; }

/** `borderNotes` must be an object to index by neighbour id — never an array
 *  (which would answer a numeric lookup with `undefined`, not throw) and never
 *  anything else a hand-edited or pre-WP-D file might carry there. */
function isPlainObject(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }

function joinStrings(list) {
  const xs = asArray(list).filter((v) => v != null && v !== '').map(String);
  return xs.length ? xs.join(';') : null;
}

function joinValues(list, key) {
  return joinStrings(asArray(list).map((c) => c?.[key]));
}

function joinLabels(list) {
  return joinStrings(asArray(list).map((c) => c?.label ?? USDM_LABELS[c?.class] ?? null));
}

function numberOrNull(n) { return Number.isFinite(n) ? n : null; }

function round(n, digits) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/* The brief is read by people, so it speaks in miles; the package beside it
   keeps km² under keys that say so (js/units.js header). */
function km(n) {
  return Number.isFinite(n) ? `${fmtMi(n)} mi` : 'not measured';
}

function km2(n) {
  return Number.isFinite(n) ? `${fmtMi2(n)} ${MI2}` : 'not measured';
}

function compareStrings(a, b) { return String(a).localeCompare(String(b)); }
