/* ══ Marks: the letter and the dash a proposal is known by ══════════════════
   USDM Edit Viewer · js/marks.js

   DOM-FREE AND PURE. No `window`, no `document`, no `fetch`, no turf, no
   colour. `tools/marks.test.mjs` greps this file's source text for all of it
   (the editor's § 14h pattern), so keep it that way: it is the one module the
   map and the legend and the brief all agree through, and a module three
   surfaces read has to be testable under Node in a millisecond.

   ── WHY TWO CHANNELS AND NEITHER OF THEM COLOUR ────────────────────────────
   Every colour on this map is already spoken for. The USDM class ramp is a
   published encoding that nothing may tint (CLAUDE.md), NDMC's change ramp owns
   the Differences view, and `--selection-ring` means "the thing you pointed
   at". There is no colour left to say "this outline is Marla Teigen's", and
   inventing one would be inventing a sixth meaning for a hue on a map that
   already diverges in the middle of two ramps.

   So a proposal is identified by SHAPE and by TEXT:

     · a DASH PATTERN on its patch outlines (`patches-line-0` … `-3`), and
     · a LETTER — A, B, C… — drawn at each patch's anchor and printed beside
       the author's name in the legend, the proposal list, the card title and
       every brief.

   The letter is the dash's text twin. A reader who cannot separate a dotted
   line from a dash-dot line at national zoom — which is most readers, most of
   the time — reads the letter instead, and a screen reader reads only the
   letter, because a WebGL canvas has nothing else to give it.

   ── WHY LETTERS ARE GLOBAL AND DASHES ARE PER-AOI ──────────────────────────
   Letters run A, B, C… in LOAD ORDER across the whole session: they appear in
   prose ("B · Dana Reyes"), in filenames and in briefs, so two proposals may
   never share one however far apart their ground is.

   The dash only has to separate outlines that can be confused on screen, and
   two proposals in different working areas never overlap — a Montana patch and
   a Wyoming patch are hundreds of kilometres apart. So the dash index cycles
   0–3 WITHIN an AOI. Four patterns cover four proposals per working area,
   which is already an unusual reconciliation; a FIFTH repeats pattern 0 and is
   marked `repeated: true`, which the app toasts once. It repeats rather than
   inventing a fifth pattern deliberately: the patterns past dash-dot are not
   tellable apart at any zoom this app uses, so a fifth would be a distinction
   that looks like one and is not. The letter still separates them, and the
   letter is the channel that was always going to do the work.

   ── THE TABLE ──────────────────────────────────────────────────────────────
   `line-dasharray` is in units of LINE WIDTH, so every pattern below is
   measured against 1.6 px — [2, 1.5] is a 3.2 px dash over a 2.4 px gap.

     dash  line-dasharray               legend swatch (border-top-style)
     ────  ───────────────────────────  ────────────────────────────────
     0     none (solid)                 solid
     1     [2, 1.5]                     dashed
     2     [0.2, 1.6], round caps       dotted
     3     [2.5, 1.2, 0.4, 1.2]         double

   The legend swatch is a CSS `border-top-style`, never a picture of the line:
   a 2 px `border-top: dotted` and a round-capped [0.2, 1.6] read the same at a
   glance, and the CSS version scales with the reader's font size. `double` is
   the honest stand-in for dash-dot — CSS has no dash-dot border — and the
   class names (`.mark-0` … `.mark-3`) are already in css/app.css § 4.

   `line-dasharray` IS NOT DATA-DRIVEN in MapLibre, which is why js/map.js
   carries four `patches-line-*` layers filtered on `mark` rather than one
   layer with an expression. Do not try to collapse them.
   ═══════════════════════════════════════════════════════════════════════════ */

/** How many dash patterns exist. A fifth proposal in one AOI wraps to 0. */
export const MARK_COUNT = 4;

/**
 * The four patterns, indexed by dash.
 *
 * `dasharray: null` is SOLID and means "omit the property" — MapLibre has no
 * dasharray value that means solid, and `[1]` is a dash of one width followed
 * by no gap, which renders solid but is a lie to anyone reading the style.
 *
 * `cap` is `'round'` for the dotted pattern alone: a 0.2-width dash with butt
 * caps is a sliver, not a dot.
 */
const PATTERNS = Object.freeze([
  Object.freeze({ dash: 0, dasharray: null, width: 1.6, cap: 'butt', swatch: 'solid' }),
  Object.freeze({ dash: 1, dasharray: Object.freeze([2, 1.5]), width: 1.6, cap: 'butt', swatch: 'dashed' }),
  Object.freeze({ dash: 2, dasharray: Object.freeze([0.2, 1.6]), width: 1.6, cap: 'round', swatch: 'dotted' }),
  Object.freeze({ dash: 3, dasharray: Object.freeze([2.5, 1.2, 0.4, 1.2]), width: 1.6, cap: 'butt', swatch: 'double' }),
]);

/**
 * The style one dash index paints as.
 *
 * Read by js/map.js (the four `patches-line-*` layers) and by js/panels.js
 * (the legend swatch, through `className`), so the two can never disagree
 * about which pattern belongs to which letter — the failure this module exists
 * to make impossible.
 *
 * Takes the INDEX or a whole `Mark`, because both callers have one to hand and
 * a caller who passes the wrong one gets a silently wrong swatch otherwise.
 *
 * @param {number|{dash:number}} mark
 * @returns {{dash:number, dasharray:number[]|null, width:number, cap:string,
 *            swatch:string, className:string}}
 */
export function markStyle(mark) {
  const i = typeof mark === 'number' ? mark : (mark?.dash ?? 0);
  const p = PATTERNS[((i % MARK_COUNT) + MARK_COUNT) % MARK_COUNT];
  return { ...p, dasharray: p.dasharray ? [...p.dasharray] : null, className: `mark-${p.dash}` };
}

/**
 * Every pattern, in order — for the legend's marks block and for tests.
 *
 * A fresh array of fresh objects each call: MapLibre keeps the arrays it is
 * handed as paint values, and a shared frozen dasharray handed to two layers is
 * a hazard for the price of nothing.
 */
export function markPatterns() {
  return PATTERNS.map((p) => markStyle(p.dash));
}

/**
 * Letters A…Z, then AA, AB… — bijective base 26.
 *
 * Twenty-seven proposals in one reconciliation is not a session anybody wants,
 * but a session that silently reuses the letter A because the twenty-seventh
 * file was dropped in is worse than one with a proposal called AA in it.
 *
 * @param {number} n zero-based
 */
export function letterFor(n) {
  let i = Math.max(0, Math.floor(n));
  let out = '';
  do {
    out = String.fromCharCode(65 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return out;
}

/**
 * Assign every proposal in the session its letter and its dash.
 *
 * DETERMINISTIC AND TOTAL: the answer depends on nothing but the order of the
 * list and each proposal's `aoi.id`. Two runs over the same session produce the
 * same map, which is what lets a brief say "B" and a reload agree.
 *
 * @param {Array|{list:Function}} proposals  the Session's `list()` — load
 *   order, which is the order that assigns letters. A whole Session is
 *   accepted too, because js/app.js holds one and the extra call site is not
 *   worth a second spelling of the same intent.
 * @returns {Map<string, {letter:string, dash:number, dasharray:number[]|null,
 *   proposalId:string, aoiId:string|null, repeated:boolean}>}
 *   keyed by `proposal.id` — docs/contracts.md § 10's `Mark`.
 */
export function assignMarks(proposals) {
  const list = Array.isArray(proposals)
    ? proposals
    : (typeof proposals?.list === 'function' ? proposals.list() : [...(proposals ?? [])]);

  const marks = new Map();
  /** How many proposals this AOI has already taken a dash for. */
  const usedPerAoi = new Map();

  list.forEach((p, i) => {
    if (!p?.id) return;
    const aoiId = p.aoi?.id ?? null;
    /* An AOI-less proposal (a malformed package that still parsed) shares one
       bucket keyed by the empty string rather than each getting dash 0: two
       broken proposals on top of each other should still be tellable apart. */
    const bucket = aoiId ?? '';
    const taken = usedPerAoi.get(bucket) ?? 0;
    usedPerAoi.set(bucket, taken + 1);

    const style = markStyle(taken % MARK_COUNT);
    marks.set(p.id, Object.freeze({
      letter: letterFor(i),
      dash: style.dash,
      dasharray: style.dasharray,
      proposalId: p.id,
      aoiId,
      /* The fifth proposal in one working area wears pattern 0 a second time.
         The caller says so ONCE — `repeated` is a fact about this mark, not a
         sentence, and two toasts in one turn means the first was never read. */
      repeated: taken >= MARK_COUNT,
    }));
  });

  return marks;
}

/**
 * Did any working area run out of patterns? The app's cue to toast, once.
 *
 * @param {Map} marks the return of `assignMarks`
 */
export function anyRepeated(marks) {
  for (const m of marks.values()) if (m.repeated) return true;
  return false;
}
