/* ============================================================================
   USDM Edit Viewer · tools/marks.test.mjs
   The letters and the dashes — js/marks.js, under Node, in milliseconds.

     node tools/marks.test.mjs

   ── Why this is its own gate ───────────────────────────────────────────────
   A proposal's identity on this map is a LETTER and a DASH PATTERN and nothing
   else. Colour is not available: the USDM class ramp is a published encoding
   nothing may tint, NDMC's change ramp owns the Differences view, and
   `--selection-ring` already means "the thing you pointed at". So if the
   assignment drifts — two proposals in one working area sharing a pattern, a
   letter that changes between two renders of the same session, a legend swatch
   that disagrees with the line on the map — the reader has no second channel to
   fall back on and no way to notice.

   Three surfaces read this module (js/map.js's four `patches-line-*` layers,
   js/panels.js's legend and proposal list, js/brief.js's "Side A"), which is
   exactly why it is pure: one Node test covers all three, and none of them can
   drift from the others without failing here first.

   ── What is asserted ───────────────────────────────────────────────────────
     § 0  purity — no window, document, fetch or DOM anywhere in the source
     § 1  the table: four patterns, their dasharrays, widths, caps and swatches
     § 2  letters run A…Z then AA, in LOAD ORDER across the whole session
     § 3  the dash index cycles 0–3 WITHIN an AOI, not across the session
     § 4  a fifth proposal in one AOI repeats pattern 0 and says so
     § 5  determinism — the same session assigns the same marks twice
     § 6  the map fixture agrees (tools/fixtures/findings-map.json)
     § 7  `deltaFor` from js/map.js: the signed step the change ramp is keyed
          to, including the tie rule. Pure, and the only other number WP-C owns
          that can be wrong without anything on screen looking wrong.

   No turf and no fixtures beyond the one JSON file: this module touches no
   geometry at all, which is the property that keeps it cheap.
   ========================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  assignMarks, markStyle, markPatterns, letterFor, anyRepeated, MARK_COUNT,
} = await import(join(ROOT, 'js/marks.js'));

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const skip = (m) => console.log(`  skip ${m}`);
const check = (c, m) => (c ? ok(m) : bad(m));

/** A proposal, as much of one as this module ever looks at. */
function proposal(id, aoiId) {
  return { id, aoi: { id: aoiId, kind: 'state', name: aoiId } };
}

/* ══ § 0 · purity ═══════════════════════════════════════════════════════════
   The editor's § 14h pattern: grep the SOURCE TEXT, because an import that
   only reaches the DOM on some code path still cannot run under Node, and the
   failure would surface as a broken brief rather than as a broken module. */
console.log('\n── § 0 · js/marks.js is DOM-free ──────────────────────────────');
{
  const src = readFileSync(join(ROOT, 'js/marks.js'), 'utf8');
  /* Strip comments first: this file's own header talks ABOUT the DOM rules it
     obeys, and a naive grep would fail on the prose that explains the rule. */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['window', 'document', 'fetch(', 'localStorage', 'navigator']) {
    check(!code.includes(forbidden), `no \`${forbidden}\` in js/marks.js`);
  }
  check(!/^\s*import\s/m.test(code), 'js/marks.js imports nothing at all — it is a leaf');
}

/* ══ § 1 · the table ════════════════════════════════════════════════════════ */
console.log('\n── § 1 · the four patterns ────────────────────────────────────');
{
  check(MARK_COUNT === 4, 'MARK_COUNT is 4');
  const all = markPatterns();
  check(all.length === 4, 'markPatterns() returns four');

  const expected = [
    { dash: 0, dasharray: null, swatch: 'solid', cap: 'butt' },
    { dash: 1, dasharray: [2, 1.5], swatch: 'dashed', cap: 'butt' },
    { dash: 2, dasharray: [0.2, 1.6], swatch: 'dotted', cap: 'round' },
    { dash: 3, dasharray: [2.5, 1.2, 0.4, 1.2], swatch: 'double', cap: 'butt' },
  ];
  for (const want of expected) {
    const got = markStyle(want.dash);
    check(JSON.stringify(got.dasharray) === JSON.stringify(want.dasharray),
      `dash ${want.dash} · line-dasharray ${JSON.stringify(want.dasharray)}`);
    check(got.swatch === want.swatch,
      `dash ${want.dash} · legend border-top-style \`${want.swatch}\``);
    check(got.cap === want.cap, `dash ${want.dash} · line-cap \`${want.cap}\``);
    check(got.width === 1.6, `dash ${want.dash} · 1.6 px`);
    check(got.className === `mark-${want.dash}`,
      `dash ${want.dash} · css class \`mark-${want.dash}\` (css/app.css § 4 has it)`);
  }

  /* SOLID IS `null`, NOT `[1]`. MapLibre has no dasharray value that means
     solid; `[1]` renders solid and lies to anyone reading the style, and
     js/map.js branches on exactly this to omit the property. */
  check(markStyle(0).dasharray === null, 'pattern 0 is solid by OMITTING the dasharray');

  /* A fifth index wraps rather than throwing: the app has already decided the
     letter carries a repeat, and a style lookup is not where that is refused. */
  check(markStyle(4).dash === 0, 'markStyle(4) wraps to pattern 0');
  check(markStyle(7).dash === 3, 'markStyle(7) wraps to pattern 3');

  /* Fresh arrays every call, for the same reason js/layers.js builds a fresh
     empty FeatureCollection per source: MapLibre keeps what it is handed. */
  const a = markStyle(1); const b = markStyle(1);
  check(a.dasharray !== b.dasharray && JSON.stringify(a.dasharray) === JSON.stringify(b.dasharray),
    'each call gets its OWN dasharray array — MapLibre keeps the object it is handed');

  /* Every pair differs on at least one SHAPE axis; colour is not available to
     separate them, which is the whole premise. */
  const shapes = new Set(all.map((p) => JSON.stringify([p.dasharray, p.cap])));
  check(shapes.size === 4, 'all four patterns are distinct in shape alone');
  const swatches = new Set(all.map((p) => p.swatch));
  check(swatches.size === 4, 'and so are the four legend swatches');
}

/* ══ § 2 · letters ══════════════════════════════════════════════════════════ */
console.log('\n── § 2 · letters, in load order across the session ─────────────');
{
  check(letterFor(0) === 'A' && letterFor(25) === 'Z', 'A … Z');
  check(letterFor(26) === 'AA', 'then AA — never a silent reuse of A');
  check(letterFor(27) === 'AB' && letterFor(51) === 'AZ' && letterFor(52) === 'BA',
    'AB … AZ … BA (bijective base 26)');

  const session = [
    proposal('mt-1', 'state:MT'),
    proposal('wy-1', 'state:WY'),
    proposal('mt-2', 'state:MT'),
    proposal('nd-1', 'state:ND'),
  ];
  const marks = assignMarks(session);
  const letters = session.map((p) => marks.get(p.id).letter);
  check(letters.join('') === 'ABCD',
    `letters follow LOAD order, not the AOI grouping (${letters.join(', ')})`);
  check(new Set(letters).size === letters.length, 'and no two proposals share one');
}

/* ══ § 3 · the 3-AOI / 7-proposal session ═══════════════════════════════════
   The case the whole design is for: three working areas, seven proposals,
   unevenly spread and interleaved in load order — which is how files actually
   arrive when somebody drops a folder onto the map. */
console.log('\n── § 3 · dashes cycle WITHIN an AOI ───────────────────────────');
{
  const session = [
    proposal('mt-a', 'state:MT'),    // MT #1 → dash 0
    proposal('wy-a', 'state:WY'),    // WY #1 → dash 0
    proposal('mt-b', 'state:MT'),    // MT #2 → dash 1
    proposal('nd-a', 'state:ND'),    // ND #1 → dash 0
    proposal('wy-b', 'state:WY'),    // WY #2 → dash 1
    proposal('mt-c', 'state:MT'),    // MT #3 → dash 2
    proposal('mt-d', 'state:MT'),    // MT #4 → dash 3
  ];
  const marks = assignMarks(session);

  check(marks.size === 7, 'seven proposals, seven marks');

  const want = {
    'mt-a': ['A', 0], 'wy-a': ['B', 0], 'mt-b': ['C', 1], 'nd-a': ['D', 0],
    'wy-b': ['E', 1], 'mt-c': ['F', 2], 'mt-d': ['G', 3],
  };
  for (const [id, [letter, dash]] of Object.entries(want)) {
    const m = marks.get(id);
    check(m?.letter === letter && m?.dash === dash,
      `${id} → ${letter}, dash ${dash} (got ${m?.letter}, dash ${m?.dash})`);
  }

  /* THE PROPERTY, not just the table: within one working area no two dashes
     may collide, and across working areas they are free to — proposals in
     different areas never overlap on the ground. */
  const byAoi = new Map();
  for (const m of marks.values()) {
    if (!byAoi.has(m.aoiId)) byAoi.set(m.aoiId, []);
    byAoi.get(m.aoiId).push(m.dash);
  }
  const collides = [...byAoi.entries()].filter(([, d]) => new Set(d).size !== d.length);
  check(collides.length === 0,
    `no working area reuses a dash (MT ${byAoi.get('state:MT').join(',')} · ` +
    `WY ${byAoi.get('state:WY').join(',')} · ND ${byAoi.get('state:ND').join(',')})`);
  check(byAoi.get('state:WY')[0] === byAoi.get('state:ND')[0],
    'and two DIFFERENT areas do reuse dash 0 — that is the point, not a bug');

  check(anyRepeated(marks) === false, 'nothing repeated: four per area is the budget');

  /* Every mark carries its own id and area, so a caller never has to keep the
     Map's key and its value in step by hand. */
  check([...marks.entries()].every(([id, m]) => m.proposalId === id),
    'every mark carries the proposal id it is keyed by');
  check(Object.isFrozen(marks.get('mt-a')), 'and each mark is frozen');
}

/* ══ § 4 · the fifth proposal in one working area ═══════════════════════════ */
console.log('\n── § 4 · a fifth proposal repeats, and says so ────────────────');
{
  const session = [
    proposal('mt-a', 'state:MT'), proposal('mt-b', 'state:MT'),
    proposal('mt-c', 'state:MT'), proposal('mt-d', 'state:MT'),
    proposal('mt-e', 'state:MT'), proposal('wy-a', 'state:WY'),
  ];
  const marks = assignMarks(session);

  check(marks.get('mt-e').dash === 0, 'the fifth Montana proposal wears pattern 0 again');
  check(marks.get('mt-e').repeated === true, 'and is flagged `repeated`');
  check(marks.get('mt-a').repeated === false, 'the first one is not');
  check(marks.get('mt-e').letter === 'E',
    'the LETTER still separates them — which is why repeating is allowed at all');
  check(anyRepeated(marks) === true, 'anyRepeated() is the app\'s cue to toast, once');

  check(marks.get('wy-a').repeated === false,
    'a different working area is unaffected: the budget is per area');
}

/* ══ § 5 · determinism ══════════════════════════════════════════════════════
   A brief printed today says "B · Dana Reyes". Reloading the same session
   tomorrow has to agree, or the `?focus=` link in that brief opens a card
   naming somebody else. */
console.log('\n── § 5 · the same session assigns the same marks ──────────────');
{
  const build = () => [
    proposal('mt-a', 'state:MT'), proposal('wy-a', 'state:WY'),
    proposal('mt-b', 'state:MT'), proposal('mt-c', 'state:MT'),
  ];
  const dump = (m) => JSON.stringify([...m.entries()].map(([id, v]) => [id, v.letter, v.dash]));
  const first = dump(assignMarks(build()));
  const second = dump(assignMarks(build()));
  check(first === second, 'two runs over the same list are byte-identical');

  /* A Session rather than an array: js/app.js holds one, and the extra call
     site is not worth a second spelling of the same intent. */
  const list = build();
  const asSession = dump(assignMarks({ list: () => list }));
  check(asSession === first, 'a Session (anything with `list()`) gives the same answer');

  /* Malformed input must not take the module down: a package that parsed far
     enough to have an id but carries no AOI still gets a letter. */
  const odd = assignMarks([{ id: 'no-aoi-1' }, { id: 'no-aoi-2' }, null, { }]);
  check(odd.size === 2, 'an entry with no id is skipped rather than throwing');
  check(odd.get('no-aoi-1').aoiId === null && odd.get('no-aoi-1').dash === 0,
    'a proposal with no working area still gets a mark');
  check(odd.get('no-aoi-2').dash === 1,
    'and two of them share one bucket, so they are still tellable apart');

  check(assignMarks([]).size === 0, 'an empty session assigns nothing');
}

/* ══ § 6 · the map fixture ══════════════════════════════════════════════════ */
console.log('\n── § 6 · tools/fixtures/findings-map.json agrees ──────────────');
{
  const file = join(ROOT, 'tools/fixtures/findings-map.json');
  if (!existsSync(file)) {
    skip('tools/fixtures/findings-map.json is absent');
  } else {
    const fx = JSON.parse(readFileSync(file, 'utf8'));
    const marks = assignMarks(fx.proposals.map((p) => ({ id: p.id, aoi: { id: p.aoiId } })));
    let agreed = 0;
    for (const [id, want] of Object.entries(fx.expectedMarks)) {
      if (id.startsWith('$')) continue;
      const got = marks.get(id);
      if (got?.letter === want.letter && got?.dash === want.dash) { agreed++; continue; }
      bad(`${id} → expected ${want.letter}/${want.dash}, got ${got?.letter}/${got?.dash}`);
    }
    check(agreed === 3, `the fixture's three proposals get the marks it declares (${agreed}/3)`);

    /* The fixture's patches carry the mark and letter the map paints them
       with, so a drift here is a drift in what the smoke test asserts. */
    let patchesAgree = true;
    for (const patch of fx.patches) {
      const m = marks.get(patch.proposalId);
      if (m.dash !== patch.mark || m.letter !== patch.letter) patchesAgree = false;
    }
    check(patchesAgree, `all ${fx.patches.length} fixture patches carry their proposal's mark and letter`);
  }
}

/* ══ § 7 · the change-ramp step js/map.js keys its fill to ══════════════════
   `deltaFor` lives in js/map.js because that is the only thing that uses it,
   but it is pure, it is the number that decides which of NDMC's ten published
   colours a finding is painted, and it can be wrong without anything on screen
   looking wrong. So it is pinned here rather than nowhere. */
console.log('\n── § 7 · deltaFor — the signed step the fill is keyed to ──────');
{
  let deltaFor = null;
  try {
    ({ deltaFor } = await import(join(ROOT, 'js/map.js')));
  } catch (err) {
    skip(`js/map.js does not import under Node — ${err.message}`);
  }
  if (deltaFor) {
    const d = (published, classA, classB) => deltaFor({ published, classA, classB });

    check(d('D1', 'D0', 'D3') === 2,
      'published D1 · A improves to D0 · B degrades to D3 → +2, the FURTHEST departure');
    check(d('D2', 'D1', 'D2') === -1,
      'a one-sided improvement is the mover\'s own step (−1), not the quiet side\'s 0');
    check(d('D0', 'D0', 'D2') === 2, 'and a one-sided degradation likewise (+2)');
    check(d('D1', 'none', 'D1') === -2,
      '`none` is ordinal −1, so improving D1 away is a two-step improvement');
    check(d('none', 'D0', 'none') === 1,
      'and bringing drought-free ground in as D0 is +1');

    /* THE TIE. Published D1 with one side at D0 and the other at D2 departs
       equally in both directions; the ramp needs one number, and this takes
       the degradation. Recorded here so the choice is a decision rather than
       an accident of argument order. */
    check(d('D1', 'D0', 'D2') === 1, 'a symmetric disagreement breaks toward DEGRADATION');
    check(d('D1', 'D2', 'D0') === 1, 'and does so whichever way round the pair is handed in');

    check(d(null, 'D0', 'D2') === 0,
      'no published level → 0, which the fill matches to `transparent` rather than black');
    check(d('D2', 'D2', 'D2') === 0, 'and no disagreement is no colour');

    /* Every non-zero answer has to be a key NDMC's ramp actually carries, or
       the fill silently falls through to `transparent`. */
    const STEPS = new Set([5, 4, 3, 2, 1, -1, -2, -3, -4, -5]);
    const LEVELS = ['none', 'D0', 'D1', 'D2', 'D3', 'D4'];
    let inRamp = true;
    for (const p of LEVELS) {
      for (const a of LEVELS) {
        for (const b of LEVELS) {
          const step = d(p, a, b);
          if (step !== 0 && !STEPS.has(step)) inRamp = false;
        }
      }
    }
    check(inRamp, 'every level triple gives 0 or a step CHANGE_STEPS carries');
  }
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
