/* ══ USDM Edit Viewer · js/session.js ═════════════════════════════════════════
   The set of proposals on screen: ONE WEEK, one proposal per id, and the pairs
   worth comparing.

   DOM-free (docs/contracts.md § 3; tools/compare.test.mjs § 0 greps for it).

   ── ONE WEEK IS A DEFINITION, NOT A CONVENIENCE ────────────────────────────
   Every finding this app produces is "these two answers to the same ground
   disagree". Two proposals drawn against different weeks do not answer the
   same question, and every difference between them would be a week of real
   drought reported as a disagreement between two people. So a different week
   is REFUSED at the door, with a sentence naming both weeks and telling the
   reader what to do instead (load it in a session of its own). A re-issued
   copy of the SAME week is a different matter — the archive occasionally
   re-publishes one — and that is accepted with a warning, because the
   difference it can produce is a hairline along a shared edge rather than a
   week of weather.
   ========================================================================== */

import {
  T, asMulti, asFeature, indexParts, envelopeOf, bboxOverlaps, clipToExtent,
  areaKm2,
} from '../vendor/usdm-editor/js/topology.js';
import { parseProposal, withShortId, findingId } from './proposal.js';
import { rankRegions } from './compare.js';
import { rankSeams } from './seams.js';

/** Below this two working areas share a LINE, not ground — and a line is the
 *  seam engine's business (js/seams.js). Double-reporting a border as both a
 *  seam and a cross-AOI region is the failure this number prevents. */
const MIN_SHARED_GROUND_KM2 = 1;

/**
 * A package this session will not take, with a machine-readable `reason` and
 * the sentence a person is shown (docs/contracts.md § 15).
 */
export class SessionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SessionError';
    this.reason = reason;
  }
}

/**
 * @returns {{add, remove, list, byId, byAOI, week, groups, size}}
 */
export function createSession() {
  /** Load order, and load order is what assigns the letters (js/marks.js). */
  const order = [];
  const byId = new Map();
  let week = null;
  let groundCache = null;

  function invalidate() { groundCache = null; }

  function add(pkg, { fileName = null, sha256 = null, source = null } = {}) {
    const proposal = parseProposal(pkg, { fileName, sha256, source });
    const warnings = [];

    if (week && proposal.week !== week) {
      throw new SessionError('differentWeek',
        `That proposal was drawn against ${proposal.week}; this comparison is of ` +
        `${week} — load it in a session of its own.`);
    }

    const existing = byId.get(proposal.id);
    if (existing) {
      /* ONE PROPOSAL. The second `add` changes nothing and hands back what is
         already loaded, so a caller that drops the same file twice gets one
         row and one sentence rather than a duplicated comparison. */
      warnings.push({ reason: 'alreadyLoaded', sentence: 'That proposal is already loaded.' });
      return { proposal: existing, warnings };
    }

    if (order.length && proposal.baselineSha256
        && order[0].baselineSha256 && proposal.baselineSha256 !== order[0].baselineSha256) {
      warnings.push({
        reason: 'reissuedBaseline',
        sentence: `${proposal.author?.name ?? 'That author'}'s proposal was drawn against a ` +
          're-issued copy of the same week; it is loaded, and small differences along shared ' +
          'edges may be the baseline rather than the proposal.',
      });
    }

    week ??= proposal.week;
    const settled = settleShortIds(proposal, order);
    order.push(settled);
    for (const p of order) byId.set(p.id, p);
    invalidate();
    return { proposal: settled, warnings };
  }

  function remove(id) {
    const at = order.findIndex((p) => p.id === id);
    if (at < 0) return false;
    order.splice(at, 1);
    byId.delete(id);
    if (!order.length) week = null;
    invalidate();
    return true;
  }

  function byAOI() {
    const out = new Map();
    for (const p of order) {
      if (!out.has(p.aoi.id)) out.set(p.aoi.id, []);
      out.get(p.aoi.id).push(p);
    }
    return out;
  }

  function groups() {
    if (groundCache) return groundCache;
    const out = [];
    const areas = byAOI();

    /* Same working area: the group IS the working area, and every pair in it
       answers the whole of it. */
    for (const [aoiId, list] of areas) {
      if (list.length < 2) continue;
      out.push(Object.freeze({
        id: aoiId,
        aoiIds: Object.freeze([aoiId]),
        ground: list[0].aoi.geometry,
        proposals: Object.freeze([...list]),
        crossAoi: false,
      }));
    }

    /* Different working areas that OVERLAP IN GROUND — a tribal area lying
       inside a state is the case this exists for, and it falls out of the rule
       with nothing written for it. Two states share a line and no ground, and
       `MIN_SHARED_GROUND_KM2` is what keeps that out of here. */
    const ids = [...areas.keys()].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = areas.get(ids[i])[0].aoi, b = areas.get(ids[j])[0].aoi;
        const ground = sharedGround(a, b);
        if (!ground) continue;
        out.push(Object.freeze({
          id: `${ids[i]}×${ids[j]}`,
          aoiIds: Object.freeze([ids[i], ids[j]]),
          ground,
          proposals: Object.freeze([...areas.get(ids[i]), ...areas.get(ids[j])]),
          /* The within-AOI pairs of this group already have a group of their
             own above; comparing them again over a sliver of shared ground
             would mint a second set of findings for the same disagreement. */
          crossAoi: true,
        }));
      }
    }
    groundCache = Object.freeze(out);
    return groundCache;
  }

  return Object.freeze({
    add, remove, groups, byAOI,
    list: () => [...order],
    byId: (id) => byId.get(id) ?? null,
    week: () => week,
    get size() { return order.length; },
  });
}

/**
 * The ground two working areas share, or null when they only share a line.
 *
 * BOTH SIDES ARE CLIPPED TO THE ENVELOPE OVERLAP FIRST, and then the clipper
 * sees only what is left. That is `clipToAOI`'s own shape — the editor's one
 * sanctioned intersect, which opens with `clipToExtent` for exactly this
 * reason — and not a second exception to the naked-intersect rule: a naked
 * `turf.intersect` of two unsimplified state polygons is 171–1,758 ms, and
 * five loaded states make ten such pairs, six of whose envelopes overlap along
 * a corner. After the clip those six are a handful of vertices each.
 *
 * `envelopeOf(indexParts(...))` rather than the shipped `aoi.bbox` — the
 * Alaska rule (CLAUDE.md).
 */
function sharedGround(a, b) {
  const pa = indexParts(a.geometry), pb = indexParts(b.geometry);
  const ea = envelopeOf(pa), eb = envelopeOf(pb);
  if (!ea || !eb || !bboxOverlaps(ea, eb)) return null;
  const box = [Math.max(ea[0], eb[0]), Math.max(ea[1], eb[1]),
    Math.min(ea[2], eb[2]), Math.min(ea[3], eb[3])];
  const ca = clipToExtent(pa, box), cb = clipToExtent(pb, box);
  if (!ca || !cb) return null;
  const turf = T();
  let both = null;
  try {
    both = asMulti(turf.intersect(turf.featureCollection([asFeature(ca), asFeature(cb)])));
  } catch {
    /* Two jurisdiction rings that trace the same river can throw inside the
       clipper. A pair this app cannot measure is a pair it does not group —
       the seam engine still has the border. */
    return null;
  }
  if (!both) return null;
  return areaKm2(both) >= MIN_SHARED_GROUND_KM2 ? both : null;
}

/**
 * `shortId` is eight hex of the package id, WIDENED TO TWELVE when two
 * proposals in one session share their first eight (docs/contracts.md § 8,
 * decision 3).
 *
 * Both sides are widened, not just the newcomer: `?pick=` and `?show=` name a
 * proposal by this string, and a session where one id is 8 and its twin is 12
 * is a session where the 8 is ambiguous.
 */
function settleShortIds(incoming, order) {
  const clash = order.filter((p) => p.shortId === incoming.shortId);
  if (!clash.length) return incoming;
  for (let i = 0; i < order.length; i++) {
    if (order[i].shortId === incoming.shortId) order[i] = withShortId(order[i], order[i].id.slice(0, 12));
  }
  return withShortId(incoming, incoming.id.slice(0, 12));
}

/* ── the findings list ────────────────────────────────────────────────────── */

/**
 * Regions and seams as ONE ranked list — and the ranking is a CONCATENATION,
 * deliberately.
 *
 * The three kinds ask a reviewer different questions and are not commensurable:
 * a conflict is two people answering the same ground differently and is what a
 * reconciliation meeting exists to settle; a one-sided difference is usually
 * two people working different parts of a state; a seam is a step at a
 * jurisdiction line, and its size is a LENGTH, not an area. Interleaving them
 * by any single number buries every conflict in Montana under a 600 km border
 * — which is exactly what a merged rank by `areaKm2` or by class step would
 * do, since a seam has no area and a two-class seam step outranks every
 * one-class conflict.
 *
 * So: conflicts, then one-sided, then seams, each in its own total order
 * (`rankRegions`, `rankSeams`). That is also the order the drawer's three
 * `<details>` groups are in, so the list and its text twin cannot disagree.
 *
 * @param {object[]} regions
 * @param {object[]} seams
 * @returns {object[]} findings, ranked; feed it straight to `resolveFindingIds`
 */
export function rankFindings(regions, seams) {
  return [...rankRegions(regions), ...rankSeams(seams)];
}

/* ── finding ids ──────────────────────────────────────────────────────────── */

/** A widened finding id, in hex digits — docs/contracts.md § 8, and the same
 *  number a colliding `shortId` widens to, for the same reason. */
const WIDE_ID_HEX = 12;

/**
 * Resolve id collisions across a whole session's findings — docs/contracts.md
 * § 8.
 *
 * THE SUFFIX THIS REPLACED WAS ASSIGNED BY RANK, and that was the bug. Every
 * key now names the proposal pair that produced the finding (js/compare.js
 * `makeRegion`, js/seams.js `stampSeam`), so two different findings can no
 * longer hash equal by construction — the ground three proposals answer the
 * same way is three findings with three keys — and the only collision left is
 * a TRUE hash collision between two unrelated keys, which has never occurred
 * on this corpus. A `-2` for that case was deterministic only in rank order,
 * which is not stable across load order: the one property `?focus=` exists
 * for.
 *
 * So a collision WIDENS BOTH SIDES to twelve hex, which is exactly the rule
 * this file already applies to a colliding `shortId` (`settleShortIds`) and
 * for the same reason: a session where one id is 8 and its twin is 12 is a
 * session where the 8 is ambiguous. A widened id is computed from the
 * finding's own `key` and from nothing else, so it depends on neither rank nor
 * load order — only on the SET of keys, which is the same set whatever order
 * the files arrived in.
 *
 * **IDEMPOTENT**: a second pass sees a list whose ids are already distinct and
 * hands every finding back untouched, which is what lets js/app.js run it over
 * the whole findings list on every recompute without tracking whether it
 * already has.
 *
 * @param {object[]} findings  ranked, regions before seams (`rankFindings`)
 * @returns {object[]} the same objects, with colliding ones replaced by frozen
 *          copies carrying the widened id
 */
export function resolveFindingIds(findings) {
  const counts = new Map();
  for (const f of findings) counts.set(f?.id, (counts.get(f?.id) ?? 0) + 1);
  let clashes = 0;
  for (const n of counts.values()) if (n > 1) clashes++;
  if (!clashes) return findings;
  return findings.map((f) => {
    /* A finding with no readable key cannot be widened from one; it is left as
       it stands rather than given a rank-dependent name. Every finding this
       app builds carries its key verbatim (docs/contracts.md § 8). */
    if (counts.get(f?.id) === 1 || !f?.key || !f?.id) return f;
    const prefix = String(f.id).split(':')[0];
    return Object.freeze({ ...f, id: findingId(prefix, f.key, WIDE_ID_HEX) });
  });
}
