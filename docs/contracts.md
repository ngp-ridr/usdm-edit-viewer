# Contracts

**The interfaces every module of this app is written against.** Five work
packages build this app in parallel against nothing but this file, so it is the
one document that is normative rather than descriptive: if the code and this
file disagree, one of them is a bug, and which one is a conversation.

Written in WP-0/WP-A and **frozen** before the parallel packages started. A
change here after the freeze needs saying out loud to every package that reads
the changed section — the sections are labelled with their owners for exactly
that.

Where the approved plan left a detail open, WP-A decided it and recorded the
decision in [§ 16, Decisions WP-A made](#16-decisions-wp-a-made). Those are as
binding as the rest.

| § | what | owner |
|---|---|---|
| 1 | [Vocabulary](#1-vocabulary) | shared |
| 2 | [`Proposal` — js/proposal.js](#2-proposal--jsproposaljs) | WP-E |
| 3 | [`Session` — js/session.js](#3-session--jssessionjs) | WP-E |
| 4 | [`Region` — js/compare.js](#4-region--jscomparejs) | WP-E |
| 5 | [`Seam` — js/seams.js](#5-seam--jsseamsjs) | WP-E |
| 6 | [Published bands — js/published.js](#6-published-bands--jspublishedjs) | WP-E |
| 7 | [Briefs — js/brief.js](#7-briefs--jsbriefjs) | WP-E |
| 8 | [Finding ids](#8-finding-ids) | WP-E |
| 9 | [Intake — js/load.js, js/bands.js](#9-intake--jsloadjs-jsbandsjs) | WP-B |
| 10 | [Map — js/map.js, js/marks.js](#10-map--jsmapjs-jsmarksjs) | WP-C |
| 11 | [Panels, cards, recheck, export](#11-panels-cards-recheck-export) | WP-D |
| 12 | [App state and `ctx`](#12-app-state-and-ctx) | WP-B (app.js) |
| 13 | [The DOM contract: element ids and classes](#13-the-dom-contract-element-ids-and-classes) | WP-A |
| 14 | [URL grammar](#14-url-grammar) | WP-B |
| 15 | [Sentences](#15-sentences) | shared |
| 16 | [Decisions WP-A made](#16-decisions-wp-a-made) | WP-A |

House rules that are NOT restated here (they are in `CLAUDE.md` and they still
apply to every line of this app): no inline `style` attributes anywhere; the
USDM ramps are data and live in `js/color.js`; miles on screen, metric in the
JSON; one toast per turn; `function` declarations for anything a constructor
might reach; never a naked `turf.intersect`.

---

## 1. Vocabulary

```js
const LEVELS = ['none', 'D0', 'D1', 'D2', 'D3', 'D4'];   // js/proposal.js
const ord = (level) => LEVELS.indexOf(level) - 1;        // none = -1 … D4 = 4
```

`ord` is the ONE ordinal scale in this app. It is the scale `js/delta.js` already
uses (`deriveChangeMap` labels six states none = −1 … D4 = 4), so a signed step
computed here and a `USDM_CHANGE_LABELS` lookup in the vendored copy agree by
construction. A level is always the STRING (`'D2'`); an ordinal is always the
number. Never pass one where the other is expected — `'none'` and `-1` are the
pair that catches this.

| term | means |
|---|---|
| **proposal** | one `usdm-edit-proposal/2` package, parsed — one author, one working area, one week |
| **patch** | one contiguous piece of ground a proposal moves: a row of `pkg.proposedChanges` |
| **change** | a patch, in the UI's wording (the editor calls them changes; `changeName` names them) |
| **region** | a piece of ground two proposals answer differently — a **finding** of kind `conflict` or `one-sided` |
| **seam** | a disjuncture along a shared AOI line — a **finding** of kind `seam` |
| **finding** | a region or a seam. Everything the app ranks, lists, cards, links to and writes a brief for |
| **ground** | the polygon a comparison is scoped to: an AOI, or the overlap of two |
| **pick** | the ONE proposal whose classes the Proposal view paints |
| **shown** | the proposals whose outlines draw and whose findings are not dimmed |
| **mark** | a proposal's letter (A, B, C…) plus its dash pattern (0–3) |

Areas are **km² in every object and every key in this file**, and miles
everywhere a person reads one — `fmtMi2`, `fmtMi2Fine`, `fmtMi` from
`vendor/usdm-editor/js/units.js`. A key named `areaKm2` carries km²; nothing in
this app ever prints it without conversion.

---

## 2. `Proposal` — js/proposal.js

DOM-free. Imports the vendored `topology.js`, `changeset.js`, `submit.js`,
`color.js`, `units.js` and nothing else. No `window`, `document` or `fetch`.

```js
import { parseProposal, ProposalError, LEVELS, ord,
         proposalKey, classAt, publishedClassAt, patchesTouching,
         checkIntegrity } from './proposal.js';
```

### `parseProposal(pkg, { fileName, sha256, source }) → Proposal`

Throws `ProposalError` (with a machine-readable `.reason` and a human `.message`
— the sentences are § 15) on: schema `usdm-edit-proposal/1`, an unknown schema,
a missing `aoi.geometry`, a missing `derivedBands`, a missing `baseline.week`.

The returned object is **frozen** and carries:

```js
{
  id,            // pkg.id
  shortId,       // id.slice(0, 8) — 12 on collision within a session (§ 8)
  key,           // `${aoi.id}@${week}#${shortId}` — proposalKey()
  created,       // ISO string
  fileName,      // as loaded, or null for ?load= / ?demo
  source,        // the url it came from, or null
  sha256,        // of the file's bytes, or null when unknown
  week,          // pkg.baseline.week — 'YYYY-MM-DD'
  nesting,       // pkg.baseline.nesting ?? null
  aoi,           // { kind, id, name, bbox, geometry }  — geometry as MultiPolygon
  author,        // { name, email, affiliation, role, onBehalfOf }
  bands,         // { D0..D4: MultiPolygon|null } — derivedBands through asMulti()
  changedRegion, // MultiPolygon|null
  patches,       // [{ key, id, seq, name, geometry, anchor, bbox, areaKm2,
                 //    classes[], rationale, groupId, reviewed, annotated }]
                 //   key === id; `geometry` is the Polygon as published
  edgeEffects,   // pkg.edgeEffects ?? []
  justification, // { format, rationale, impacts, evidence[], borderNotes{} }
  edgeBrief,     // pkg.edgeBrief ?? null
  changes,       // [{ class, before, after, areaKm2, parts }] — before/after are
                 //   CUMULATIVE CONTOURS, dropped once `published` is memoized
  validationPassed,  // pkg.validation?.passed === true
  warningCount,      // pkg.warnings?.length ?? 0
}
```

**Dropped on parse:** `heuristic.samples`, `reproduce`, `priorWeek`, `app`. The
ten example packages are 11 MiB of JSON and `changes[].before/after` dominate;
painting needs only `bands`, `patches`, `aoi.geometry` and
`edgeEffects[].segments`.

**Memoized lazily** (built on first read, never in `parseProposal`):

- `published` → `{ contours, bands }`. Reconstructed FROM THE PACKAGE ALONE:
  `contours[c] = changes.find(c)?.before ?? deriveContours(bands)[c]`, then
  `deriveBands`. Sound because `changes[]` names every class a verb or the
  cascade touched. Measured: the two packages of every state agree to 0.0000 km²
  per class. **No network is needed for within-AOI comparison.**
- `partition` → six prepared levels of the RESULT:
  `[{ level, parts: indexParts(g), bbox }]`, with
  `none = aoi ∖ deriveContours(bands).D0`. The `partitionOf`/`prepare` pattern
  from the vendored `js/delta.js` (lines 163–234), with the level labels kept.
- `publishedPartition` → the same over `published.bands`.
- `bandIndex` / `publishedBandIndex` → `indexParts` per level, for `classAt`.
- `integrity` → `checkIntegrity(p)` (below).

### Point queries

```js
classAt(p, [lng, lat]) → 'none' | 'D0'…'D4' | null
publishedClassAt(p, [lng, lat]) → same
```

Severest class first — the severest class at a point is the smallest ring — over
`bandIndex`, bbox test then point-in-polygon. `'none'` means inside the AOI with
no band; `null` means **outside the AOI**, which is a different answer and callers
must not collapse the two.

```js
patchesTouching(p, geometry, bbox) → patch[]
```

Anchor-in-piece first (cheap and usually right), then bbox overlap +
`booleanIntersects`. Used to attribute a region to the patches that produced it.

### `checkIntegrity(p) → { grade, problems[], largestKm2, escapedKm2 }`

Re-runs `verifyPackage`'s mutual-containment loop (vendored
`js/submit.js:693–702`) and **grades by magnitude**:

| escaped area | mean width | grade |
|---|---|---|
| ≤ `CONTAINMENT_TOLERANCE_M2` (100 m²) | — | ignored, not a problem |
| ≤ 1 km² | ≤ 50 m (`RESIDUE_WIDTH_M`) | `'residue'` |
| anything else | | `'defect'` |

`meanWidthM = 2 · area / perimeter`, the same two-channel test the vendored
`validateDerivedBands` uses for band overlap.

This grading is not a nicety: **8 of the 10 example packages fail
`verifyPackage`'s containment rule outright**, every failure 0–0.4 mi², because
`deriveBands` drops clipper residue under `MIN_PART_AREA_M2` that the
`deriveContours` round trip cannot restore. Worst measured residue: 0.984 km² at
9.1 m mean width. A tool that told a reviewer eight of ten reference proposals
were "hand-edited or produced by a different version" would be worse than no
tool. Only a `'defect'` shows the verifier's own sentence.

`verifyPackage` is also run for its NON-containment problems (it imports cleanly
under Node — `dom.js` touches `document` only inside functions).

---

## 3. `Session` — js/session.js

DOM-free. Imports `proposal.js` and `compare.js`.

```js
createSession() → {
  add(pkg, { fileName, sha256, source }) → { proposal, warnings[] },  // throws SessionError
  remove(id) → boolean,
  list() → Proposal[],            // load order — the order that assigns letters
  byId(id) → Proposal | null,
  byAOI() → Map<aoiId, Proposal[]>,
  week() → 'YYYY-MM-DD' | null,   // null while empty
  groups() → Group[],
  size,                           // number
}
```

`add` rules, in order:

1. **A different week is REFUSED** with a `SessionError` naming both weeks
   (§ 15). The session is one week by definition.
2. Same week, different `baseline.sha256` → **accepted**, with one
   `reissuedBaseline` warning.
3. A duplicate `pkg.id` → one proposal; the second `add` returns the existing one
   with an `alreadyLoaded` warning and changes nothing.

`groups()` returns the pairs worth comparing:

```js
Group { id, aoiIds[], ground /* MultiPolygon */, proposals: Proposal[] }
```

- same `aoi.id` → one group, `ground` = the AOI geometry;
- different ids with overlapping bboxes → `intersectNear`, kept only when
  ≥ 1 km². **Below that they share a LINE, not ground** — that is the seam
  engine's business and this must not double-report it.
- cross-kind (a tribal area lying inside a state) falls out of this rule with
  nothing special written for it.

---

## 4. `Region` — js/compare.js

DOM-free.

```js
compareProposals(A, B, { ground, minAreaM2 = MIN_PATCH_AREA_M2 })
  → { pair: [A.id, B.id], ground, regions: Region[], totals, ms }
compareGroup(proposals, { ground }) → Comparison[]   // all C(n,2) pairs
```

```js
totals = { conflictKm2, oneSidedKm2: { A, B }, publishedMismatchKm2 }
```

```js
Region {
  id,            // 'disc:<8 hex>' — § 8
  key,           // the canonical string that was hashed (tests assert on this)
  kind,          // 'conflict' | 'one-sided'
  changedBy,     // 'A' | 'B' | 'both'   — 'both' only for a conflict
  proposalA, proposalB,      // proposal ids; A is the earlier-loaded one
  classA, classB,            // 'none' | 'D0'…'D4' — the RESULTING class each side proposes
  published,                 // the published level under this ground
  magnitude,                 // |ord(classA) − ord(classB)| — ≥ 1 by construction
  directionA, directionB,    // 'grew' | 'shrank' | 'unchanged'  (vs published)
  geometry,      // MultiPolygon
  bbox, areaKm2, anchor,     // anchor is an interior point, never a centroid
  patchesA, patchesB,        // patch keys, from patchesTouching
  aoiId,                     // the AOI the ground belongs to (the group's first)
}
```

### The algorithm (exact polygons, never a naked intersect)

1. Partitions `PA`, `PB`, `PP` (= `A.publishedPartition`), clipped to `ground`
   with `clipToExtent` when the pair is cross-AOI.
2. For every `i ≠ j`: `intersectLevels(PA[i], PB[j])` — a copy of `delta.js`'s
   two-sided bbox-pruned intersect — yielding pieces labelled `(classA, classB)`,
   disjoint by construction. Then `despike` (the nested product's contours leave
   zero-width needles along shared edges — the vendored `topology.js` header has
   the measurement), then drop parts under `minAreaM2`.
3. Label each piece with the published level `p` by intersecting `PP[k]`:
   - `p ∉ {a, b}` → **conflict**;
   - `b === p` → **one-sided, changed by A**;
   - `a === p` → one-sided, changed by B;
   - a piece outside BOTH `changedRegion`s → `publishedMismatchKm2` (the two
     baselines differ; for one `sha256` this is residue only, and it is reported
     as a total, never as a finding).
4. Dissolve equal `(a, b, p)` labels with ONE union, split into connected
   components, one `Region` each.
5. **Rank**: kind (conflict first) → `magnitude` descending → `areaKm2`
   descending → `id` ascending. The last term makes the order total, so two runs
   over the same input produce the same list.

Measured budget (planning prototype, vendored turf under Node): a full state pair
is partition ×3 (139 ms) + 30 level-pair intersections (162 ms, 65 pieces) +
published labelling (186 ms) ≈ 0.7 s; five pairs ≈ 3.5 s. WP-B ticks between
AOIs with `setTimeout(0)` so the main thread is not held for the whole sweep.

`compareProposals(A, B)` and `compareProposals(B, A)` produce the same `Region`
ids. (The key string sorts its two sides.)

---

## 5. `Seam` — js/seams.js

DOM-free.

```js
const SEAM_SPACING_KM = 2;      // sample every 2 km along the line
const SEAM_OFFSET_KM = 1;       // 1 km inland each side
const SEAM_TOLERANCE_KM = 0.05; // = the editor's EDGE_TOLERANCE_KM

sharedLine(aoiA, aoiB) → MultiLineString | null
analyseSeam(sideA, sideB, line, { provider }) → Seam | null
findSeams(session, { provider, neighbors }) → Promise<Seam[]>
```

`sharedLine` bbox-clips both rings to the padded bbox overlap, `polygonToLine`s
them, and `lineOverlap`s at `SEAM_TOLERANCE_KM`. TopoJSON shared arcs coincide
exactly, so this is exact and cheap: the SD/NE line is 489 km in 14 ms. **Clip
with `envelopeOf(indexParts(aoi))`, not `aoi.bbox`** — the Alaska rule.

A **side**:

```js
Side { kind: 'proposal' | 'published' | 'unknown', proposal?, aoi, bandIndex, publishedBandIndex }
```

Candidate seams are enumerated per AOI × neighbour id, from
`vendor/aoi/neighbors.json` (fetched at boot by app.js, `optional` — a failure
costs neighbour enumeration, not the app) plus every loaded
`edgeEffects[].neighborIds`. Then:

- **both sides loaded** → one analysis per proposal pair across the line, over
  `sharedLine`;
- **neighbour not loaded** → the line is the loaded side's
  `edgeEffects[].segments` toward that neighbour. *Nothing new at the line
  without edge effects means no seam* — an unloaded neighbour is not by itself a
  disjuncture. The far side is `published` via the provider (§ 6), or `unknown`
  offline.
- `aiannh:` neighbours are handled identically. Only where the tribal ring is
  also a state line (`neighbors.json`'s `cross`) does a cross-kind seam exist.

`sampleSeam` walks each line string every `SEAM_SPACING_KM`, offsetting
±`SEAM_OFFSET_KM` perpendicular. The point inside A's AOI is side A; if both or
neither, retry at 0.5 km, then mark the sample `indeterminate`. **An
indeterminate sample splits a run and is never bridged.** Each sample carries
`classA, classB, publishedA, publishedB`.

Sampling rather than exact buffers is a deliberate choice with a measurement
behind it: 0 indeterminate samples at 1 km over the SD/NE line (which clears
both the FSA boundary's ~40 m zigzag and the editor's 0.5 km
`NEIGHBOR_BUFFER_KM`), whole-mile reporting, and no boolean ops at all.

```js
Run {
  classA, classB, publishedA, publishedB,
  step,            // ord(classB) − ord(classA)
  publishedStep,   // ord(publishedB) − ord(publishedA)
  kind,            // 'agree' | 'new' | 'widened' | 'pre-existing' | 'narrowed'
  lengthKm, from, to, midpoint,
  changedBy,       // 'A' | 'B' | 'both' | 'neither'
}
```

- `step === 0` with a change on either side → `agree`;
- else `publishedStep === 0` → **`new`** (a seam the published map did not have);
- `|step| > |publishedStep|` → **`widened`**;
- equal → `pre-existing` — kept in `runs`, **excluded from findings**;
- smaller → `narrowed`.

```js
Seam {
  id,            // 'seam:<8 hex>' — § 8
  key,           // the canonical string that was hashed
  kind: 'seam',
  sideA, sideB, neighbourId,
  runs: Run[], lengthKm, newStepKm, maxStep,
  reciprocal,    // true when BOTH sides carry a proposal
  isNew,         // any run of kind 'new'
  edgeEffects,   // the matching edgeEffects rows from either side
  borderNotes,   // { A: md|null, B: md|null }
  anchor,        // the midpoint of the longest non-'agree' run
  aoiIds: [aoiA, aoiB],
}
```

Rank: reciprocal-with-disagreement first → `maxStep` descending → `newStepKm`
descending → `id`.

---

## 6. Published bands — js/published.js

**The one engine-adjacent module allowed `fetch`** — and it is allowed because
everything else in the engine must run under Node with no network.

```js
createPublishedProvider({ fetchWeek }) → {
  bandsNear(week, bbox) → Promise<{ D0..D4 }>,   // rejects → the caller marks the side 'unknown'
  status(),                                      // { weeks: string[], inFlight: number }
}
```

`fetchWeek` comes from the vendored `js/archive.js`. One fetch per week
(in-flight promise cache, **evicted on rejection** so a retry is possible), then
`deriveBands(clipToExtent(indexParts(contour), paddedBbox))`, cached by
`week|bbox@0.01°`.

A rejection is never fatal: the seam is still emitted, with the side marked
`unknown` and the sentence in § 15. Node tests back `fetchWeek` with
`tools/.cache/parquet_unclipped/USDM_<week>.parquet` and **skip** when it is
absent.

---

## 7. Briefs — js/brief.js

DOM-free and turf-free. Imports only `color.js`, `units.js` and `changes.js`'s
`prose`. **Deterministic output**: the same session produces byte-identical
markdown twice.

```js
buildRegionBrief(region, comparison, { viewerUrl }) → string
buildSeamBrief(seam, { viewerUrl }) → string
buildSessionBrief(session, comparisons, seams) → string
```

House style is the vendored `buildEdgeBrief` (`js/geojson.js:207`): an H1 naming
the place and the week, the disclaimer, bullet metadata, `##` per party, pin
lines (sha256, source url). **Miles via `fmtMi2`/`fmtMi`/`MI2`; metric is never
printed.**

A region brief carries, in order: the ground (mi², bbox, anchor, the nearest
patch names each side, `[Open in the viewer](<viewerUrl>?focus=<id>)`); what the
published map had; **Side A** and **Side B** — author block with email, the
resulting class with its ordinal and the `USDM_CHANGE_LABELS` step from
published, each touching patch's name, `prose` phrases, mi² and **rationale in
full**, the narrative paragraphs that name the class or the patch's places (the
whole narrative when none do), the evidence list, and `borderNotes` when the
region touches the ring; the disagreement stated in ordinals; and **3–5 questions
chosen by case** (opposite directions / same direction / one-sided / the two
sides citing the same evidence host / an integrity note).

A seam brief carries the line, a run table in miles, both sides (or "no proposal
loaded — the published week" / "could not be loaded"), the disjuncture sentence,
and case questions — a 2-class step at a jurisdiction line "is almost never
physical".

A session brief is a header table of proposals and authors, an integrity table,
the ranked index of regions and seams, a **"Not compared"** section (refused
weeks, unloaded neighbours, unknown sides), then every individual brief under
`---`.

---

## 8. Finding ids

Every finding carries a **deterministic** `id`, because `?focus=` in a brief must
reopen the same finding after a reload, in another browser, with the files loaded
in a different order.

```
id      ::= 'disc:' hex8 | 'seam:' hex8
hex8    ::= eight lowercase hex digits — FNV-1a (32-bit) over `key`
```

| finding | `key`, the string that is hashed |
|---|---|
| region | `disc\|<kind>\|<aoiId>\|<lo>\|<hi>\|<published>\|<bbox@1e-3>` |
| seam | `seam\|<aoiIdLo>\|<aoiIdHi>\|<propLo>\|<propHi>\|<n>` |

- `<lo>`/`<hi>` are the pair's two resulting classes **sorted**, so argument
  order cannot change the id;
- `<bbox@1e-3>` is the four bbox numbers rounded to 3 decimals and joined with
  `,` — a thousandth of a degree is ~100 m, far below the smallest region kept
  and far above float noise;
- `<propLo>`/`<propHi>` are the two sides' `shortId`s sorted, or the literal
  `pub` for a published side and `unk` for an unknown one;
- `<n>` is the seam's index among that pair's seams, in rank order.

Every finding also carries its `key` verbatim, so a test can assert on the
readable string rather than the hash.

**Collisions.** FNV-1a over 8 hex is not collision-proof and this app has no
central registry. So the SESSION resolves them: when two findings hash equal,
the second in rank order gets `-2` appended (`disc:1a2b3c4d-2`), the third `-3`.
Deterministic because the rank is total (§ 4, § 5). The same rule gives a
proposal's `shortId` 12 hex instead of 8 when two `pkg.id`s share their first 8.

`?focus=<id>` accepts the id verbatim. An id that names nothing in the session is
not an error: the app says so once (§ 15) and opens the default view.

---

## 9. Intake — js/load.js, js/bands.js

### js/load.js

```js
createLoader({ session, say, live, note, onLoaded }) → {
  fromFiles(FileList|File[]) → Promise<LoadReport>,
  fromUrls(string[]) → Promise<LoadReport>,
  fromDemo() → Promise<LoadReport>,
  attachDropTarget(element) → () => void,   // returns an unsubscribe
}

LoadReport { loaded: Proposal[], problems: [{ name, reason, sentence }], warnings: string[] }
```

Bytes → package: magic-byte gunzip through the vendored `js/gzip.js`
(`looksLikeGzip` / `gunzipText`), exactly as the editor's `wizard.js`
`readChosenText` does, then `JSON.parse`, then `parseProposal`.

`say` is the ONE toast seam (a singleton — one sentence per turn, and a load that
also warns sends ONE sentence). `note` writes `#app-note`; the full problem list
goes there with `is-error`, never as a second toast. Progress goes to the live
region only.

**`?load=` origin check happens BEFORE the fetch.** The origin must be
`location.origin` or `https://data.sustainable-fsa.com`; anything else is refused
with a sentence. A CSP block is silent, so an unchecked fetch to a third origin
looks exactly like a network failure. A new allowed origin is a CSP edit plus a
verify § 1 edit, never a silent addition.

### js/bands.js

The published week, and the hole the picked proposal's AOI punches in it.

```js
createBandProvider({ fetchWeek }) → {
  weekBands(week) → Promise<{ D0..D4 }>,        // national, one deriveBands per week
  punched(week, aoi) → Promise<{ D0..D4 }>,     // cached on (week, aoi.id)
  lastPunchMs,
}
```

`punched` is the editor's `app.js:616–632` — twelve lines — as a wrapper, not an
edit to the copy. It is **418–572 ms** and is cached on `(week, AOI)`; a
recompute per interaction is the regression this number exists to catch.

---

## 10. Map — js/map.js, js/marks.js

### js/marks.js (DOM-free, pure)

```js
assignMarks(proposals) → Map<proposalId, Mark>
Mark { letter, dash, dasharray, proposalId, aoiId, repeated }
```

- **Letters** A, B, C… in **load order**, across the whole session (they are the
  text twin of the dash and must be unique on screen).
- **Dash index 0–3 cycles WITHIN an AOI** — proposals in different AOIs never
  overlap, so the pattern only has to separate proposals that can.

| dash | `line-dasharray` | width |
|---|---|---|
| 0 | solid (no dasharray) | 1.6 |
| 1 | `[2, 1.5]` | 1.6 |
| 2 | `[0.2, 1.6]`, round caps | 1.6 |
| 3 | `[2.5, 1.2, 0.4, 1.2]` | 1.6 |

A **fifth** proposal in one AOI repeats pattern 0 with `repeated: true`; the
letter carries the distinction and the app toasts once. The legend swatch is a
CSS `border-top-style` (`solid` / `dashed` / `dotted` / `double`), never a
picture of the line.

### js/map.js

```js
createMapView(map, { layers /* createLayerStack(map) */ }) → {
  ready,                       // Promise — resolves after addAll()
  setPublished(bands),         // { D0..D4 } into the `usdm` source
  setPick(proposal | null),    // feeds `usdm-edit`; null clears it
  setShown(proposalIds),       // which patch outlines draw
  setFindings(regions),
  setSeams(seams),
  setPatches(patches),         // [{ proposalId, key, seq, mark, letter, geometry, anchor }]
  setView('proposal' | 'published' | 'differences'),
  highlight(selection | null), // { kind, id } — drives the three `*-active` filters
  focus(target),               // a finding, a patch, an AOI or a bbox; fits with card-clearing padding
  hitTest([lng, lat]) → Selection | null,
  restyleForTheme(),
}
```

**`hitTest` reads SOURCE data, never `queryRenderedFeatures`** — that call is
blind to holes (every ring reports a hit independently) and returns
tile-simplified geometry. bbox + point-in-polygon for areas; seams by
`pointToLineDistance` within ~6 px at the current zoom. Resolution order:
**conflict > one-sided > seam > change**, and a miss returns `null`, which the
app answers with "Nothing proposed here." — a click that silently does nothing is
indistinguishable from a broken map.

**Sources** (ids fixed by the vendored `js/layers.js`): `usdm` (the published
week, punched by the picked proposal's AOI), `usdm-edit` (the picked proposal's
`derivedBands`), `aoi` / `aoi-mask` (fed the UNION of every loaded AOI, so the
mask dims the world outside the set and `aoi-line` draws every loaded boundary),
`boundaries`, `county-tiles`, `tribal-boundaries`. `usdm-changes`, `usdm-delta`
and the `band-*` sources stay empty in this app, and `js/map.js` says so in a
comment — they are the editor's, and an empty source is cheaper than a fork.

**Viewer sources:**

| source | feature properties |
|---|---|
| `findings` | `{ id, kind, delta, magnitude, areaKm2, aoiId }` |
| `seams` | `{ id, kind, isNew, step, lengthKm }` |
| `patches` | `{ proposalId, key, seq, mark, letter }` |
| `anchors` | `{ letter }` (points) |

**The ladder**, bottom to top:

```
ground · hillshade · usdm-fill/line-* · usdm-edit-fill/line-*
findings-fill                    (before hillshade-over; Differences only)
hillshade-over · water · aoi-dim · boundaries · aoi-line-casing · aoi-line
  ── everything below is inserted before the first raised place_*/watername_*
patches-casing · patches-line-0 … patches-line-3
findings-line-onesided · findings-line-conflict
seams-casing · seams-line
patches-line-active · findings-line-active · seams-line-active
anchors-label                    (symbol: the letter, 11 px, --text-primary, white halo)
  ── place labels
```

Four `patches-line-*` layers filtered on `mark`, because **`line-dasharray` is
not data-driven** in MapLibre.

**The marks table** — every pair differs on at least two axes:

| mark | colour | shape | means |
|---|---|---|---|
| `patches-line-0..3` | `--text-primary` | the proposal's dash, 1.6 px, over a casing | a proposal's own patch |
| `findings-line-conflict` | `--text-primary` | solid 2.2 px | two proposals disagree here |
| `findings-line-onesided` | `--text-primary` | dashed `[2, 1.5]` 2.2 px | one changed it, one did not |
| `seams-line` (reciprocal) | `--map-reach-line` | solid 3 px | a disjuncture, both sides proposed |
| `seams-line` (one-sided) | `--map-reach-line` | dashed `[1.5, 1]` 3 px | a disjuncture, one side |
| `seams-casing` (`isNew`) | white | 5 px under the line | the published map did not have this seam |
| `*-active` | `--selection-ring` | dashed `[1.4, 1]` 6 px | the thing you pointed at |

`findings-fill` is the **change ramp** keyed to the signed step from the published
class to the side departing furthest — `USDM_CHANGE_COLORS` from the vendored
`js/color.js`, at opacity 1.0, and visible in the Differences view alone.

`anchors-label` is **a deliberate second symbol over the classes** and the one
documented exception in this app: a glyph replaces pixels rather than blending
them, and the letter is the text twin of the dash. Recorded in `CLAUDE.md`.

### The three views

| view | `setMapView` | class fills | proposal | findings | patches | seams |
|---|---|---|---|---|---|---|
| `proposal` | `'proposal'` | published, punched | picked proposal's bands | conflicts only | on | on |
| `published` | `'published'` | published, UNpunched | none | conflicts only | on | on |
| `differences` | `'changes'` | hidden | — | `findings-fill` + both outlines | **off** | on |

`setMapView` takes `'changes'` — not `'change'`.

---

## 11. Panels, cards, recheck, export

### js/panels.js

```js
createPanels(els, ctx) → {
  renderSession(summary),        // #session-line
  renderProposals(proposals),    // #proposal-list, grouped by working area
  renderFindings(findings),      // #findings-section
  renderLegend(view),            // #legend-section
  setStatus(sentence),           // #findings-status, role=status
}
```

Everything is built with `el()` from the vendored `js/dom.js` — **which throws on
a `style` attribute**, and that is the point. Swatch colours are CSSOM writes
(`el.style.background`), the way the editor's legend does it. **Never call the
kit's `vendor/style/ui/legend.js`: it writes inline `style` attributes**, which
this page's CSP drops, and the legend renders unstyled.

A proposal row: a checkbox (`id="show-<shortId>"`) whose `<label for>` carries
`.mark-swatch.mark-N` + the letter + the author; a `.proposal-meta` line
("Tribal government · … · 3 changes · D D D"); a `.recheck-line`; a `Details`
button. **Hiding a proposal hides its outlines and DIMS its findings — it never
changes the answer.**

The findings list is three `<details open>` (Conflicts, One-sided, Seams), each
an `<ol>` of `<button class="finding-row" data-finding-id="…">` with three lines:
where, what, size. Arrow keys rove within a group; Enter opens.
**This list is the text twin of the map** and the count is mirrored in
`#findings-status`.

### js/cards.js

```js
createCards(els, ctx) → { showProposal(p), showChange(p, patchKey), showFinding(f), showSeam(s) }
```

Prose goes through the vendored `renderMarkdown` (`js/mdtext.js`) — a sanitized
`DocumentFragment`; Squire is lazy and `.catch`-guarded and a read-only render
never loads it. Evidence rows are `{url, label}` (anchors, `rel="noopener"`) or
`{image, label}` (**gated by `isImageDataURL`** — `data:` only, never `https:`).

Card titles: `"B · Dana Reyes"` · `"Change 2 · B · Reyes"` ·
`"Conflict · Montana"` · `"Seam · South Dakota / Nebraska"`.

A finding card's body is the `.side-by-side` grid: per side the letter, author,
role, "proposes **D2 · Severe Drought**", the patches with rationales rendered,
and Zoom. For a one-sided finding the other column reads "Left as published — D1
· \<author\> did not propose a change here". Then **Questions for discussion**
from `brief.js`, then `#brief-download` and `#brief-copy`.

The card opens with focus and Escape returns focus to the opener (the kit's
`initDetailCard` handles Escape). There is **no hover tooltip**.

### js/recheck.js (DOM-free)

```js
recheckPackage(pkg) → { grade: 'pass'|'residue'|'defect', problems: [], largestKm2, sentence }
```

A thin wrapper over `checkIntegrity` (§ 2) plus `verifyPackage`'s non-containment
problems. `sentence` is the author-facing line (§ 15) — and for `residue` it says
"agrees to within N mi² along shared edges", never "hand-edited".

### js/export.js

```js
{
  downloadBrief(finding, { viewerUrl }),      // saveFile() from the vendored js/dom.js
  copyBrief(finding, { viewerUrl }),          // clipboard, then ONE toast
  downloadSessionBrief(),
  briefFilename(finding) → string,            // 'usdm-brief-2026-09-08-MT-conflict-1a2b3c4d.md'
  linkTo(finding) → string,                   // absolute url with ?focus=
}
```

---

## 12. App state and `ctx`

`js/app.js` owns the state and hands every other module the **same frozen `ctx`
of getters** — never the state object, and never a closure variable (the editor
learned that one the hard way: its justification lived in a modal's closure and
vanished on reload while the geometry restored).

```js
ctx = Object.freeze({
  get session(),                 // the Session
  get proposals(),               // session.list()
  get week(),
  get marks(),                   // Map<proposalId, Mark>
  get findings(),                // the ranked Region[] ++ Seam[]
  get comparisons(),             // Comparison[]
  get seams(),                   // Seam[]
  get view(),                    // 'proposal' | 'published' | 'differences'
  get pick(),                    // Proposal | null
  get shown(),                   // Set<proposalId>
  get selection(),               // { kind, id } | null
  get viewerUrl(),               // location.origin + location.pathname

  setView(v), setPick(id), setShown(ids), select(sel | null),
  focus(target),
  say(sentence),                 // ONE toast (the kit's showToast is a singleton)
  live(sentence),                // the polite live region
  note(sentence, { error }),     // #app-note
  markFor(proposalId), proposalById(id), findingById(id),
  brief(finding) → string,
})
```

The verification hook, for `tools/verify.mjs` and nothing else:

```js
window.__viewer = Object.freeze({
  get booted(),       // boot() ran all the way to the end
  get session(),
  get findings(),
  get seams(),
  get view(),
  ctx: () => ctx,
  get lastCompareMs(), get lastPunchMs(),
})
```

Exposed unconditionally, for the editor's reason: a debug path that only exists
under test is a debug path nobody has tested, and this app has no credentials and
no state that is not already in the URL.

---

## 13. The DOM contract: element ids and classes

`index.html` is WP-A's. Every id below **exists in the markup** before any other
package runs; a package that needs a new one asks rather than creating it, so the
html-validate and axe gates stay green.

### Navbar — utilities only

| id | what |
|---|---|
| `#btn-drawer` | the kit's drawer toggle |
| `#btn-load` | "Load proposal files" |
| `#load-file-input` | hidden `<input type="file" multiple accept=".json,.gz,application/json,application/gzip">` |
| `#btn-demo` | "Load the bundled demo set" |
| `#btn-briefs` | "Export briefs — every finding as markdown", `disabled` until findings exist |
| `#btn-info` | About |

No Share button: **the address bar is the share**.

### Drawer, in order

| id | what |
|---|---|
| `#session-line` | "Week 2026-09-08 · 12 proposals over 5 working areas · 3 conflicts, 41 one-sided, 4 seams" |
| `#map-view-section` / `#map-view-controls` | `role="group"`, `aria-label="Map view"` |
| `#view-proposal` `#view-published` `#view-differences` | `.seg-btns`, `aria-pressed` |
| `#pick-row` / `#pick-select` | "Whose classes to paint" — proposal view only; a real `<label for>` |
| `#proposal-section` / `#proposal-list` | grouped by working area (`h3` + count) |
| `#findings-section` | |
| `#findings-status` | `role="status"` — the sentence, and the count mirrored |
| `#findings-conflicts` `#findings-onesided` `#findings-seams` | three `<details open>`, each an `<ol>` |
| `#legend-section` / `#legend-body` / `#legend-key` | hand-built |

### Map frame

| id | what |
|---|---|
| `#map-frame` | the drop target |
| `#map` | `role="application"` |
| `#app-note` | `role="status"`; `.is-error` for a failure |
| `#empty-state` | lede + `#empty-choose` + `#empty-demo` + "Drop files anywhere on the map" |
| `#drop-hint` | shown on dragenter |

### Card and dialogs

`#detail-card` (`.ridr-card.dock-right`, `role="dialog"`, `aria-modal="false"`),
`#card-title`, `#card-close`, `#card-content`; `#info-modal`, `#info-modal-title`,
`#info-body`, `#info-close`. Inside a finding card: `#brief-download`,
`#brief-copy`.

**`.ridr-modal` is a transparent positioning shell** — the visible panel is
`.info-modal-box` inside it. Omit the box and the text floats over the map. There
is one dialog (About) and `.ridr-modal.wide` does not exist here.

### Classes `css/app.css` reserves for the other packages

`.mark-swatch` + `.mark-0` … `.mark-3` (border-top-style solid / dashed / dotted
/ double) · `.proposal-group` `.proposal-row` `.proposal-meta` `.recheck-line`
`.recheck-line.is-defect` · `.finding-group` `.finding-row` `.finding-where`
`.finding-what` `.finding-size` `.finding-row.is-dimmed`
`.finding-row[aria-current="true"]` · `.legend-row` `.legend-swatch`
`.legend-swatch.is-unshaded` `.legend-marks` · `.side-by-side` `.side` `.side-head`
`.side-class` `.side-patch` · `.questions` · `.card-lede` `.card-block`
`.card-actions` · `.empty-state` `.drop-hint`.

### Accessibility invariants

- `createLiveRegion()` **once**; one sentence per event.
- `aria-pressed` on the three view segments and nowhere else.
- Real `<label for>` on every control that has a visible label.
- **No accessible name on one screen may contain another's** — navbar, drawer and
  the open card are swept together (the editor's § 9f rule).
- The findings list is the map's text twin; the canvas needs it, because a screen
  reader cannot see WebGL.

---

## 14. URL grammar

Read ONCE at boot. Precedence URL > default (this app stores nothing but the
drawer state). Every value re-validated on read. **A view at defaults emits no
query string**, camera included.

| param | values | notes |
|---|---|---|
| `?load=` | comma-separated urls | origin must be `location.origin` or `https://data.sustainable-fsa.com`, **checked before the fetch** |
| `?demo` | present | the bundled demo set |
| `?view=` | `published` \| `differences` | `proposal` is the default and emits nothing |
| `?pick=` | `<shortId>` | 8 hex of `pkg.id`, 12 on collision |
| `?show=` | comma-separated shortIds | emitted only when NOT all are shown |
| `?focus=` | a finding id (§ 8) | briefs link back through this |
| `?theme=` | `light` | high-contrast is the default; this is the only route back, and the anti-flash boot reads the URL and nothing else |
| `?drawer=` | `closed` | desktop only, and only when closed |

**The camera is ephemeral.** It fits the loaded AOIs, or the `?focus=` finding. A
shared link opens on the comparison, not on somebody's pan.

After a local-file load the session line says that a link will open empty —
**use Export briefs to share**. Local files cannot travel in a URL and pretending
otherwise is the failure mode worth a sentence.

---

## 15. Sentences

One toast per turn. The full list goes to `#app-note.is-error`; progress goes to
the live region only.

### Intake refusals (`ProposalError.reason` → sentence)

| reason | sentence |
|---|---|
| `notGzipOrJson` | "That file is neither JSON nor gzipped JSON." |
| `badJson` | "That file could not be read as JSON." |
| `notAProposal` | "That is not a USDM proposal file — it says `<schema>`." |
| `schemaV1` | "That is a version 1 proposal. Version 1 cannot be compared — open it in the editor and save it again." |
| `missingGeometry` | "That proposal carries no working-area geometry, so there is nothing to place it on." |
| `missingBands` | "That proposal carries no derived bands, so its classes cannot be drawn." |
| `missingWeek` | "That proposal does not say which week it was drawn against." |
| `tooLarge` | "That file is larger than this tool will open (\<n\> MB)." |

### Session refusals and warnings

| case | sentence |
|---|---|
| different week | "That proposal was drawn against \<other\>; this comparison is of \<week\> — load it in a session of its own." |
| duplicate id | "That proposal is already loaded." |
| reissued baseline | "\<Author\>'s proposal was drawn against a re-issued copy of the same week; it is loaded, and small differences along shared edges may be the baseline rather than the proposal." |
| unknown `?focus=` | "That link points at a finding this set does not contain." |
| refused `?load=` origin | "\<origin\> is not an origin this tool will fetch from." |

### Findings and sides

- "12 proposals loaded for the week of 2026-09-08. 3 conflicts, 41 one-sided
  differences and 4 seams found — conflicts are listed first."
- "Conflict near Big Sandy selected: D2 from Reyes against D1 from Teigen over
  184 square miles."
- Unknown far side: "The published week could not be read, so the other side of
  this seam is unknown."
- Unloaded neighbour: "No proposal is loaded for \<name\>, so the other side of
  this seam is the published week."

### Re-check grades

| grade | sentence |
|---|---|
| `pass` | "Re-check: the package's own geometry agrees with itself." |
| `residue` | "Re-check: agrees to within \<n\> mi² along shared edges — clipper residue, not an edit." |
| `defect` | "Re-check: \<n\> problems, largest \<n\> mi²." |

---

## 16. Decisions WP-A made

Where the plan left something open or said two things, this is the ruling.

1. **Finding ids are hashed on both sides** — `disc:<8 hex>` and `seam:<8 hex>`,
   each carrying its readable `key` (§ 8). The plan sketched seams as
   `s:<aoiA>:<aoiB>:<propA>:<propB|pub>:<n>`, but **AOI ids contain a colon**
   (`state:MT`, `aiannh:01263144-86`), so that grammar is ambiguous the moment it
   is parsed back out of `?focus=`. Hashing both kinds also keeps the URL short
   and makes the two prefixes the only thing a reader has to know.
2. **Collisions are resolved by the session, by rank**, with a `-2` / `-3` suffix
   (§ 8). The alternative — widening the hash — moves the problem rather than
   removing it, and the rank is already total.
3. **`shortId` is 8 hex, widened to 12 on collision within a session** — the same
   rule, applied to proposals, so `?pick=` and `?show=` cannot become ambiguous
   as a set grows.
4. **The engine's DOM-free set is `proposal.js session.js compare.js seams.js
   brief.js marks.js recheck.js`** — `marks.js` and `recheck.js` join the list the
   plan named, because both are pure and both are worth testing under Node. The
   grep test (`tools/compare.test.mjs` § 0, the editor's § 14h pattern) covers all
   seven. `published.js` is the one exception and is allowed `fetch` alone.
5. **`vendor/aoi/climdiv.json` is not copied.** The viewer resolves no climate
   division — a proposal names a state or a tribal area — and it is 392 KB.
   `sync-from-editor --check` treats it as allowed-absent.
6. **The demo set lives at `demo/` with an `index.json` of
   `{ week, files: [...] }`**, so `?demo` is one fetch then N, and the same index
   is what a test enumerates.
7. **`#pick-select` sits in its own `#pick-row`**, hidden with the row rather than
   with the control, so the label never survives its select.
8. **`.recheck-line` carries `.is-defect` only for a `defect`** — a `residue`
   grade is not a warning and must not be painted as one, or eight of the ten
   reference proposals read as broken.
9. **`css/app.css`'s kit-override count is 1** — the MapLibre attribution lift,
   inherited verbatim from the editor. `#detail-card`'s width is this app's own
   id and is placement, which the kit explicitly leaves to the app.
10. **The card is `min(28rem, 42vw)`**, wider than the editor's `min(26rem, 40vw)`,
    because a finding card is a two-column grid and 26rem collapses it.
