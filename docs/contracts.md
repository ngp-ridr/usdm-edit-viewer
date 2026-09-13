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

### The change map (WP-B)

```js
changeMap(p) → { deltas: {'-5'…'5'}, nonzero: string[] }   // memoized on p
worstDeltaFor(p, patch) → { delta, step, label } | null
```

NDMC's own ordinal arithmetic, through the vendored `js/delta.js`
(`deriveChangeMap` / `worstDeltaWithin`), so "a 2-class degradation" on a change
card is the same sentence the editor wrote. The working side is `p.contours` —
`deriveContours` over the shipped bands, which is what `changes[].after` carries
for an edited class and what the published contour is for an untouched one,
computed one way rather than stitched from two. **Lazy**: two partitions and
thirty intersections, and no card needs it until one is opened.

`Proposal.source` is the url the FILE was loaded from, or `null` for a picked or
dropped one. **Never `pkg.baseline.source`** — that is the archive parquet, it
stays under `baseline`, and the session line's "a link will open empty" sentence
reads this field.

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
under Node — `dom.js` touches `document` only inside functions). Since the
re-sync from editor `a6620a5` it returns `{ok, problems, residue, gates}` and has
applied the WIDTH channel itself, so a residue-scale escape arrives in `residue`
rather than `problems`; the area bar above is still applied here.

**COMPLETENESS IS PARTITIONED OUT, AND THE GRADE IS GEOMETRIC.** `verifyPackage`
also re-runs `validateJustification` over the finished package and pushes ITS
report into the same `problems` array. Those sentences are the editor's form
hints, addressed to an author standing in front of a form — "Say why this edit is
right — a reviewer cannot act on a blank.", "Your name travels with the
proposal." Passed through, a geometrically perfect package read "Re-check: 4
problems" and the card printed four imperatives at a reviewer who cannot act on
any of them. `js/recheck.js` makes the same `validateJustification` call itself,
takes those exact strings back out of `problems`, and reports them as two more
fields carried on both shapes:

| field | |
|---|---|
| `completeness: string[]` | the `validateJustification` keys that are missing — `rationale`, `author-name`, `author-email`, `author-role`, `evidence-<i>` |
| `completenessSentence: string` | ONE reader-facing sentence, or `''` — "This proposal carries no rationale and no author." The three author fields collapse to one phrase when all three are missing. |

Neither moves `grade` or `ok`: a proposal with no email re-derives exactly.
`tools/recheck.test.mjs` § 5 pins both halves with a stripped-justification
fixture.

**Where the bar lives (WP-D and WP-E, agreed):** § 11 calls `js/recheck.js` "a
thin wrapper over `checkIntegrity`" and it is written **the other way round** —
`recheckPackage` holds the one copy of the magnitude bar, the residue/defect
split and the sentence, and `checkIntegrity` is the § 2 façade over it. Two
copies of a measured threshold drift, and the one that drifts is always the one
nobody is looking at. The § 2 SHAPE above is unchanged; `recheckPackage`'s richer
fields (`residue`, `residueKm2`, `residueWidestM`, `ok`, `sentence`, `gates`) are
carried alongside rather than thrown away.

`heuristic` is kept on the Proposal minus its `samples` (WP-D): the card renders
the verdict's sentence and can zoom to its `geometry`, and the sample lattice is
the only part worth dropping.

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
groupPairs(proposals, { crossAoi }) → [A, B][]       // the same pairs, uncompared
```

`groupPairs` is the pair list without the work, and it exists so the CROSS-AOI
SKIP RULE has one copy: js/app.js walks it and calls `compareProposals` itself
with a `setTimeout(0)` between pairs, because a pair is 230–700 ms of
synchronous clipper work and yielding per GROUP held the main thread through ten
of them (js/app.js's header carries the input-latency measurements). This module
stays synchronous and Node-testable; an async `onPair` hook here would have
ended that.

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
ids, and so does the same session loaded in a different order. (The key string
sorts BOTH of its asymmetric halves — the two resulting classes, and the two
proposal `shortId`s that § 8 puts in it. Load order is only ever which proposal
arrives as A.)

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

`sharedLine` keeps the segments of A's boundary that **run within
`SEAM_TOLERANCE_KM` of B's**, over a cell index of B's segments with an
equirectangular point-to-segment distance. Symmetric by construction: measured
A-side against B-side over all ten demo AOI pairs, the two agree to 0.1 km.
1–10 ms per pair. **Test bbox overlap with `envelopeOf(indexParts(aoi))`, not
`aoi.bbox`** — the Alaska rule.

> **This replaces the clip-then-`lineOverlap` written here at the freeze, and
> both halves of that were measured wrong on this corpus (WP-E).** THE CLIP
> INVENTS SHARED LINE: clipping two AOIs to their envelope overlap closes each
> along the same four rectangle edges, and Montana's artificial edge at
> −111.07° *is* Wyoming's western state line for 72 km — the two then "share" a
> border along Idaho. Clipping turned MT/WY into 279.0 km against a true 608.6,
> and NE/SD into 681.5 km against 109.9 for the same call unclipped. And
> `lineOverlap` IS ARGUMENT-ORDER DEPENDENT and non-monotonic in its tolerance,
> because it walks the second line's segments against an index of the first:
> NE/SD came back 572.1 km with South Dakota first and 109.9 km with Nebraska
> first, both at 50 m, and 681.5 km at a tolerance of zero. (The vendored
> js/changes.js knows this — its edge-effect note says the patch outline must
> go first — but there the operands are a short fragment and a long line, and
> here neither is.) The SD/NE line is **681.5 km**, not the 489 km measured
> during planning.

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
behind it: **1 indeterminate sample in 341** at a 1 km offset over the SD/NE
line (which clears both the FSA boundary's ~40 m zigzag and the editor's 0.5 km
`NEIGHBOR_BUFFER_KM`), whole-mile reporting, and no boolean ops at all. A
sample whose class comes back `null` on either side is indeterminate for the
same reason a side-less one is: `null` means "outside that working area", which
is not an answer about this border.

```js
Run {
  classA, classB, publishedA, publishedB,
  step,            // ord(classB) − ord(classA)
  publishedStep,   // ord(publishedB) − ord(publishedA)
  kind,            // 'agree' | 'new' | 'widened' | 'pre-existing' | 'narrowed' | 'unknown'
  lengthKm, from, to, midpoint,
  geometry,        // LineString — THIS RUN'S OWN STRETCH OF THE BORDER
  changedBy,       // 'A' | 'B' | 'both' | 'neither'
}
```

- `step === 0` with a change on either side → `agree`;
- else `publishedStep === 0` → **`new`** (a seam the published map did not have);
- `|step| > |publishedStep|` → **`widened`**;
- equal → `pre-existing` — kept in `runs`, **excluded from findings**;
- smaller → `narrowed`.

**`geometry` carries every vertex of the border between the run's ends, never
the `from`→`to` chord** (WP-C). A jurisdiction line is not straight — the
Missouri carries the SD/NE border for 200 km — and `seams-casing` draws a `new`
run with a 5 px white casing under it: on a chord that casing lies in the wrong
state. Consecutive runs meet, because each end is extended half a sample's
share of the line.

**`'unknown'` is a sixth kind**, for a far side the published week could not be
read for: § 6 says the seam is still emitted, so its runs carry what side A
says with `classB`, `step` and `publishedStep` all `null`. It is excluded from
findings exactly as `pre-existing` is.

**AN UNKNOWN RUN IS NEVER THE WORST RUN.** Every surface that picks one run to
speak for a seam — the findings row, the card's two columns, the brief's
disjuncture sentence — picks it from the runs that are not `'unknown'`, because
a run whose far side was never read says nothing to be worst about, and its
`null` class printed as "null" or "none" is a false statement about drought.
When `'unknown'` is ALL there is, the longest one still fills the near column
and the far one reads **"not known"**.

`lengthKm` is the sum of its samples' equal shares of their own line string, so
**the runs of a line add up to the line** — a flat `SEAM_SPACING_KM` per sample
is close enough on a 680 km border and badly wrong on an edge effect's
fragments, where eleven pieces totalling 5.4 km would each claim 2 km.

```js
Seam {
  id,            // 'seam:<8 hex>' — § 8
  key,           // the canonical string that was hashed
  kind: 'seam',
  sideA, sideB, neighbourId,
  runs: Run[], lengthKm, newStepKm, maxStep,
  sharedKm,      // the TRUE shared border, or null — see below
  geometry,      // MultiLineString — THE LINE THE SEAM WAS ANALYSED OVER
  reciprocal,    // true when BOTH sides carry a proposal
  isNew,         // any run of kind 'new'
  edgeEffects,   // the matching edgeEffects rows from either side
  borderNotes,   // { A: md|null, B: md|null }
  anchor,        // the midpoint of the longest non-'agree' run
  aoiIds: [aoiA, aoiB],
}
```

`Seam.geometry` (WP-C) is `sharedLine`'s result where both sides are loaded and
the union of the loaded side's `edgeEffects[].segments` where the neighbour is
not — so the map draws the seam itself rather than a box around it. It is also
exposed as `line`, which is the name js/seams.js's own functions read it under.

**`lengthKm` IS THAT LINE, WHICH IS NOT ALWAYS THE BORDER, and `sharedKm` is
the border or `null`.** Where both sides are loaded the line IS the shared
boundary and the two numbers are equal. Where the neighbour is a jurisdiction
nobody loaded, the line is that one author's own `edgeEffects[].segments`
toward it — measured 72 km where the border runs 378 — and this app holds no
ring for the far side to measure the rest against, so `sharedKm` is `null` and
every sentence that reads it says **"N mi of M mi analysed"** rather than
"shared" (js/panels.js `seamLines`, js/cards.js `showSeam`, js/brief.js
`buildSeamBrief`). "68 mi of 72 mi shared" for a 378 mi border is a claim about
the boundary made out of a measurement of something else.

Rank: reciprocal-with-disagreement first → `maxStep` descending → `newStepKm`
descending → `id`. "Reciprocal-with-disagreement" is a seam carrying a
reportable run whose `changedBy` is `'both'`: both authors looked at this
border, both said something, and the two still do not line up.

### Seams against regions (WP-B)

```js
rankFindings(regions, seams) → findings[]      // js/session.js
```

**The one ranked list is a CONCATENATION** — conflicts, then one-sided, then
seams, each in its own total order — and that is a decision, not a default. The
three kinds are not commensurable: a seam has no area and its size is a LENGTH,
so a merged rank by `areaKm2` puts every seam last and a merged rank by class
step puts a two-class seam above every one-class conflict in the set. Either
way the finding a reconciliation meeting exists to settle gets buried. It is
also the order of the drawer's three `<details>` groups, so the list and its
text twin cannot disagree.

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
buildSessionBrief(session, comparisons, seams, { viewerUrl, findings }) → string

rankedFindings(findings, comparisons, seams) → object[]   // one run, unique ids
comparisonFor(region, comparisons) → Comparison|null      // BY THE PAIR
```

**Every call takes `viewerUrl`, including the session one.** Without it not a
single brief in a session document links back, and every brief promises it does.

**`opts.findings` is the session's resolved, ranked list** (`resolveFindingIds`
over `rankFindings`, § 5) — the same list the drawer shows. The index is built
from it rather than from a second walk of the comparisons, which is comparison
order (three descending runs, not one rank) and can name a region twice. The
rank itself belongs to the engine and lives behind turf, which this module may
not import, so it is passed in rather than recomputed. Without it the index
falls back to the comparisons' regions, deduped by id and in kind order.

**A region's comparison is found BY ITS PAIR, never by its id** — `comparisonFor`
matches `pair` against the region's own `proposalA`/`proposalB`. An id is a hash,
a session may widen one (§ 8), and a lookup that misses hands `buildRegionBrief`
two nulls, which prints "an unnamed author" and "This side could not be read"
for a finding whose card shows both authors correctly.

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
physical". Its bullets are **Shared boundary** (or **Line analysed**, § 5),
**Newly stepped**, **Largest step** and **Reciprocal** yes/no.

**NOTHING IS KNOWN IS NOT ZERO.** A null class is printed **"not known"** and
never "none" or "—": `'none'` means ground inside a working area with no drought
on it, and `null` means a side nobody could read. A seam whose every run carries
a null `step` — the far side unreadable — prints "not known" for **Newly
stepped** and **Largest step** rather than "0 mi" and "0 classes", which read as
"we looked, and there is no step". The same rule holds in the findings list and
on the card (§ 11).

A session brief is a header table of proposals and authors, an integrity table,
the ranked index of regions and seams — **one row per finding, each linking back
through `?focus=`** — a **"Not compared"** section (refused weeks, unloaded
neighbours, unknown sides), then every individual brief under `---`, in the same
rank order the index is in.

---

## 8. Finding ids

Every finding carries a **deterministic** `id`, because `?focus=` in a brief must
reopen the same finding after a reload, in another browser, with the files loaded
in a different order.

```
id      ::= 'disc:' hex | 'seam:' hex
hex     ::= eight lowercase hex digits — FNV-1a (32-bit) over `key`
            (twelve only when two keys collide; see Collisions below)
```

| finding | `key`, the string that is hashed |
|---|---|
| region | `disc\|<kind>\|<aoiId>\|<propLo>\|<propHi>\|<lo>\|<hi>\|<published>\|<bbox@1e-3>` |
| seam | `seam\|<aoiIdLo>\|<aoiIdHi>\|<propLo>\|<propHi>\|<n>` |

- **`<propLo>`/`<propHi>` are the two sides' `shortId`s sorted** — for a seam,
  or the literal `pub` for a published side and `unk` for an unknown one;
- `<lo>`/`<hi>` are the pair's two resulting classes **sorted**, so argument
  order cannot change the id;
- `<bbox@1e-3>` is the four bbox numbers rounded to 3 decimals and joined with
  `,` — a thousandth of a degree is ~100 m, far below the smallest region kept
  and far above float noise;
- `<n>` is the seam's index among that pair's seams, in rank order.

**EVERY KEY NAMES THE PAIR, and a region's did not until 2026-09.** Three
proposals over one working area answer a great deal of ground the same way as
each other, so a key of `(kind, aoi, classes, published, bbox)` names one
polygon that two or three different PAIRS each produce: measured on the demo
set, 188 findings minted only **146 distinct ids** — 84 of them collided and 42
took a `-2`/`-3`, one id standing for two or three findings with two or three
different briefs behind one `?focus=` link. With the pair the same 188 mint 188.
Sorting the two
`shortId`s into the key makes them distinct ids and keeps both invariances —
argument order (the key is symmetric in its pair) and load order (which is only
ever which proposal arrives as A).

Every finding also carries its `key` verbatim, so a test can assert on the
readable string rather than the hash.

**Collisions.** With the pair in the key two different findings can no longer
hash equal by construction, so the only collision left is a TRUE FNV-1a
collision between two unrelated keys — which has never occurred on this corpus.
The SESSION resolves one by **widening both sides to twelve hex**
(`resolveFindingIds`, js/session.js), computed from each finding's own `key` and
from nothing else: it therefore depends on neither rank nor load order, only on
the SET of keys, which is the same set whatever order the files arrived in. It
is the same rule, for the same reason, that gives a proposal's `shortId` 12 hex
instead of 8 when two `pkg.id`s share their first 8.

> The rank-assigned `-2` / `-3` suffix this replaced was deterministic only in
> rank order, and rank had input order as its final tie-break — so the id a
> `?focus=` link named could change with the order the files were dropped in,
> which is the one property the id exists to have. It also mutated an id after
> the finding was frozen, which broke every lookup that went by it (§ 7's
> region brief found no comparison and printed "an unnamed author").

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
`boundaries`, `county-tiles`, `tribal-boundaries`. `usdm-changes` and
`usdm-delta` stay empty in this app, and `js/map.js` says so in a comment — they
are the editor's change surfaces, this app's Differences view is
`setMapView('changes')` over them, and an empty source is cheaper than a fork.

**The four `band-*` entries are REMOVED, right after `addAll()`.**
`band-dim`/`band-line` over `band-mask`/`band-reach` show the band a scoped verb
can reach while one is ARMED, and this app arms nothing — so they are four style
entries MapLibre walks every frame for something that can never happen.
`createLayerStack` is vendored byte-identical and offers no flag to skip them,
so `js/map.js`'s `dropEditorOnlyBandLayers()` takes them off after the stack is
up: layers before sources, and both vendored callers survive it
(`renderBandMask` is `getSource(id)?.setData`, `restyleForTheme` guards every
paint with `getLayer(id)`). Removing after is the general answer here; editing
the copy is never one.

**Viewer sources:**

| source | feature properties |
|---|---|
| `findings` | `{ id, kind, delta, magnitude, areaKm2, aoiId }` |
| `seams` | `{ id, kind, isNew, step, lengthKm }` — one feature per reportable RUN, its geometry `Run.geometry` (§ 5): every vertex of that stretch of the border, never the `from`→`to` chord |
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
createPanels(els, ctx, handlers?) → {
  renderSession(summary),        // #session-line
  renderProposals(proposals),    // #proposal-list, grouped by working area
  renderFindings(findings),      // #findings-section
  renderLegend(view),            // #legend-section
  setStatus(sentence),           // #findings-status, role=status
  setSelection(selection),       // the selected row's aria-current
  repaintDimming(),              // one class per row, no rebuild
  destroy(),                     // cancels the deferred re-check queue
}

handlers = { onToggleShown(ids), onOpenProposal(p), onOpenFinding(f),
             onActivateRow(target) }
```

**Three additions to the frozen surface, and one optional argument (WP-D).**
`handlers` is how js/app.js wires the drawer's three verbs explicitly; each falls
back to `ctx` (`setShown`, `openProposal`, `select`) when it is absent, so the
two-argument call above still works unchanged. `onActivateRow` is the fourth and
has no `ctx` fallback: it runs BEFORE either open, and js/app.js uses it to close
the compact drawer — on a phone the drawer is an overlay over the map and the
card is a bottom sheet UNDER it, so a finding opened from the list arrived behind
the panel it was opened from. The panel does not know what compact is; the app
does. `setSelection` and
`repaintDimming` exist because neither is a render: a selection moving and a
checkbox moving each change ONE attribute per row, and rebuilding forty rows to
move one `aria-current` would throw away the reader's scroll position and their
keyboard place with it.

**The re-check verdict is DEFERRED, one proposal per `setTimeout(0)`.** Reading
`p.integrity` costs 106–663 ms per package (measured over the twelve bundled
ones), so touching twelve of them inside `renderProposals` would freeze the
drawer for seconds at the moment a reader is looking at it. Rows render at once
with a "checking…" line and a queue fills them in; a re-render cancels it. Not
`requestIdleCallback` — Safari does not have it, and this app is public.

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
createCards(els, ctx, handlers?) → { showProposal(p), showChange(p, patchKey),
                                     showFinding(f), showSeam(s), showing() }

handlers = { onZoom(target), onOpenFinding(f) }
```

Same optional third argument, for the same reason: a "Zoom" button on a card and
a cross-link to another finding are the two verbs the list and the map already
have, and they go to the same two functions rather than to a second pair.
`showFinding` accepts a seam and forwards it, so a caller holding a mixed ranked
list never has to ask which kind it has.

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
recheckPackage(pkg) → { grade: 'pass'|'residue'|'defect', ok, problems: [],
                        residue: [], largestKm2, residueKm2, residueWidestM,
                        sentence }
normalizeRecheck(either shape) → the shape above
recheckSentence(result) → string          // § 15
containmentEscapes(pkg) → escape[]        // with GEOMETRY
gradeEscape(km2, widthM) → 'ignore'|'residue'|'defect'
```

`sentence` is the author-facing line (§ 15) — and for `residue` it says "agrees
to within N mi² along shared edges", never "hand-edited".

**`problems` and `residue` are two lists, not one (WP-D).** A problem is
`{ message, class, areaKm2, widthM, geometry }` — an OBJECT, always, so a caller
never has to ask which shape it got, and `geometry` is what the card's "Show me"
needs. Residue is not a problem and must not be counted as one: ten of the twelve
bundled proposals grade `residue`, and a panel that reported "10 problems" over
ten slivers would be the exact failure this grading exists to prevent.

**The grading implementation lives HERE, and `normalizeRecheck` is the seam.**
§ 2's `checkIntegrity` grades too, with the same bars and a different shape (one
`problems` list with a `grade` on every row, plus `escapedKm2`). The drawer reads
whichever it is handed through `normalizeRecheck`, so the sentence and the split
are written once. Two copies of a magnitude bar drift.

**It works against both copies of `verifyPackage`.** A `residue` field on the
result is used when it is there (the re-synced copy has already applied the width
channel, and a clean file then costs no geometry work at all); the
mutual-containment loop is re-run here whenever there is a containment problem to
attach geometry to, or whenever the copy has no `residue` field. When it is
re-run its answer is authoritative, so nothing is counted twice.

### js/export.js

```js
{
  downloadBrief(finding, opts) → filename|null,   // saveFile() from the vendored js/dom.js
  copyBrief(finding, opts) → Promise<boolean>,    // clipboard, then ONE toast
  downloadSessionBrief(opts) → filename|null,
  briefFilename(finding, { week }) → string,  // 'usdm-brief-2026-09-08-MT-conflict-1a2b3c4d.md'
  sessionBriefFilename({ week }) → string,    // 'usdm-briefs-2026-09-08.md'
  linkTo(finding, { viewerUrl, url }) → string,   // absolute url with ?focus=
}

opts = { ctx, markdown?, brief?, week?, say? }
```

**The markdown comes from the caller, never from this module (WP-D).** It is
`opts.markdown`, else `opts.brief(finding)`, else `ctx.brief(finding)` — this
module knows how a string becomes a download, a clipboard entry and a url, and
nothing about how a brief is written. `week` is `opts.week ?? ctx.week`: a
finding carries no week and the filename leads with one.

**`linkTo` preserves the address the reader is at** and replaces only `focus`.
There is no Share button in this app because the address bar is the share, so a
brief that linked back to a default view would drop its reader somewhere they
have never been.

**The clipboard's failure path downloads instead**, with one sentence saying so.
The reader asked for the text out of the browser; an insecure origin or a refused
permission is not a reason to answer with an apology, and two toasts in one turn
means the first was never read.

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
  get shown(),                   // Set<proposalId> — EMPTY MEANS ALL, see below
  get selection(),               // { kind, id } | null
  get viewerUrl(),               // location.origin + location.pathname

  setView(v), setPick(id), setShown({ ids, all } | ids[] | null), select(sel | null),
  focus(target),
  say(sentence),                 // ONE toast (the kit's showToast is a singleton)
  live(sentence),                // the polite live region
  note(sentence, { error }),     // #app-note
  markFor(proposalId), proposalById(id), findingById(id),
  brief(finding) → string,
  sessionBrief() → string,       // every finding in one document
  worstDeltaFor(p, patch),       // § 2's change map, for a change card
  openFinding(f), openProposal(p),   // aliases for select(), by name
  get cards(), get card(), get drawer(), get map(), get mapView(),
  get layers(), get els(), fitPadding(base), pushState(),
})
```

**An empty `shown` set means EVERY loaded proposal (WP-B).** It is not "none",
and no caller may read it as a list to filter by without checking its size
first — `js/map.js`'s `setShown` and `js/panels.js`'s `isShown` both take the
same reading, and `ctx.setShown` normalises a set naming everything back to the
empty one. The alternative, holding the full list, makes the DEFAULT a thing that
has to be rewritten on every load and re-derived on every comparison; and it
would put twelve shortIds in the address bar of a session nobody has narrowed,
where § 14 says a view at defaults emits nothing at all.

**So a caller that has checkboxes says which it means.** `ctx.setShown` takes
three shapes and they are not interchangeable:

| argument | meaning |
|---|---|
| `{ ids, all }` | the panel's: `all: true` is every proposal, `all: false` with an empty `ids` is NONE |
| `ids[]` | the legacy reading — empty means every proposal |
| `null` | every proposal |

`js/panels.js`'s ONE call site (`onShownChanged`) passes `{ ids, all }`, because
"all twelve ticked" and "none ticked" both arrive as `[]` and the app answered
both by showing everything: unticking the last box left a drawer with nothing
ticked, no `?show=`, no finding dimmed, and a live region saying "Showing every
loaded proposal".

**The last untick is REFUSED, with a sentence** — "At least one proposal stays
shown — for the week with nothing drawn over it, use the Published view." The
other half of the choice (hide everything, announce it) needs a third state that
`js/map.js`, `js/panels.js`'s `isShown`, the dimming and `?show=` would all have
to learn, where today there are two and exactly one spelling of the default; and
what it buys is the published week with no marks on it, which is the Published
view, one control away. `setShown` re-renders the rows from the model and
restores focus by id, so the box springs back under the reader's finger.

**The `summary` object `renderSession` is handed (WP-B and WP-D):**

```js
{
  week,                  // 'YYYY-MM-DD' | null
  proposals,             // the ARRAY, not a count — panels counts it itself
  findings,              // the ARRAY, likewise; panels counts the three kinds
  count, areas,          // numbers, for a caller that wants them without a pass
  conflicts, oneSided, seams,   // numbers
  local,                 // did ANY of this come off this computer?
  localNote,             // the sentence for that, or null
  sentence,              // the § 15 findings sentence, for the empty case
}
```

`proposals` and `findings` are arrays because `renderSession` falls back to
`ctx` when it is handed nothing, and a number in those fields reads as "nothing
is loaded". `local` is STICKY and comes from the `LoadReport`, not from
`Proposal.source` — a session that mixes a `?load=` url with a dropped file
still cannot travel in a link, and the sentence has to say so.

The verification hook, for `tools/verify.mjs` and nothing else:

```js
window.__viewer = Object.freeze({
  get booted(),       // boot() ran all the way to the end
  get passes(),       // FINISHED recompute passes — the settled signal
  get session(),
  get findings(),
  get seams(),
  get view(),
  ctx: () => ctx,
  get lastCompareMs(), get lastPunchMs(), get lastDeriveMs(),
  get basemapDegraded(),
})
```

**Wait on `passes`, never on `findings.length` (WP-B).** `booted` is set once,
and everything a load produces — the drawer's session line, the legend, the
map's findings, the URL — is written at the END of the recompute pass, after the
findings array has already filled. A harness waiting on the array therefore
races the paint it is about to assert on. `passes` goes up last.

`basemapDegraded` says whether `resolveBaseStyle()` fell back to the blank
ground: a degraded boot and a slow one are indistinguishable from outside
without it.

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
| `?load=` | comma-separated urls | origin must be `location.origin` or `https://data.sustainable-fsa.com`, **checked before the fetch**; re-emitted only when it loaded something |
| `?demo` | present | the bundled demo set |
| `?view=` | `published` \| `differences` | `proposal` is the default and emits nothing |
| `?pick=` | `<shortId>` | 8 hex of `pkg.id`, 12 on collision |
| `?show=` | comma-separated shortIds | emitted only when NOT all are shown |
| `?focus=` | a finding id (§ 8) | `disc:` / `seam:` **only**; briefs link back through this |
| `?proposal=` | `<shortId>` | a proposal's card, opened at boot |
| `?change=` | `<patchKey>` | one change's card, opened at boot |
| `?theme=` | `light` | high-contrast is the default; this is the only route back, and the anti-flash boot reads the URL and nothing else |
| `?drawer=` | `closed` | desktop only, and only when closed |

**The three selection parameters are three because their values are three
different things.** A selection is one of `conflict` / `one-sided` / `seam` /
`change` / `proposal`, and only the first three have ids `findingById` can
resolve. Emitting a proposal's uuid or a patch key as `?focus=` produced a link
the app REFUSED on reload — "That link points at a finding this set does not
contain", about a finding that never was one. At boot the first of
`focus` → `proposal` → `change` that resolves wins; only one thing can be open.

**A value that names nothing gets a sentence, and all of them share ONE toast.**
A stale `?pick=` used to be dropped in silence while proposal A was painted
instead, which is a shared link showing a different author's work with nothing
to say so; `?show=` was the same with a wider set than the link promised. Each
clause names its parameter's subject and what is on screen instead (§ 15).

**`/` and `,` are emitted literally.** `replaceUrlState` hands the object to
`URLSearchParams`, which percent-encodes both, so a two-file `?load=` came back
as `demo%2Fa.json.gz%2Cdemo%2Fb.json.gz`; `js/app.js`'s `readableSeparators()`
puts them back after every write. Both are legal unencoded in a query, this
app's only Share is the address bar, and nothing in this grammar carries either
character as data — shortIds are hex, finding ids are a prefix plus hex, a patch
key is a uuid, and `?load=`/`?show=` are lists this app splits on the comma
itself. `&` and `=` stay encoded, which is what keeps a url with its own query
string inside `?load=` intact.

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
| every file a duplicate (e.g. Demo pressed twice) | "Those N proposals are already loaded." — one toast, nothing painted over the map; a lone duplicate keeps the singular sentence; duplicates mixed with new loads: "N proposals loaded; M were already loaded." |
| reissued baseline | "\<Author\>'s proposal was drawn against a re-issued copy of the same week; it is loaded, and small differences along shared edges may be the baseline rather than the proposal." |
| unknown `?focus=` | "That link points at a finding this set does not contain." |
| unknown `?proposal=` / `?change=` | the same sentence, naming a proposal / a change |
| unknown `?pick=` | "That link named a proposal this set does not contain — showing \<letter\>." |
| unknown `?show=` ids | "That link asked to show N proposals this set does not contain — showing the M it does." · none of them known: "…— showing every one." |
| refused `?load=` origin | "\<origin\> is not an origin this tool will fetch from." |
| unticking the last proposal | "At least one proposal stays shown — for the week with nothing drawn over it, use the Published view." (§ 12) |

Every stale-URL clause above is ONE toast however many parameters were stale —
the kit's `showToast` is a singleton, so three toasts means a reader sees the
third.

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
| `pass` | "Re-check: re-derived from this file and it matches exactly." |
| `residue` | "Re-check: agrees to within \<n\> mi² along shared edges — clipper residue, not an edit." |
| `defect` | "Re-check: \<n\> problems, largest \<n\> mi²." |

All three are **written to a reviewer**. `pass` used to say "the package's own
geometry agrees with itself", which is a tautology to somebody holding a file
they did not write: what they want to know is whether this app re-derived the
same map from the bytes they were sent.

A package missing its paperwork adds ONE more sentence beside the verdict — never
instead of it, and never the editor's author-facing form hints:

- "This proposal carries no rationale and no author." (`completenessSentence`,
  § 2)

The defect sentences quote the vendored verifier, which writes them for a sliver:
`js/recheck.js`'s `readableMessage` re-spells "61,460 ft" as miles above one mile
and "7,605.49 mi²" at `fmtMi2`'s own precision above 100 mi². The vendored copy
is byte-pinned and is not edited.

---

## 16. Decisions WP-A made

Where the plan left something open or said two things, this is the ruling.

1. **Finding ids are hashed on both sides** — `disc:<8 hex>` and `seam:<8 hex>`,
   each carrying its readable `key` (§ 8). The plan sketched seams as
   `s:<aoiA>:<aoiB>:<propA>:<propB|pub>:<n>`, but **AOI ids contain a colon**
   (`state:MT`, `aiannh:01263144-86`), so that grammar is ambiguous the moment it
   is parsed back out of `?focus=`. Hashing both kinds also keeps the URL short
   and makes the two prefixes the only thing a reader has to know.
2. ~~**Collisions are resolved by the session, by rank**, with a `-2` / `-3`
   suffix (§ 8).~~ **SUPERSEDED 2026-09-13** — the rank's final tie-break is
   input order, so a rank-assigned suffix was not stable across load order, and
   the collisions it was resolving were not hash collisions at all: the region
   key omitted the proposal pair. The key now names the pair and a true hash
   collision widens both ids to twelve hex, which is decision 3's rule applied
   to findings. § 8 is the record.
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
9. **`css/app.css`'s kit-override count is 2** — the `.ridr-toast` lift (the kit
   floats it 1.5 rem above the viewport bottom, which on desktop is inside this
   app's footer disclaimer) and the `prefers-reduced-motion` reset, which is
   written on `*` and so reaches the kit's own transitions. The MapLibre
   attribution lift that used to be the ONE override is GONE: the kit already
   pads the bottom corners by `--sheet-h`, and doing it twice threw the
   attribution above the sheet and behind the navbar. `#detail-card`'s width and
   `#info-body`'s prose rhythm are this app's own ids and are placement, which
   the kit explicitly leaves to the app.
10. **The card is `min(28rem, 42vw)` and the finding grid is ONE COLUMN at every
    width.** It was `repeat(auto-fit, minmax(11rem, 1fr))`, which fitted two
    tracks into that card at 1440 and at 1024 and handed each rationale ~200 px
    — about 32 characters a line, for the two blocks of prose the card exists to
    let somebody read. A 65-character column that scrolls beats two 32-character
    columns that do not; the classes, the authors and the sizes are one short
    line each at the top of each block.
