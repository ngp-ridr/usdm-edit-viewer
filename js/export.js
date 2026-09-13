/* ============================================================================
   USDM Edit Viewer · js/export.js
   Getting a brief OUT of the browser: a file, the clipboard, and the link that
   opens the same finding again. docs/contracts.md § 11.

     import { downloadBrief, copyBrief, downloadSessionBrief,
              briefFilename, linkTo } from './export.js';

   ── WHY THIS IS A MODULE AND NOT FOUR LINES IN THE CARD ────────────────────
   The brief is the POINT of this tool. Everything else is a way of finding the
   disagreement; the markdown is the thing two reviewers actually talk from, and
   it leaves the browser by three routes that must agree about what they are
   sending and what it is called. A filename invented at each call site is a
   filename that eventually disagrees with the link inside the file.

   This module knows nothing about how a brief is WRITTEN — that is
   `js/brief.js` (WP-E), reached through `ctx.brief(finding)`. It knows how a
   string becomes a download, a clipboard entry and a url.

   ── THE LINK IS THE SHARE ──────────────────────────────────────────────────
   There is no Share button in this app: the address bar is the share. So
   `linkTo` preserves every parameter the reader currently has set — the view,
   the pick, the theme — and replaces only `?focus=`. A brief that linked back
   to a default view would drop the reader somewhere they have never been.

   Local files are the exception, and the session line says so: a `?load=`-less
   session cannot be reconstituted from a url, which is precisely why the brief
   carries both authors' reasoning in full.

   ── ONE TOAST PER TURN ─────────────────────────────────────────────────────
   The kit's `showToast()` is a singleton. Every function here sends AT MOST
   ONE sentence, and the clipboard's failure path sends the sentence for what it
   did INSTEAD rather than one for the failure and one for the fallback.
   ========================================================================== */

import { saveFile } from '../vendor/usdm-editor/js/dom.js';

/* ── names and links ──────────────────────────────────────────────────────── */

/** Anything that is not safe in a filename becomes a hyphen, once. */
function slug(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `'state:MT'` → `'MT'`; `'aiannh:01263144-86'` → `'01263144-86'`. */
function areaKey(aoiId) {
  const s = String(aoiId ?? '');
  const i = s.indexOf(':');
  return slug(i < 0 ? s : s.slice(i + 1));
}

/** `'disc:1a2b3c4d'` → `'1a2b3c4d'`; a `-2` collision suffix is kept. */
function idKey(id) {
  const s = String(id ?? '');
  const i = s.indexOf(':');
  return slug(i < 0 ? s : s.slice(i + 1));
}

/**
 * `usdm-brief-2026-09-08-MT-conflict-1a2b3c4d.md`
 *
 * Week, then place, then kind, then the finding's own id — so a folder of them
 * sorts by week and groups by state, and the last field is the one that pastes
 * into `?focus=`. A seam names both its areas: `SD-NE`.
 *
 * @param {object} finding a Region (§ 4) or a Seam (§ 5)
 * @param {{week?: string}} [opts] the session week; findings do not carry one
 */
export function briefFilename(finding, { week } = {}) {
  const area = finding?.kind === 'seam'
    ? (finding.aoiIds ?? []).map(areaKey).filter(Boolean).join('-')
    : areaKey(finding?.aoiId);
  const parts = ['usdm-brief', slug(week), area, slug(finding?.kind), idKey(finding?.id)];
  return `${parts.filter(Boolean).join('-')}.md`;
}

/** `usdm-briefs-2026-09-08.md` — every finding in one file. */
export function sessionBriefFilename({ week } = {}) {
  return `usdm-briefs${week ? `-${slug(week)}` : ''}.md`;
}

/**
 * The url that reopens this finding.
 *
 * Built on the CURRENT address when there is one, so the view, the pick and the
 * theme travel with it; `?focus=` is replaced rather than appended, because a
 * brief downloaded from a focused view would otherwise carry two.
 *
 * @param {object|string} finding a finding, or a bare id
 * @param {{viewerUrl?: string, url?: string}} [opts]
 */
export function linkTo(finding, { viewerUrl, url } = {}) {
  const id = typeof finding === 'string' ? finding : finding?.id;
  const here = url
    ?? (typeof location !== 'undefined' ? location.href : null)
    ?? viewerUrl ?? '';
  let u;
  try {
    u = new URL(here);
  } catch {
    return id ? `${viewerUrl ?? ''}?focus=${encodeURIComponent(id)}` : String(viewerUrl ?? '');
  }
  u.searchParams.delete('focus');
  if (id) u.searchParams.set('focus', id);
  return u.toString();
}

/* ── getting it out ───────────────────────────────────────────────────────── */

/** The markdown for a finding, from whichever route the caller has. */
function markdownFor(finding, opts) {
  if (typeof opts?.markdown === 'string') return opts.markdown;
  if (typeof opts?.brief === 'function') return opts.brief(finding);
  if (typeof opts?.ctx?.brief === 'function') return opts.ctx.brief(finding);
  return null;
}

function sayWith(opts, sentence) {
  const say = opts?.say ?? opts?.ctx?.say;
  if (typeof say === 'function') say(sentence);
}

function weekOf(opts) {
  return opts?.week ?? opts?.ctx?.week ?? null;
}

/**
 * Save one finding's brief as a `.md` file.
 *
 * @param {object} finding
 * @param {{ctx?: object, markdown?: string, brief?: Function, week?: string,
 *          say?: Function}} [opts]
 * @returns {string|null} the filename, or null when there was nothing to write
 */
export function downloadBrief(finding, opts = {}) {
  const md = markdownFor(finding, opts);
  if (!md) { sayWith(opts, 'That brief could not be built.'); return null; }
  const name = briefFilename(finding, { week: weekOf(opts) });
  /* `text/markdown` with an explicit charset: the briefs carry en dashes, `·`
     and the degree sign, and a reader that guesses latin-1 mangles all three. */
  saveFile(new Blob([md], { type: 'text/markdown;charset=utf-8' }), name);
  sayWith(opts, `Brief downloaded as ${name}.`);
  return name;
}

/** Every finding in one file. Same routes, one filename. */
export function downloadSessionBrief(opts = {}) {
  const md = typeof opts?.markdown === 'string'
    ? opts.markdown
    : (typeof opts?.ctx?.sessionBrief === 'function' ? opts.ctx.sessionBrief() : null);
  if (!md) { sayWith(opts, 'There is nothing to write a brief about yet.'); return null; }
  const name = sessionBriefFilename({ week: weekOf(opts) });
  saveFile(new Blob([md], { type: 'text/markdown;charset=utf-8' }), name);
  sayWith(opts, `Every finding downloaded as ${name}.`);
  return name;
}

/**
 * Put one finding's brief on the clipboard.
 *
 * The clipboard is not always there — an insecure origin, a browser that
 * refuses without a user gesture it recognises, a permission denied — and the
 * answer to that is not an apology. It is the file, with ONE sentence saying
 * what happened instead: the reader wanted the text out of the browser, and
 * both routes do that.
 *
 * @returns {Promise<boolean>} true when the clipboard took it
 */
export async function copyBrief(finding, opts = {}) {
  const md = markdownFor(finding, opts);
  if (!md) { sayWith(opts, 'That brief could not be built.'); return false; }
  try {
    if (!navigator?.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(md);
    sayWith(opts, 'Brief copied to the clipboard.');
    return true;
  } catch {
    const name = briefFilename(finding, { week: weekOf(opts) });
    saveFile(new Blob([md], { type: 'text/markdown;charset=utf-8' }), name);
    sayWith(opts, `The clipboard is not available here, so the brief was downloaded as ${name}.`);
    return false;
  }
}
