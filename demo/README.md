# The bundled example set

Twelve `usdm-edit-proposal/2` packages over the five Northern Great Plains
states, all against the USDM week of **2026-09-08**. `?demo` (and the **Demo**
button) reads [`index.json`](index.json) and then these twelve files, in the
order the index lists them.

**Nothing here is a real drought assessment.** The edits are plausible in shape
and the justifications read like the genuine article, but every indicator cited
was invented for the exercise, every author is fictional, and every email is at
`example.org`. They exist so this tool — and anything downstream of it — has
real files to develop against before real authors produce any.

## Provenance

Copied **byte for byte** from `ngp-ridr/usdm-editor`, `examples/proposals/`, at
commit **`087469d`** ("Two example proposals that deliberately disagree — an
intrastate conflict in Montana and Nebraska, an interstate one across the
Montana/Wyoming line"), on 2026-09-12. Nothing in this directory is regenerated
here and nothing is edited: a file whose bytes differ from the editor's is a
bug, not a variant. To re-copy after the editor changes them:

```sh
cp ../../usdm-editor/examples/proposals/*.json.gz demo/
```

The editor produced each one by driving its own UI headless
(`tools/example-proposal.mjs`) from a scenario file: the polygons go through
the model exactly as the palette's two verbs do, and everything after that is
the wizard's own DOM — the justification fields, the evidence rows, the author
block, the national gate and a real browser download. Every one passes
`validation.passed`. The editor's [`examples/README.md`][ex] carries the full
table: story, author, edit count, per-class deltas in mi², and border effects.

[ex]: https://github.com/ngp-ridr/usdm-editor/blob/main/examples/README.md

Only the `.json.gz` packages are copied. The editor's `.summary.json` and
`inspect-<aoi>.json` files are its own build records and are not read here.

## Load order is the letters

`index.json`'s `files` order **is** the load order, and load order is what
assigns A, B, C… (`js/marks.js`). The ten original proposals come first, two
per state — MT, WY, ND, SD, NE — and the **two dissents come last**, so K and L
are exactly the proposals that disagree with something already on screen.

| letter | file (`usdm-proposal-2026-09-08-…`) | state | author (fictional) |
|---|---|---|---|
| A | `state-MT-853adab3` | Montana | Marla Teigen, county extension |
| B | `state-MT-06e8fb67` | Montana | Dana Reyes, tribal water-resources office |
| C | `state-WY-53bc5877` | Wyoming | Delia Hartwick, state engineer's office |
| D | `state-WY-ccbbfe2f` | Wyoming | Dr. Marisol Tenley, university lab |
| E | `state-ND-8e4e4468` | North Dakota | Marlys Thorstad, emergency management |
| F | `state-ND-2c885add` | North Dakota | Dana Kjelland, state climate office |
| G | `state-SD-9c26907b` | South Dakota | Marla Redwater, tribal natural resources |
| H | `state-SD-f3f094e2` | South Dakota | Elise Brandvold, growers' cooperative |
| I | `state-NE-3f4c9136` | Nebraska | Marla Ostendorf, natural-resources district |
| J | `state-NE-9d215f60` | Nebraska | Dana Whitcomb, federal field office |
| K | `state-MT-4ab1b4a8` | Montana | **dissent** — Wade Ostrander, state climatologist's office |
| L | `state-NE-85cf87ba` | Nebraska | **dissent** — Roy Steffensmeier, irrigation-district manager |

## The two dissents — what this tool is here to find

The first ten never touch each other's ground: two authors working the same
state took different halves of it. That is realistic, and it is also why the
set needed two more. Each proposal starts, as every proposal does, from the
published week — the editor will not stack one author's moves on another's — so
a real disagreement has to be an **opposite-direction edit over shared ground**.

- **K (`state-MT-4ab1b4a8`) contradicts B (`state-MT-06e8fb67`).** Dana Reyes
  degrades the Milk River Hi-Line from Malta to Glasgow, D0 → D1; Wade
  Ostrander improves the same block off D0 altogether, reading the same late
  August rain the other way. The two changes overlap by **5,665 km²
  (2,187 mi²)** — 100% of Reyes's change and 81% of Ostrander's. One block of
  the Milk River valley is therefore carried at D0 by the published map, at D1
  by one proposal and as drought-free by the other: a **conflict**, and the
  largest one in the set.
- **K's second edit crosses a state line.** Its Powder River improvement
  (D2 → D1, D3 → D2) runs south to the 45th parallel, where C
  (`state-WY-53bc5877`) degrades the Sheridan–Clearmont corridor to D3 up to
  the same line. K records it: an `edgeEffects` entry naming `state:WY` over
  **115.7 km** of shared boundary, and a second naming the Crow Reservation.
  Probe the two `derivedBands` blocks either side of the line at −106.6 and
  −106.2 and you get **MT D1 against WY D3** — a two-class step across a
  surveyed line, which is a **seam**, and the artefact border notes exist for.
- **L (`state-NE-85cf87ba`) contradicts J (`state-NE-9d215f60`).** Dana
  Whitcomb improves the central Platte valley from North Platte to Wood River;
  Roy Steffensmeier degrades it. The overlap is **5,592 km² (2,159 mi²)**, 98%
  of Whitcomb's change, and the strip spans D0, D1 and D2 — so this
  disagreement carries several class pairs rather than one.

Nothing about the disagreements is special-cased: both dissents pass the same
national gate as the other ten. Reconciling them is a reviewer's job, which is
the whole point of having the files.

## `scenarios/`

The two dissents' **inputs** — what each author "drew" and wrote, in the
editor's scenario format (its `tools/example-proposal.mjs` header documents the
schema). They are here so the disagreement can be re-created or varied without
guessing at the polygons that produced it; this app never reads them. The other
ten scenarios stay in the editor.

## Copying is not endorsement

These files are examples of the **format** and of the kinds of disagreement the
format can express. They are not a drought assessment, they are not anybody's
official position, and a brief written from them is a demonstration of the
brief, not of a finding.
