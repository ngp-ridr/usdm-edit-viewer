/* ============================================================================
   USDM Editor · js/mdtext.js
   A markdown field: WYSIWYG surface (Squire), source view, formatting toolbar,
   and the sanitizer everything user-typed passes through.

   ── Markdown in, markdown out ──────────────────────────────────────────────
   The stored value is ALWAYS the markdown string. The textarea keeps the field
   `id` (js/justify.js's richText seam, js/changes-panel.js rows, the harness
   all read it), `err-<id>` is the error slot, and in Write mode the textarea
   mirrors Squire's serialization. See CLAUDE.md (Squire bullet).

   ── Threat model — this is a contract ──────────────────────────────────────
   vendor/style/ui/help.js renders markdown UNSANITIZED (kit AGENTS.md §12) and
   is only for repo-reviewed copy. Content HERE arrives from a keyboard, round-
   trips through localStorage drafts and exported proposal JSON, and comes BACK
   IN from emailed files — the two pathways must never share a renderer.

   ALLOWLIST, never a blocklist: a fixed element set, XHTML namespace only, NO
   attributes except a protocol-checked `href` on <a>; anything unrecognised is
   unwrapped to its contents, so a parser change cannot add a capability. The
   same allowlist is Squire's `sanitizeToDOMFragment`, so setHTML/insertHTML/
   paste pass the one gate (Squire's stock hook calls a global DOMPurify this
   app does not ship — left alone it throws on first paste; vendor/VENDORED.md).

   CSP is the SECOND lock, not armour: `script-src 'self'` blocks handlers and
   javascript: URLs but not injected iframes, overlays, fake forms or anchors.
   Two layers: (1) marked's raw-HTML tokens are escaped to text (NOTE-RAW-HTML
   below); (2) marked's output is re-parsed inert and rebuilt node by node
   through ALLOWED. Neither layer has to be perfect alone.

   Known non-bug: sanitizeMarkdownHTML() called directly on HTML carrying
   `style="…"` prints a style-src CSP violation per occurrence — the browser
   refusing the style DURING PARSE (DOMParser, createHTMLDocument and a detached
   <template> all report it; measured). Unreachable via renderMarkdown, which
   escapes raw HTML first; do not regex `style` out to silence it.

   NOT a document editor: Squire's five style-writing methods (setFontFace,
   setFontSize, setTextColour, setHighlightColour, setTextAlignment) are never
   wired — each produces what the markdown round trip cannot carry and the
   allowlist would drop. See CLAUDE.md.

   IMAGES travel as `![alt](data:image/…;base64,…)` — js/image.js downscales
   the file and the ONE gate (`isImageDataURL`) is applied in `cleanInto`, so a
   remote or malformed src is refused whichever way it arrives (setHTML, paste,
   insertHTML, the toolbar). Insertion goes through `insertHTML`, never
   Squire's `insertImage`, so nothing bypasses that gate. Squire arms an image
   RESIZER on a click whose target is an <img> (handles it positions with
   `style` attributes the CSP drops; a drag writes `img.style.width`, which the
   round trip cannot carry) — css/app.css § 10 gives `.md-rich img`
   `pointer-events: none`, so no click ever reaches an image and it never arms.
   ========================================================================== */

import { marked, Renderer } from '../vendor/style/vendor-esm/marked-18.0.10/marked.esm.js';
import { el } from './dom.js';
import { IMAGE_MIME, isImageDataURL, readImageFile } from './image.js';

/**
 * The rich surface, loaded LAZILY and FORGIVINGLY: a vendor 404 must degrade
 * this field (no Write button; source + preview carry on), not fail the module
 * graph and take the wizard down. Relative path, not a bare specifier, so the
 * import map and its CSP hashes are untouched.
 */
const squireP = import('../vendor/squire-rte-2.4.8/squire.mjs')
  .then((m) => m.default)
  .catch(() => null);

/* ── 1. Rendering ─────────────────────────────────────────────────────────── */

/** GFM for tables, and passed PER PARSE — never marked.setOptions(). The kit's
 *  help.js makes the same choice for the same reason: this module must not
 *  mutate global marked state for anything else on the page. */
const GFM = true;

/**
 * NOTE-RAW-HTML — a decision, not an accident. Raw HTML in the markdown source
 * is escaped to TEXT entirely: type `<b>hi</b>`, see `<b>hi</b>`. The allowlist
 * cannot do this job — it runs on marked's OUTPUT, where a markdown link and a
 * hand-typed `<a>` are indistinguishable, so it would have to keep both (and
 * promise hand-written HTML as an authoring surface forever) or drop both.
 * Costs nothing: every allowed element already has markdown syntax.
 */
function escapingRenderer() {
  const r = new Renderer();
  r.html = (token) => (token.block
    ? `<p>${escapeText(token.text)}</p>\n`
    : escapeText(token.text));
  return r;
}

/** Text → HTML-safe text. Ampersand first, or the other replacements get
 *  double-escaped into visible entity names. */
function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Markdown → a sanitized DocumentFragment, ready for `replaceChildren`.
 * @param {string} md raw markdown, as typed
 * @returns {DocumentFragment}
 */
export function renderMarkdown(md) {
  if (typeof md !== 'string' || md.trim() === '') return document.createDocumentFragment();
  let html;
  try {
    html = marked.parse(md, { gfm: GFM, renderer: escapingRenderer() });
  } catch {
    /* A parse failure must not blank the preview or throw into a keystroke
       handler. Fall back to showing the source, escaped. */
    html = `<pre><code>${escapeText(md)}</code></pre>`;
  }
  return sanitizeMarkdownHTML(html);
}

/* ── 2. The sanitizer, and its inverse ────────────────────────────────────── */

/** Elements that may exist in the output; nothing else ever will. Absences are
 *  deliberate: no input (GFM task lists render as plain bullets), no
 *  caption/colgroup, no details/summary, nothing carrying class/id/style.
 *  `img` is in, with exactly two attributes — a `src` that must be a base64
 *  data URI of an allowed raster type (js/image.js `isImageDataURL`) and a
 *  whitespace-collapsed `alt`; a refused image keeps its alt as text. Adding
 *  a name here is a security decision. `b`/`i` are in because Squire's bold()/italic() author
 *  them natively — presentational synonyms of strong/em, the only kind of
 *  addition that is not a new capability.
 *
 *  KEEP THIS TABLE AND `toMarkdown` BELOW IN STEP: this set is what may EXIST,
 *  toMarkdown is how each member is spelled back. A name added here with no
 *  case there is silently unwrapped on the round trip. */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'em', 'strong', 'b', 'i', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
]);

/** HTML elements only. An `<a>` inside `<svg>` has localName 'a' too, and it
 *  takes `href`/`xlink:href` — matching on the name alone would hand a
 *  namespace-confusion bypass straight through the allowlist. */
const XHTML = 'http://www.w3.org/1999/xhtml';

/** The only attribute that survives, and only on `<a>`. */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** A base that can never resolve (RFC 2606 reserves `.invalid`), so a relative
 *  href is detectable by the origin it lands on rather than by a regex. */
const LINK_BASE = 'https://x.invalid/';
/** Derived, never re-typed: the two drifting apart would silently turn the
 *  relative-href check off and nothing would fail. */
const LINK_BASE_ORIGIN = new URL(LINK_BASE).origin;

/**
 * The protocol gate. The WHATWG URL parser does the hard part: it is the same
 * parser the browser navigates with, so the two cannot disagree, and it
 * defeats the tab/newline/whitespace tricks that beat a
 * `startsWith('javascript:')` check (`java\tscript:alert(1)` parses to
 * protocol `javascript:` and is refused). Relative hrefs are refused too —
 * they resolve against this origin, meaningless in exported JSON; same
 * contract js/justify.js states for evidence links.
 *
 * @returns {string|null} the parser's own serialization, or null to refuse.
 */
function safeHref(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw, LINK_BASE); } catch { return null; }
  if (!LINK_PROTOCOLS.has(u.protocol)) return null;
  if (u.origin === LINK_BASE_ORIGIN) return null;      // was relative
  return u.href;
}

/**
 * HTML string → a clean DocumentFragment. Exported so hostile input can be
 * tested directly, and wired to Squire's `sanitizeToDOMFragment` — which is
 * why the fragment must belong to THIS document: every node is built with the
 * page's own `document`, so nothing from the parsed document is ever adopted
 * (no importNode step). The parse is DOMParser 'text/html', an INERT document:
 * scripts do not run, <img> does not fetch, no handler is wired.
 *
 * BOTH head and body are walked, in that order: the HTML parser routes a
 * leading <script>/<style>/<title>/<meta>/<link> into HEAD, so walking body
 * alone eats `<script>alert(1)</script>` silently instead of leaving the text
 * `alert(1)` — a real first-draft bug only the direct-HTML probe caught.
 *
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function sanitizeMarkdownHTML(html) {
  const out = document.createDocumentFragment();
  if (typeof html !== 'string' || html === '') return out;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  cleanInto(doc.head, out);
  cleanInto(doc.body, out);
  return out;
}

/**
 * The walk. Copies `src`'s children into `dest`, one node at a time.
 *
 * An unrecognised element is UNWRAPPED, not deleted: its children are walked
 * into the parent, so `<script>alert(1)</script>` leaves the text `alert(1)`
 * behind and `<div><strong>hi</strong></div>` leaves the `<strong>`. Deleting
 * instead would make a stray `<div>` eat a paragraph of someone's rationale
 * without saying so, which is a worse failure than showing them their own
 * words. `<template>` is the one element that loses its contents, because the
 * parser puts them in `.content` rather than in childNodes — and that is the
 * safe direction to fail.
 */
function cleanInto(src, dest) {
  for (const node of src.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.data) dest.append(node.data);
      continue;
    }
    /* Comments, CDATA, processing instructions, doctypes: dropped outright.
       A comment carries no text the reader was shown, and `<!--[if IE]>` style
       conditional content is exactly the kind of parser-differential trick the
       allowlist exists to refuse. */
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const name = node.localName?.toLowerCase();
    if (node.namespaceURI !== XHTML || !ALLOWED.has(name)) {
      cleanInto(node, dest);
      continue;
    }

    const clean = document.createElement(name);
    if (name === 'a') {
      const href = safeHref(node.getAttribute('href'));
      /* A refused link is not a broken link — it is not a link. Demote the
         anchor to its own contents so the author still sees their text. */
      if (!href) { cleanInto(node, dest); continue; }
      clean.setAttribute('href', href);
      /* Every kept link leaves the app. `noopener` severs window.opener so the
         target cannot navigate this tab; `noreferrer` keeps the proposal the
         author is drafting out of a third party's referer log. */
      clean.setAttribute('rel', 'noopener noreferrer');
      clean.setAttribute('target', '_blank');
    }
    if (name === 'img') {
      /* The one gate for every entry path. `https:` is refused on purpose: the
         page's `img-src` would not render it, and an emailed proposal that
         fetches from a third party is a beacon. The alt survives as text so a
         refused image never costs the author a word. */
      const src = (node.getAttribute('src') ?? '').trim();
      const alt = (node.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
      if (!isImageDataURL(src)) { if (alt) dest.append(alt); continue; }
      clean.setAttribute('src', src);
      clean.setAttribute('alt', alt);
      dest.append(clean);
      continue;
    }
    cleanInto(node, clean);
    dest.append(clean);
  }
}

/* ── 2b. toMarkdown — the inverse of ALLOWED ──────────────────────────────────
   The other half of the table above, kept in this file so the two are read
   together: every name in ALLOWED has a case below, or the round trip silently
   eats it. Governing rule, same as cleanInto's: AN UNKNOWN ELEMENT IS RECURSED
   INTO, NEVER DROPPED — the worst this may cost is a mark, never a sentence.
   Deliberately NOT a general HTML-to-markdown converter: it inverts exactly
   the set the rich surface can hold. */

/** Which markdown marker each inline element becomes. `b`/`strong` and
 *  `i`/`em` are synonyms here because they are synonyms in the allowlist —
 *  marked renders `<strong>`, Squire authors `<b>`, and the author meant the
 *  same thing both times. */
const INLINE_WRAP = Object.freeze({
  strong: '**', b: '**', em: '*', i: '*', del: '~~',
});

/** Block-level names, for deciding whether a run of children is a paragraph or
 *  a sequence of blocks. Includes names the allowlist refuses — `div` and
 *  friends can still be in the LIVE contenteditable, which is what this reads. */
const BLOCKISH = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'figure', 'figcaption', 'form', 'fieldset', 'dl', 'dt', 'dd',
]);

/** True for an element that is a block, or that merely CONTAINS one — an
 *  unknown wrapper around a `<ul>` has to be treated as blocks, or the list
 *  gets flattened into a paragraph. */
function isBlockish(n) {
  if (n.nodeType !== Node.ELEMENT_NODE) return false;
  if (BLOCKISH.has(n.localName?.toLowerCase())) return true;
  for (const k of n.childNodes) if (isBlockish(k)) return true;
  return false;
}

/**
 * A DOM subtree → the markdown that would produce it.
 *
 * @param {Element|DocumentFragment} root
 * @returns {string}
 */
export function toMarkdown(root) {
  if (!root) return '';
  return blocksOf(root, 0).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The block walk: returns one string per block, so the caller joins with the
 *  blank line that separates them. */
function blocksOf(parent, depth) {
  const out = [];
  let run = [];
  const flush = () => {
    const t = inlineOf(run).replace(/[ \t]+$/gm, '').trim();
    run = [];
    if (t) out.push(escapeLeading(t));
  };
  for (const n of parent.childNodes) {
    if (isBlockish(n)) { flush(); out.push(...blockOf(n, depth)); }
    else run.push(n);
  }
  flush();
  return out.filter(Boolean);
}

/** One block element → zero or more markdown blocks. */
function blockOf(node, depth) {
  const name = node.localName?.toLowerCase();
  switch (name) {
    case 'p': {
      const t = inlineOf(node.childNodes).trim();
      return t ? [escapeLeading(t)] : [];
    }
    case 'h1': case 'h2': case 'h3':
    case 'h4': case 'h5': case 'h6': {
      const t = inlineOf(node.childNodes).trim();
      return t ? [`${'#'.repeat(Number(name[1]))} ${t}`] : [];
    }
    case 'hr': return ['---'];
    case 'pre': {
      const code = node.querySelector('code') ?? node;
      return [fenced(code.textContent ?? '')];
    }
    case 'blockquote': {
      const inner = blocksOf(node, depth).join('\n\n');
      if (!inner) return [];
      return [inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')];
    }
    case 'ul': case 'ol': {
      const t = listOf(node, name === 'ol', depth);
      return t ? [t] : [];
    }
    case 'table': {
      const t = tableOf(node);
      return t ? [t] : [];
    }
    /* Unknown, or a block reached out of its usual parent (a stray <li>, a
       <td> without its table). Recurse — never drop. */
    default: return blocksOf(node, depth);
  }
}

/** A list, nested by depth. Two spaces per level, which is what marked reads
 *  back as a sublist for both markers. */
function listOf(list, ordered, depth) {
  const pad = '  '.repeat(depth);
  const lines = [];
  let n = 0;
  for (const li of list.children) {
    if (li.localName?.toLowerCase() !== 'li') continue;
    n += 1;
    const marker = ordered ? `${n}. ` : '- ';
    /* A list item splits into the text of the item and any list nested under
       it. Everything that is not a nested list is serialized INLINE, so an
       `<li><p>text</p></li>` — which is what Squire builds — does not become a
       paragraph break in the middle of a bullet. */
    const lead = [];
    const nested = [];
    for (const k of li.childNodes) {
      const kn = k.nodeType === Node.ELEMENT_NODE ? k.localName?.toLowerCase() : '';
      if (kn === 'ul' || kn === 'ol') nested.push(k);
      else lead.push(k);
    }
    const text = inlineOf(lead).trim().replace(/\n+/g, ' ');
    lines.push(`${pad}${marker}${text}`);
    for (const sub of nested) {
      const t = listOf(sub, sub.localName.toLowerCase() === 'ol', depth + 1);
      if (t) lines.push(t);
    }
  }
  return lines.join('\n');
}

/** A GFM table: pipe rows plus the header rule marked needs to read it back. */
function tableOf(table) {
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [];
    for (const c of tr.children) {
      const cn = c.localName?.toLowerCase();
      if (cn !== 'td' && cn !== 'th') continue;
      cells.push(inlineOf(c.childNodes).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|'));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const head = pad(rows[0]);
  return [
    line(head),
    line(head.map(() => '---')),
    ...rows.slice(1).map((r) => line(pad(r))),
  ].join('\n');
}

/** The inline walk, over a LIST of nodes rather than a parent, so a run of
 *  bare inline children can be serialized without inventing a wrapper. */
function inlineOf(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE) { out += escapeInline(collapse(n.data)); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const name = n.localName?.toLowerCase();

    if (name === 'br') { out += '  \n'; continue; }
    if (name === 'code') { out += codeSpan(n.textContent ?? ''); continue; }
    if (name === 'a') {
      const body = inlineOf(n.childNodes).trim();
      const href = n.getAttribute('href');
      /* An anchor with no usable href is not a link; keep the words. */
      out += href ? `[${body || href}](${href})` : body;
      continue;
    }
    if (name === 'img') {
      /* The inverse of `cleanInto`'s img case: `![alt](src)`. The alt is
         escaped like any inline text; the src is a data URI with no `)` in
         base64, so it needs nothing. An <img> with no src is nothing. */
      const src = n.getAttribute('src');
      if (src) out += `![${escapeInline(collapse(n.getAttribute('alt') ?? ''))}](${src})`;
      continue;
    }
    const mark = INLINE_WRAP[name];
    if (mark) {
      const body = inlineOf(n.childNodes);
      /* Markers need something to attach to: `** **` is literal asterisks in
         CommonMark, not empty bold. Emit the whitespace and skip the mark. */
      out += body.trim() ? wrapTight(body, mark) : body;
      continue;
    }
    /* Unknown inline element — and any block that turned up in inline
       position. Recurse into the children; never drop the text. */
    out += inlineOf(n.childNodes);
  }
  return out;
}

/** Put the markers TIGHT against the text, keeping any surrounding spaces
 *  outside them. `**text **` does not close in CommonMark; ` **text** ` does. */
function wrapTight(body, mark) {
  const [, pre, core, post] = /^(\s*)([\s\S]*?)(\s*)$/.exec(body);
  return `${pre}${mark}${core}${mark}${post}`;
}

/** HTML collapses runs of whitespace, so the markdown should too — otherwise
 *  every re-render of the rich view grows the source by the newlines the
 *  serializer put in it. Non-breaking spaces (Squire leans on them) and the
 *  zero-width spaces it uses as carets become ordinary text. */
function collapse(s) {
  return String(s ?? '')
    .replace(/\u200B/g, '')      // Squire's zero-width caret markers
    .replace(/\u00A0/g, ' ')     // non-breaking spaces, back to ordinary ones
    .replace(/[\t\r\n ]+/g, ' ');
}

/**
 * Inline escaping, kept deliberately SMALL.
 *
 * Only the characters that genuinely start a construct mid-line, and only
 * those: backslash, backtick, asterisk and the two bracket characters. `_` is
 * left alone on purpose — intraword underscores are not emphasis in CommonMark
 * and escaping them turns every `soil_moisture` in a rationale into
 * `soil\_moisture`, which the author then SEES in the source view. This field
 * round-trips prose, not code, and a stray literal asterisk rendering as
 * emphasis is a smaller harm than backslashes appearing in someone's writing.
 */
function escapeInline(s) {
  return String(s).replace(/([\\`*[\]])/g, '\\$1');
}

/** Line-start markers only matter at a line start, so they are escaped there
 *  rather than everywhere — a hyphen mid-sentence is a hyphen. */
function escapeLeading(s) {
  return s.split('\n')
    .map((l) => l.replace(/^(\s*)([#>+-]|\d+\.)(\s)/, '$1\\$2$3'))
    .join('\n');
}

/** A fenced block, with a fence long enough to survive backticks inside it. */
function fenced(text) {
  const body = String(text ?? '').replace(/\n+$/, '');
  let fence = '```';
  while (new RegExp(`^${fence}`, 'm').test(body)) fence += '`';
  return `${fence}\n${body}\n${fence}`;
}

/** A code span, with a delimiter long enough to survive backticks inside it
 *  and the padding space CommonMark needs when the text starts or ends in one. */
function codeSpan(text) {
  const body = collapse(text);
  if (!body) return '';
  let ticks = '`';
  while (body.includes(ticks)) ticks += '`';
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${body}${pad}${ticks}`;
}

/* ── 3. The widget ────────────────────────────────────────────────────────── */

/** Toolbar actions, in order — the same five everywhere (a compact field is
 *  a shorter BOX, not a shorter toolbar: the docked card's rows lost their
 *  lists for width and the author asked for them back), plus Image where the
 *  field was opened with `allowImages` (the larger editor; js/md-modal.js).
 *  Text glyphs, not emoji or SVG, matching the app's status marks (✓ ✕ ! i ⚠
 *  in css/app.css § 5); Link and Image keep the whole WORD — no conventional
 *  glyph exists, and it keeps visible text identical to the accessible name
 *  (WCAG 2.5.3, Label in Name). */
const TOOLS = Object.freeze([
  { key: 'bold',   glyph: 'B',     label: 'Bold' },
  { key: 'italic', glyph: 'I',     label: 'Italic' },
  { key: 'ul',     glyph: '•',     label: 'Bulleted list' },
  { key: 'ol',     glyph: '1.',    label: 'Numbered list' },
  /* "Insert link", not "Link" (#24): "Link" was a whole accessible name inside
     two others on the same screen — the evidence row's "Add a link" and the
     navbar's "Copy a link to this view" — which is exactly the ambiguity the
     house rule forbids. The GLYPH stays the word "Link", so the visible label
     is still a substring of the accessible name (WCAG 2.5.3). */
  { key: 'link',   glyph: 'Link',  label: 'Insert link' },
  { key: 'image',  glyph: 'Image', label: 'Image', images: true },
]);

/** What each tool asks `hasFormat` about. Both spellings, because the surface
 *  legitimately holds either: marked renders `<strong>`/`<em>` and Squire
 *  authors `<b>`/`<i>`. A toolbar that lit up for only one of them would go
 *  dark the moment an author clicked into text they had loaded rather than
 *  typed. */
const FORMAT_TAGS = Object.freeze({
  bold: ['B', 'STRONG'], italic: ['I', 'EM'], ul: ['UL'], ol: ['OL'], link: ['A'],
});

/** Appended to whatever hint the caller supplied. The promise it makes is a
 *  small one and worth making out loud: the stored value is markdown, so a
 *  round trip through the rich surface can normalise spacing and marker
 *  spelling. Nothing is lost; some things are tidied. */
const STORED_NOTE = '';

/**
 * Build a markdown field into `container`.
 *
 * @param {object}   opts
 * @param {Element}  opts.container
 * @param {string}   opts.id              the textarea's id; the error slot is
 *                                        `err-<id>`, matching js/justify.js's
 *                                        fieldId → message convention exactly
 * @param {string}   opts.label
 * @param {boolean}  [opts.required=false]
 * @param {string}   [opts.hint]
 * @param {boolean}  [opts.compact=false] shorter box (the toolbar is the same)
 * @param {string}   [opts.value='']      initial markdown
 * @param {Function} [opts.onChange]      (md) => void, on every user edit
 * @param {boolean}  [opts.allowImages=false] offer the Image tool (and accept a
 *                                        pasted or dropped image); the larger
 *                                        editor sets it, inline rows do not
 * @param {Function} [opts.expand]        () => void; when given, a "Larger
 *                                        editor" button opens this field in
 *                                        the dialog (js/md-modal.js)
 * @returns {{value: string, focus: Function, showError: Function, destroy: Function}}
 */
export function initMdText({
  container, id, label, required = false, hint, compact = false,
  value = '', onChange, allowImages = false, expand = null,
} = {}) {
  if (!container) throw new Error('[usdm/mdtext] initMdText needs a container');
  /* A missing id would silently produce `#err-undefined`, and two fields would
     then share one error slot and one label target. Fail at the call site. */
  if (!id) throw new Error('[usdm/mdtext] initMdText needs an id');

  /* One controller for every listener, so destroy() is a single call and
     cannot leak a keystroke handler into a torn-down panel. */
  const ac = new AbortController();
  const on = { signal: ac.signal };

  const root = el('div', { class: `field md-field${compact ? ' md-compact' : ''}` });

  /* The label gains an id as well as its `for`. The `for` still points at the
     textarea — which is the control that carries the field id, and is what a
     click on the label should reach in Source mode — while the id is what the
     rich surface names itself with through `aria-labelledby`. A contenteditable
     div cannot be the target of a `for`, so it has to be the other direction. */
  const lab = el('label', { for: id, id: `lbl-${id}` }, label ?? '');
  /* AND A QUALIFIER NOBODY SEES (#24). The field's accessible name was exactly
     the visible label — "Impacts observed" — which is a whole accessible name
     sitting inside two others in the same field group: this field's own
     "Larger editor for Impacts observed, in a dialog" and "Choose an image for
     Impacts observed". Neither button can stop naming its field (three of them
     share one card and the name is all that tells them apart), so it is the
     SHORTER name that moves, which is what the rule prescribes.
     `sr-only` keeps the visible label the plain words it always was, so WCAG
     2.5.3 still holds: "Impacts observed" is a substring of "Impacts observed,
     markdown". And it is true — this field stores markdown, which is the one
     thing about it a reader cannot see. */
  lab.append(el('span', { class: 'sr-only' }, ', markdown'));
  if (required) lab.append(el('span', { class: 'req', 'aria-hidden': 'true' }, ' *'));
  root.append(lab);
  if (hint) root.append(el('p', { class: 'hint' }, `${hint} ${STORED_NOTE}`));

  /* ── toolbar ───────────────────────────────────────────────────────────── */
  const bar = el('div', { class: 'md-toolbar', role: 'group', 'aria-label': 'Formatting' });
  const toolBtns = new Map();
  for (const t of TOOLS) {
    if (t.images && !allowImages) continue;
    /* The glyph is decorative; the accessible name is the WORD. A screen
       reader announcing "B, button" is a riddle, and the USDM ramp's own rule
       — never a visual alone — is the same rule one level up. */
    const b = el('button', {
      type: 'button', class: 'nav-btn md-tool', 'data-tool': t.key,
      'aria-label': t.label, title: t.label,
    }, el('span', { 'aria-hidden': 'true' }, t.glyph));
    b.addEventListener('click', () => applyTool(t.key), on);
    bar.append(b);
    toolBtns.set(t.key, b);
  }

  /* Write / Source. `aria-pressed` drives the styling — house rule — so the
     visual state cannot drift from the announced one. Two buttons rather than
     one toggle because "Source" pressed and "Write" pressed are both real
     states a person can be in and should be able to see.

     Write starts DISABLED and Source starts pressed, because the rich surface
     is one dynamic import away and the field has to be usable in the meantime.
     Whichever way that import lands, the author is never looking at a control
     that does not work yet. */
  const segs = el('span', { class: 'seg-btns md-modes' });
  const btnWrite = el('button', { type: 'button', class: 'nav-btn seg-btn', 'aria-pressed': 'false' }, 'Write');
  const btnSource = el('button', { type: 'button', class: 'nav-btn seg-btn', 'aria-pressed': 'true' }, 'Source');
  /** Built now, mounted only if the rich surface never arrives. */
  const btnPreview = el('button', { type: 'button', class: 'nav-btn seg-btn', 'aria-pressed': 'false' }, 'Preview');
  btnWrite.disabled = true;
  btnWrite.addEventListener('click', () => setMode('write', true), on);
  btnSource.addEventListener('click', () => setMode('source', true), on);
  btnPreview.addEventListener('click', () => setMode('preview'), on);
  segs.append(btnWrite, btnSource);
  bar.append(segs);
  if (typeof expand === 'function') {
    /* Not `.md-tool`: it is a way to a bigger surface, not a format. The name
       carries the field's label so several on one card stay distinct, and the
       label sits mid-string so "Change 1" and "Change 10" cannot contain each
       other (the § 9f rule).

       IT READS AS THE ACTION IT IS (#24) — "Larger editor for X, in a dialog"
       named a place and left what pressing it would do to be inferred. The
       visible words stay first in the string, because the accessible name has
       to contain the visible label (WCAG 2.5.3). */
    const big = el('button', {
      type: 'button', class: 'nav-btn md-expand',
      'aria-label': `Larger editor — open ${label ?? id} in a dialog`,
      title: 'Open in a larger editor',
    }, 'Larger editor');
    big.addEventListener('click', () => expand(), on);
    bar.append(big);
  }
  root.append(bar);

  /* ── the three views ───────────────────────────────────────────────────── */

  /* The textarea KEEPS the field id, and that is load-bearing: js/justify.js's
     `controlsByKey()` walks `textarea[id]`, js/changes-panel.js reads
     `row.md.value`, and the harness sets `#rationale`.value directly. In Write
     mode it is hidden and holds the serialization of what Squire is showing —
     a mirror, but the mirror everything else in the app reads. */
  const ta = el('textarea', {
    id,
    'aria-describedby': `err-${id}`,
    ...(required ? { required: '' } : {}),
  });
  ta.value = value ?? '';

  /* Squire's host. NO id — the field id belongs to the textarea and two
     elements cannot share it. The name comes from the label by
     `aria-labelledby`, and the description from the same error slot the
     textarea points at, so a validation message is announced whichever view is
     up. `role=textbox` + `aria-multiline` is the pairing a contenteditable div
     needs to be announced as the multi-line field it is standing in for. */
  const rich = el('div', {
    class: 'md-rich',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-labelledby': `lbl-${id}`,
    'aria-describedby': `err-${id}`,
    /* MIRRORED, exactly as `aria-invalid` is by `showError` below and for the
       same reason: in Write mode THIS is the control a screen reader is
       sitting on, and the `required` the textarea carries is a fact about a
       hidden element. A required field that announces as optional is a field
       somebody skips. */
    ...(required ? { 'aria-required': 'true' } : {}),
    hidden: '',
  });

  /* `.info-section` is the kit's prose block — it is what gives the rendered
     markdown the same paragraph, list, link, code and kbd treatment the help
     modal has. Reusing it is the point: a preview that invented its own
     typography would be the one place in the app where house prose is not
     house prose. css/app.css § 10 adds LAYOUT only on top of it. */
  const preview = el('div', { class: 'md-preview info-section', hidden: '' });

  const err = el('p', { class: 'error', id: `err-${id}`, role: 'alert' });

  const link = buildLinkRow();

  /* ── images (only with `allowImages`) ─────────────────────────────────── */
  /* The picker is a hidden file input the Image tool clicks; a paste or a drop
     of an image file lands in the same `ingest`. Its OWN error slot, never
     `err-<id>` — that one belongs to the field's validation. */
  const imgErr = el('p', { class: 'error md-image-error', role: 'alert' });
  const fileInput = allowImages
    ? el('input', { type: 'file', accept: IMAGE_MIME.join(','), class: 'md-file-input', hidden: '',
                    'aria-label': `Choose an image for ${label ?? id}` })
    : null;
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';                  // the same file can be chosen twice
      if (f) ingest(f);
    }, on);
    root.append(fileInput);
  }

  root.append(ta, rich, link.row, imgErr, preview, err);
  container.append(root);

  /* ── state ─────────────────────────────────────────────────────────────── */

  /** 'source' until the rich surface arrives; 'write' once it has; 'preview'
   *  only in the degraded build, where it is the whole second half of the
   *  field. */
  let mode = 'source';
  /** The Squire instance, or null while it is loading and forever if it fails. */
  let sq = null;
  /** Set while THIS module is writing one view from another, so neither side's
   *  change handler mistakes its own echo for something the author did. */
  let syncing = false;
  /** WHICH LOAD THE RICH VIEW IS SHOWING. Bumped by every `loadRich`, and the
   *  reason the echo gate is not a flag and a string compare: Squire batches
   *  its own input events on a timer of its own, so a batch raised against the
   *  view as it stood BEFORE a load can be delivered after `syncing` is clear —
   *  and the markdown it serialises is the markdown the author had just
   *  replaced. Written in the Source view, that batch silently put the old
   *  sentence back (#5). */
  let gen = 0;
  /** The last few generations' fingerprints — what the rich view serialised to
   *  immediately after each load, before anybody could touch it. An echo that
   *  matches one of these is that generation's batch arriving late; nothing at
   *  this generation could have produced it. Newest last. */
  const serials = [];
  /** How many to remember. Two loads can land back to back (a mode flip while
   *  a textarea input is still mirroring), so one is not enough; four covers
   *  every path here and costs a few short strings. */
  const SERIAL_MEMORY = 4;
  /** The generation whose content the author has actually edited. Once an echo
   *  has been ACCEPTED at this generation the stale-batch gate stands down, so
   *  a real edit that happens to reproduce an earlier text still lands. */
  let echoGen = -1;
  /** Did a PERSON put their hands on the source view before the rich surface
   *  finished loading? Only trusted events count: the harness assigns
   *  `.value` and dispatches an untrusted `input`, which is not somebody
   *  choosing to write markdown by hand. */
  let touched = false;

  const markTouched = (e) => { if (e.isTrusted) touched = true; };
  /* FOCUS IS NOT TYPING: `touched` guards one thing — never yank a half-written
     markdown sentence into a different editor — and only keystrokes are that.
     `element.focus()` fires a TRUSTED focus event, so a focus listener here
     marked programmatic focus (js/changes-panel.js's openAnnotate) as touched
     and blocked the Write upgrade every time. keydown only. */
  ta.addEventListener('keydown', markTouched, on);

  ta.addEventListener('input', (e) => {
    /* Our own write, mirroring Squire back into the textarea. */
    if (syncing) return;
    markTouched(e);
    onChange?.(ta.value);
    /* Somebody — a person in Source mode, or the harness through a dispatched
       event — changed the markdown out from under the rich view. Re-render it
       if it is what is on screen; if it is not, switching to Write re-renders
       from the textarea anyway. */
    if (mode === 'write') loadRich(ta.value);
    else if (mode === 'preview') paint();
  }, on);

  /* ── the upgrade ───────────────────────────────────────────────────────── */
  squireP.then((Squire) => {
    if (ac.signal.aborted) return;
    if (Squire) { try { sq = makeSquire(Squire); } catch { sq = null; } }
    if (!sq) { degrade(); return; }
    btnWrite.disabled = false;
    /* Auto-switch, unless the author already started typing markdown by hand —
       yanking somebody's half-written sentence into a different editor is the
       kind of "helpful" that loses a caret and a train of thought. */
    if (!touched) setMode('write');
    else syncModes();
  });

  /**
   * The rich surface never arrived. Put the field back exactly as it shipped
   * before it existed: source plus preview, with no dead Write button left on
   * screen to be clicked at.
   */
  function degrade() {
    btnWrite.remove();
    segs.append(btnPreview);
    setMode('source');
  }

  function makeSquire(Squire) {
    const s = new Squire(rich, {
      blockTag: 'P',
      addLinks: true,
      /* The hook is `(html, editor) => DocumentFragment`, called from setHTML,
         insertHTML and the paste handler alike. The second argument is the
         Squire instance and is not needed here. The fragment must belong to
         this document, which `sanitizeMarkdownHTML` guarantees by building
         every node with the page's own `document`. */
      sanitizeToDOMFragment: (html) => sanitizeMarkdownHTML(html),
    });
    /* Squire's 'input' is one of its CUSTOM events, so this does not touch the
       DOM and cannot collide with the textarea's own listener. */
    s.addEventListener('input', () => {
      if (syncing) return;
      const md = toMarkdown(rich);
      /* ── THE ECHO GATE. Do not remove it for the `syncing` flag. ──────────
         `syncing` is a time window and Squire's edits do not all land inside
         one: its MutationObserver reports in a MICROTASK and setHTML mutates
         again in LATER turns, so the flag is false by the second batch
         (Squire's own `_ignoreChange` swallows only the FIRST). The escaped
         `input` was not free: js/changes-panel.js's onChange calls
         `ctx.notifyMeta()` unconditionally, so merely SHOWING a change row
         invalidated the wizard's cached package and re-bought the ~28 s
         national gate (see CLAUDE.md, "the wizard CACHES the built package").
         Comparing the serialization is race-free where a flag cannot be: the
         textarea holds the markdown, so identical re-serialization means
         nothing happened; a real edit always changes the string. */
      if (md === ta.value) return;
      /* ── AND THE GENERATION GATE. The compare above is race-free about the
         CURRENT view and says nothing about a batch raised against an earlier
         one: a bulk replacement made in Source serialises differently from
         what a late batch carries, so the stale text passed the compare and
         was written back over the author's (#5). Two conditions, so this can
         only ever drop an echo nobody could have meant: the serialisation is
         one a LOAD produced, and the author has not yet edited at this
         generation. */
      if (echoGen < gen && serials.includes(md)) return;
      /* The textarea is written WITHOUT an event: it is the mirror here, not
         the source, and dispatching would re-enter through the handler above
         and re-render the view the author is typing in. */
      syncing = true;
      ta.value = md;
      syncing = false;
      touched = true;
      echoGen = gen;
      onChange?.(md);
    });
    s.addEventListener('pathChange', syncTools);
    s.addEventListener('select', syncTools);
    if (allowImages) {
      /* Squire raises `pasteImage` when the clipboard holds image items and no
         text; nobody listened and a pasted screenshot silently did nothing.
         A dropped image file is the same ingest (Squire's own drop handler
         returns early without a text type, leaving the browser to navigate to
         the file). */
      s.addEventListener('pasteImage', (e) => {
        const cd = e?.detail?.clipboardData ?? e?.clipboardData;
        const f = [...(cd?.files ?? [])].find((x) => IMAGE_MIME.includes(x.type));
        if (f) ingest(f);
      });
      rich.addEventListener('drop', (e) => {
        const f = [...(e.dataTransfer?.files ?? [])].find((x) => IMAGE_MIME.includes(x.type));
        if (!f) return;
        e.preventDefault();
        ingest(f);
      }, on);
    }
    return s;
  }

  /**
   * A picked, pasted or dropped image → downscaled → into the field at the
   * caret, as `<img>` through the sanitizer in Write mode or as markdown in
   * Source mode. A refusal is a sentence in the field's own image slot.
   */
  async function ingest(file) {
    imgErr.textContent = '';
    let got;
    try { got = await readImageFile(file); }
    catch (e) { imgErr.textContent = e?.message ?? 'That image could not be read.'; return; }
    if (ac.signal.aborted) return;
    const alt = String(file.name ?? 'image').replace(/\.[a-z0-9]+$/i, '').replace(/[\[\]]/g, ' ').trim() || 'image';
    if (mode === 'write' && sq) {
      const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      sq.focus();
      /* `insertHTML`, never `insertImage`: the fragment passes
         `sanitizeToDOMFragment` → `cleanInto` → the one image gate. */
      try { sq.insertHTML(`<img src="${got.dataURL}" alt="${attr(alt)}">`); }
      catch { imgErr.textContent = 'The image could not be placed here.'; }
    } else {
      const { selectionStart: s, selectionEnd: e } = ta;
      ta.setRangeText(`![${alt}](${got.dataURL})`, s, e, 'end');
      commit();
    }
  }

  /* Squire's own listeners are torn down by sq.destroy(), so they are not on
     the AbortController — the two teardowns are separate on purpose. */

  /**
   * Markdown → the rich view. Never the other way: this must not serialize, or
   * opening a field would rewrite the markdown it was handed.
   *
   * THE FLAG IS CLEARED ON A MICROTASK, NOT SYNCHRONOUSLY: Squire notices
   * edits through a MutationObserver (a microtask), so a synchronous
   * `syncing = false` is already false when our own setHTML is reported back
   * and the field would serialize the rich view over the author's markdown.
   * The observer's microtask is queued BEFORE this one, so it still sees the
   * flag set. Do not lean on Squire's `_ignoreChange` swallowing one batch —
   * it is one library-internal flag away from quietly reformatting prose.
   */
  function loadRich(md) {
    if (!sq) return;
    gen += 1;
    syncing = true;
    try { sq.setHTML(richHTML(md)); } catch { /* leave the view as it was */ }
    /* THE GENERATION'S FINGERPRINT, taken synchronously — what this load
       serialises to with nobody's hands on it yet. A batch that arrives later
       carrying one of these is a batch from before a load, and the echo gate
       drops it. Cheap: the field holds prose, not a document. */
    try { serials.push(toMarkdown(rich)); } catch { /* nothing to fingerprint */ }
    if (serials.length > SERIAL_MEMORY) serials.shift();
    queueMicrotask(() => { syncing = false; });
    syncTools();
  }

  /**
   * The HTML the rich view is loaded with.
   *
   * `<strong>`/`<em>` are rewritten to `<b>`/`<i>` on the way in, because that
   * is what Squire's own bold() and italic() author. Without it the surface
   * holds two spellings of one idea: clicking Bold on already-bold text would
   * NEST a `<b>` inside the `<strong>` rather than toggling it off, and the
   * markdown that came back would be `****like this****`. Both spellings are
   * still DETECTED (see FORMAT_TAGS) — normalising the input is what keeps
   * authoring clean, and detecting both is what keeps a paste from going dark.
   */
  function richHTML(md) {
    const tmp = document.createElement('div');
    tmp.append(renderMarkdown(md));
    for (const n of tmp.querySelectorAll('strong, em')) {
      const to = document.createElement(n.localName === 'strong' ? 'b' : 'i');
      while (n.firstChild) to.append(n.firstChild);
      n.replaceWith(to);
    }
    return tmp.innerHTML;
  }

  function paint() {
    preview.replaceChildren(renderMarkdown(ta.value));
    if (!preview.firstChild) preview.append(el('p', { class: 'md-empty' }, 'Nothing to preview yet.'));
  }

  /**
   * @param {'write'|'source'|'preview'} next
   * @param {boolean} [refocus] pull focus into the view that is arriving. True
   *        when the author clicked a mode button: the control they were using
   *        is about to stop being the thing on screen, and leaving focus on a
   *        button above a box they now have to find with the mouse is the small
   *        rudeness that makes a keyboard user stop using a toggle at all.
   */
  function setMode(next, refocus = false) {
    /* Asking for a surface that is not there is not an error — it is the
       degraded build, and the answer is the source. */
    if (next === 'write' && !sq) next = 'source';
    if (next === 'write') loadRich(ta.value);
    if (next === 'preview') paint();
    mode = next;
    ta.hidden = next !== 'source';
    rich.hidden = next !== 'write';
    preview.hidden = next !== 'preview';
    if (next !== 'write') link.close();
    syncModes();
    syncTools();
    if (refocus) focusActive();
  }

  function focusActive() {
    if (mode === 'write' && sq) sq.focus();
    else if (mode === 'source') ta.focus();
  }

  function syncModes() {
    btnWrite.setAttribute('aria-pressed', String(mode === 'write'));
    btnSource.setAttribute('aria-pressed', String(mode === 'source'));
    btnPreview.setAttribute('aria-pressed', String(mode === 'preview'));
  }

  /** The toolbar reflects the caret. `aria-pressed` is only meaningful where
   *  there is a format state to report, so it is REMOVED outside Write mode
   *  rather than set to false — a toggle button that is always "not pressed"
   *  announces a state the field does not have. */
  function syncTools() {
    const live = mode === 'write' && !!sq;
    for (const [key, b] of toolBtns) {
      b.disabled = mode === 'preview';
      /* Image is an action, not a format: it is never "pressed". */
      if (key === 'image' || !live) { b.removeAttribute('aria-pressed'); continue; }
      let pressed = false;
      try { pressed = FORMAT_TAGS[key].some((t) => sq.hasFormat(t)); } catch { pressed = false; }
      b.setAttribute('aria-pressed', String(pressed));
    }
  }

  /* ── toolbar behaviour ─────────────────────────────────────────────────── */

  function applyTool(key) {
    if (key === 'image') { fileInput?.click(); return; }
    if (mode === 'write' && sq) applyRich(key);
    else applySource(key);
  }

  /** In the rich surface every tool is a TOGGLE, because Squire's bold() and
   *  friends only ever ADD a format — clicking a lit button twice would nest a
   *  second `<b>` rather than remove the first. */
  function applyRich(key) {
    if (key === 'link') { link.open(); return; }
    const lit = FORMAT_TAGS[key].some((t) => { try { return sq.hasFormat(t); } catch { return false; } });
    sq.focus();
    if (key === 'bold') { if (lit) clearFormat(FORMAT_TAGS.bold); else sq.bold(); }
    else if (key === 'italic') { if (lit) clearFormat(FORMAT_TAGS.italic); else sq.italic(); }
    else if (key === 'ul') { if (lit) sq.removeList(); else sq.makeUnorderedList(); }
    else if (key === 'ol') { if (lit) sq.removeList(); else sq.makeOrderedList(); }
    syncTools();
  }

  /** Remove BOTH spellings of a format. Only one is ever present after
   *  `richHTML` normalises, but a paste can put the other one there. */
  function clearFormat(tags) {
    for (const t of tags) {
      try { sq.changeFormat(null, { tag: t }); } catch { /* not present */ }
    }
  }

  /** The source view keeps exactly the behaviour it has always had. */
  function applySource(key) {
    if (key === 'bold') wrap('**', '**', 'bold text');
    else if (key === 'italic') wrap('*', '*', 'italic text');
    else if (key === 'ul') prefixLines('ul');
    else if (key === 'ol') prefixLines('ol');
    else if (key === 'link') {
      /* `[text](url)` — with a selection it becomes the link text and the URL
         is what gets selected, because that is the half the author still has
         to supply. */
      const { selectionStart: s, selectionEnd: e } = ta;
      const sel = ta.value.slice(s, e);
      const text = sel || 'link text';
      ta.setRangeText(`[${text}](url)`, s, e, 'end');
      const urlAt = s + text.length + 3;
      ta.setSelectionRange(urlAt, urlAt + 3);
      commit();
    }
  }

  /**
   * Wrap the selection, or drop a placeholder and select it.
   *
   * setRangeText does not fire `input`, so one is dispatched: that keeps a
   * single change path (the textarea's own listener) instead of a second one
   * that a future edit could forget to update, and anything else listening on
   * the element sees the edit too.
   */
  function wrap(before, after, placeholder) {
    const { selectionStart: s, selectionEnd: e } = ta;
    const sel = ta.value.slice(s, e);
    const body = sel || placeholder;
    ta.setRangeText(before + body + after, s, e, 'end');
    /* Leave the WORD selected inside its new markers, not the markers too:
       the next thing an author does is usually type over it or add a second
       mark, and both want the text, not the syntax. */
    ta.setSelectionRange(s + before.length, s + before.length + body.length);
    commit();
  }

  /**
   * Prefix whole lines. The selection is first grown to line boundaries —
   * clicking "Bulleted list" with three words selected mid-sentence must
   * bullet the LINE, not split it — and lines that already carry the marker
   * are left alone, so clicking twice does not produce `- - item`.
   */
  function prefixLines(marker) {
    const v = ta.value;
    const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let e = v.indexOf('\n', ta.selectionEnd);
    if (e === -1) e = v.length;
    const lines = v.slice(s, e).split('\n');
    let n = 0;
    const out = lines.map((line) => {
      if (line.trim() === '' && lines.length > 1) return line;
      n += 1;
      const mark = marker === 'ol' ? `${n}. ` : '- ';
      return /^\s*(?:[-*+]\s|\d+\.\s)/.test(line) ? line : mark + line;
    }).join('\n');
    ta.setRangeText(out, s, e, 'end');
    ta.setSelectionRange(s, s + out.length);
    commit();
  }

  /** Focus first, THEN dispatch: the browser drops a selection set on an
   *  unfocused textarea in some engines, and a caret nobody can see is
   *  indistinguishable from a toolbar button that did nothing. */
  function commit() {
    ta.focus();
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  /* ── the link row ──────────────────────────────────────────────────────── */

  /**
   * Making a link in the rich surface needs somewhere to type the URL, and
   * `window.prompt` is not it: axe cannot see it, a screen reader announces a
   * browser dialog with no context, and it blocks the thread. So it is an
   * inline row with a real label, exactly like the checkpoint name form.
   *
   * It is only used in Write mode. In Source mode the Link tool still inserts
   * `[text](url)` and selects the URL, because there the author is looking at
   * the markdown and that is the more direct edit.
   */
  function buildLinkRow() {
    const row = el('div', { class: 'md-link-row', hidden: '' });
    const lid = `lnk-${id}`;
    const input = el('input', { type: 'url', id: lid, placeholder: 'https://…' });
    const apply = el('button', { type: 'button', class: 'nav-btn' }, 'Apply');
    const unlink = el('button', { type: 'button', class: 'nav-btn' }, 'Unlink');
    const cancel = el('button', { type: 'button', class: 'nav-btn' }, 'Cancel');
    /* Its OWN error slot, never `err-<id>`. That one belongs to the field's
       validation — writing "that link needs http://" into it would erase the
       message telling the author their rationale is too short, and the
       validator would never put it back. */
    const rowErr = el('p', { class: 'error md-link-error', role: 'alert' });
    row.append(el('label', { for: lid }, 'Link URL'), input, apply, unlink, cancel, rowErr);

    const close = (refocus = true) => {
      row.hidden = true;
      rowErr.textContent = '';
      if (refocus && mode === 'write' && sq) sq.focus();
    };

    const open = () => {
      rowErr.textContent = '';
      /* Prefill from the link the caret is already in, so editing one is not
         retyping it. */
      const a = enclosingLink();
      input.value = a?.getAttribute('href') ?? '';
      unlink.disabled = !a;
      row.hidden = false;
      input.focus();
      input.select();
    };

    apply.addEventListener('click', () => {
      const href = safeHref(input.value.trim());
      if (!href) {
        rowErr.textContent = 'Links need http://, https:// or mailto:.';
        input.focus();
        return;
      }
      /* Focus BEFORE the edit. Squire falls back to its last saved selection
         when it is not focused, and focusing first restores that range so the
         link lands on the words the author had selected. */
      sq.focus();
      try { sq.makeLink(href); } catch { /* nothing selectable */ }
      close();
      syncTools();
    }, on);

    unlink.addEventListener('click', () => {
      sq.focus();
      try { sq.removeLink(); } catch { /* not in a link */ }
      close();
      syncTools();
    }, on);

    cancel.addEventListener('click', () => close(), on);
    row.addEventListener('keydown', (e) => {
      /* BOTH halves matter, and the second one is not decoration.
         `preventDefault` stops the browser's own default; `stopPropagation` is
         what keeps the key from ALSO reaching the docked card, where Escape is
         a navigation — `initDetailCard`'s onClose maps to `gotoStep(2)` (see
         CLAUDE.md). Without it, dismissing this little row threw the author off
         step 3 entirely and closed the panel they were writing in. */
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      /* Enter in a one-field row means "do the thing", not "submit the form
         this happens to be inside" — and not "activate the card's default"
         either, for the same reason. */
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply.click(); }
    }, on);

    return { row, open, close };
  }

  /** The `<a>` the caret is inside, or null. Walks up from the selection
   *  rather than asking `getPath()`, which answers with a string. */
  function enclosingLink() {
    let n = null;
    try { n = sq?.getSelection()?.commonAncestorContainer ?? null; } catch { return null; }
    while (n && n !== rich) {
      if (n.nodeType === Node.ELEMENT_NODE && n.localName?.toLowerCase() === 'a') return n;
      n = n.parentNode;
    }
    return null;
  }

  /* No roving tabindex, deliberately: for five buttons the cost is five Tab
     presses, and a half-implemented roving tabindex is worse than none (Tab
     stops working before the arrows start). Plain natural DOM tab order. */

  return {
    get value() { return ta.value; },
    /**
     * Programmatic. Does NOT fire onChange — the caller already knows — and
     * does NOT serialize: opening a field, or refreshing a change row, must
     * never rewrite the markdown that was stored for it. A value identical to
     * the one already there is a no-op, so a repaint cannot disturb a caret.
     */
    set value(md) {
      const next = md ?? '';
      if (next === ta.value) return;
      ta.value = next;
      if (mode === 'write') loadRich(next);
      else if (mode === 'preview') paint();
    },
    /** Focus whichever view is actually on screen. */
    focus() {
      if (mode === 'preview') setMode(sq ? 'write' : 'source');
      focusActive();
    },
    /**
     * Byte-compatible with js/justify.js's showErrors(): the message goes in
     * the `role=alert` slot both views already point at with
     * aria-describedby, and `aria-invalid` goes on the control itself — and
     * comes OFF again, so a fixed field stops reporting as broken. It is
     * mirrored onto the rich surface because in Write mode THAT is the control
     * a screen reader is sitting on; a field marked invalid only on the hidden
     * textarea reports as perfectly fine to the person being asked to fix it.
     * `.error:empty` is display:none, so clearing it also removes the space.
     */
    showError(msg) {
      err.textContent = msg ?? '';
      for (const n of [ta, rich]) {
        if (msg) n.setAttribute('aria-invalid', 'true');
        else n.removeAttribute('aria-invalid');
      }
    },
    destroy() {
      try { sq?.destroy(); } catch { /* already gone */ }
      sq = null;
      ac.abort();
      root.remove();
    },
  };
}
