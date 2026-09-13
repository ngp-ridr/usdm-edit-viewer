/* ============================================================================
   USDM Editor · js/justify.js
   The case an author makes for an edit — ONE justification object, TWO forms:

     initExplainForm   narrative · impacts · evidence   the argument   (step 3)
     initSubmitForm    author                           the paperwork  (step 4)

   Structured only where a reviewer can act unassisted: evidence is labelled
   links (openable), the argument is free prose. The indicators checklist and
   `confidence` are retired — a ticked box a reviewer cannot verify is not
   evidence, and authors backfilled boxes to match the sentence.

   `EXPLAIN_FIELDS` + `splitProblems` are the single sorting of fields by side,
   so the gate, the guard and the two forms cannot disagree. `borderNotes` is a
   THIRD path onto the object, written straight through `ctx.setJustification`
   from js/wizard.js's `paintEdgeEffects` (its panel is painted once, so a
   per-neighbour textarea cannot live in a form closure). `validateJustification`
   validates the WHOLE object; js/submit.js's `verifyPackage` re-runs it over a
   finished file.

   The contract both forms are held to (see CLAUDE.md): take the FULL object,
   copy, mutate only your own fields, emit the FULL object. Safe because the
   forms are never mounted at the same time (the wizard rebuilds the card per
   step) and each initializes from live state on mount — a form caching `data`
   across a step bounce would silently undo the other form's half.

   Photos travel INSIDE the proposal: serverless, so there is nowhere to host
   one, and js/image.js downscales a picked file into a `data:` URI that the
   Evidence list stores as `{ image, label }` beside the `{ url, label }` link
   rows, and that the markdown fields carry as `![alt](data:…)`. Both survive
   the round trip into the package and out.
   ========================================================================== */

import { button, el } from './dom.js';
import { IMAGE_MIME, isImageDataURL, readImageFile } from './image.js';

export const ROLES = Object.freeze([
  'State climatologist', 'Extension', 'Producer / land manager',
  'Federal or state agency', 'Tribal government', 'Researcher', 'Other',
]);

/**
 * The shape of a justification nobody has filled in.
 *
 * SHARED by both forms, deliberately: each of them copies this whole object and
 * writes back this whole object, so a key that existed in one and not the other
 * would be dropped by whichever form emitted last. `EMPTY_JUSTIFICATION` in
 * js/submit.js is the SAME shape, kept in a second file because `finishPackage`
 * needs a fallback before either form has mounted — see that constant's own
 * comment for why the two must move together, key for key.
 */
const EMPTY = () => ({
  rationale: '', impacts: '', evidence: [],
  /* Keyed by neighbour id (`'state:ND'`), never by display name — an id is
     stable and a name is a rendering choice (js/wizard.js `paintEdgeEffects`).
     Empty is the ordinary case: most edits touch no boundary at all. */
  borderNotes: {},
  author: { name: '', email: '', affiliation: '', role: '', onBehalfOf: '' },
});

/**
 * The validation keys the EXPLAIN step owns; everything else is Submit's.
 * Named once because three readers must agree: the two forms (which errors are
 * mine), js/wizard.js's step-4 gate (`gateFor` reads `.explain`, enforced at
 * step-4 ENTRY) and the transport guard (`submitGuard` reads `.submit`,
 * enforced at SEND). Whichever screen a field is typed on is the screen its
 * failure lands on — the list and the screen move together. Evidence is NOT
 * listed: its validator keys are per-row (`evidence-0`, …), so `splitProblems`
 * matches the PREFIX instead.
 */
export const EXPLAIN_FIELDS = Object.freeze(['rationale', 'impacts']);

/* ── WHAT EACH FIELD IS CALLED, so a refusal can NAME it rather than count it.
   These live beside the validator on purpose (same rule as mdtext's
   toMarkdown/ALLOWED): every key the validator can emit has a label here, so
   the two cannot drift. A key with no label falls back to the key itself —
   deliberately ugly, to prevent a silent "undefined". Labels match the visible
   `<label>` text, or a refusal sends the author hunting for a control that is
   not there. */
const RATIONALE_LABEL = 'Why this edit';
export const FIELD_LABELS = Object.freeze({
  rationale: RATIONALE_LABEL,
  impacts: 'Impacts observed',
  'author-name': 'Name',
  'author-email': 'Email',
  'author-role': 'Role',
});

/**
 * The human name of one problem key, for a sentence.
 *
 * `evidence-N` is computed rather than listed: the validator's keys are
 * per-row, so there is no fixed set of them to enumerate. One-based, because
 * the author sees rows, not indices.
 */
export function fieldLabel(key) {
  const m = /^evidence-(\d+)$/.exec(key);
  if (m) return `Evidence link ${Number(m[1]) + 1}`;
  return FIELD_LABELS[key] ?? key;
}

/**
 * "Why this edit", or "Why this edit, Email and Role" — an Oxford-comma list of
 * field names, for a refusal that has to say WHICH.
 *
 * Capped at three plus a count. A refusal naming eight fields is a paragraph,
 * and the fields themselves are all marked and reachable; this sentence exists
 * to get the author to the right form, not to replace it.
 */
export function namedProblems(problems) {
  const names = Object.keys(problems ?? {}).map(fieldLabel);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * Sort a `validateJustification` report into the two halves.
 *
 * `explain` is the keys in `EXPLAIN_FIELDS` PLUS every `evidence-N` — the
 * prefix test exists because evidence moved to the Explain form but its
 * validator keys are per-row, so a flat `includes` list can never name one.
 * `submit` is everything left over — today just `author-*`. Open-ended on
 * purpose: a new submit-side field starts being enforced by the guard the
 * moment `validateJustification` reports it, with nothing else to remember to
 * update.
 *
 * @param {Record<string,string>} problems
 * @returns {{explain: Record<string,string>, submit: Record<string,string>}}
 */
export function splitProblems(problems) {
  const explain = {};
  const submit = {};
  for (const [key, message] of Object.entries(problems ?? {})) {
    if (EXPLAIN_FIELDS.includes(key) || key.startsWith('evidence-')) explain[key] = message;
    else submit[key] = message;
  }
  return { explain, submit };
}

/**
 * The ARGUMENT: the narrative, what it impacted, and the evidence for it.
 * Step 3. Evidence errors route here via `splitProblems`'s prefix test (its
 * validator keys are per-row).
 *
 * ── The `richText` seam ────────────────────────────────────────────────────
 * ONE field takes it — the narrative. The injected builder gets what a plain
 * field gets (`id`, `label`, `required`, `hint`, `value`, `onChange`) plus a
 * container, and must produce a control whose textarea carries the `id` with
 * an `err-<id>` error slot — exactly `textField`'s own contract, which
 * js/mdtext.js satisfies. So `validate()` and `controlsByKey()` are untouched
 * by the injection (`controlsByKey` walks `textarea[id]`); `showErrors()` is
 * the ONE place that learned the field exists — see `makeShowErrors`.
 *
 * @param {object}   opts
 * @param {Element}  opts.container
 * @param {object}   [opts.value]     the WHOLE justification, to restore from
 * @param {Function} [opts.onChange]  called with the whole justification on edit
 * @param {Function} [opts.richText]  ({container, id, label, required, hint,
 *                                     value, onChange}) => controller. Builds
 *                                     the narrative field; omit it and the
 *                                     narrative is a plain textarea.
 * @returns {{value, rationale, validate, showErrors}} `rationale` is whatever
 *          `richText` returned, or null — the caller's handle on the field it
 *          injected, so it can focus it or push a value into it.
 */
export function initExplainForm({ container, value, onChange, richText, openLarge = null } = {}) {
  const data = structuredClone({ ...EMPTY(), ...(value ?? {}) });

  const emit = () => onChange?.(structuredClone(data));

  container.replaceChildren();
  const frag = document.createDocumentFragment();

  /* ── narrative ────────────────────────────────────────────────────────── */
  /* `RATIONALE_LABEL` is module scope now — see FIELD_LABELS, which a refusal
     reads to NAME this field rather than counting it. */
  const RATIONALE_HINT = 'Please provide an overarching narrative for your proposed changes.';
  /** Whatever `richText` built, or null. Returned to the caller. */
  let rationaleCtl = null;
  if (typeof richText === 'function') {
    /* Mounted into a host inside the FRAGMENT, before the fragment reaches the
       document. That is legal and deliberate — a detached subtree is a normal
       append target — and it keeps the field in DOM order with everything
       else, which is what `showErrors`'s "first offending control in DOM order"
       depends on. */
    const host = el('div');
    frag.append(host);
    rationaleCtl = richText({
      container: host,
      id: 'rationale',
      label: RATIONALE_LABEL,
      required: true,
      hint: RATIONALE_HINT,
      value: data.rationale,
      onChange: (v) => { data.rationale = v; emit(); },
      /* "Larger editor": the same markdown in the dialog (js/md-modal.js),
         where a photo can go in. The dialog writes through to `data` and
         mirrors into this field; its id differs from the field's own. */
      expand: openLarge ? () => openLarge({
        title: RATIONALE_LABEL, sub: 'The overarching narrative for the proposal',
        id: 'annotate-rationale', label: RATIONALE_LABEL, required: true, hint: RATIONALE_HINT,
        value: data.rationale,
        onChange: (v) => {
          data.rationale = v; emit();
          if (rationaleCtl && rationaleCtl.value !== v) rationaleCtl.value = v;
        },
      }) : null,
    }) ?? null;
  } else {
    frag.append(textField('rationale', RATIONALE_LABEL, {
      required: true, multiline: true,
      hint: RATIONALE_HINT,
      get: () => data.rationale,
      set: (v) => { data.rationale = v; emit(); },
    }));
  }

  /* ── impacts ── a plain textarea on purpose: a short factual note ("stock
     water hauled since 12 July") does not want a toolbar and a preview, which
     would suggest a document is wanted where a sentence is. The "Larger
     editor" button is the exception for the author with a photo of the hauled
     water: the block is already `format: 'markdown'` in the package. */
  frag.append(textField('impacts', 'Impacts observed', {
    multiline: true,
    hint: 'Optional. Agricultural, hydrological, ecological — what drought is ' +
          'doing here, as distinct from what the indices say.',
    get: () => data.impacts,
    set: (v) => { data.impacts = v; emit(); },
    expand: openLarge ? ({ mirror }) => openLarge({
      title: 'Impacts observed', sub: 'What drought is doing here',
      id: 'annotate-impacts', label: 'Impacts observed',
      value: data.impacts,
      onChange: (v) => { data.impacts = v; emit(); mirror(v); },
    }) : null,
  }));

  /* ── evidence: links AND photos ───────────────────────────────────────── */
  frag.append(fieldset('Evidence', 'Links — maps from NDMC, dashboards like d3drought.org, photo ' +
    'albums, DEWS call notes — or photos, resized in your browser and stored inside the proposal.',
    (body) => {
      const list = el('div', { class: 'indicator-grid' });
      const fieldErr = () => container.querySelector('#err-evidence');
      const draw = () => {
        list.replaceChildren();
        data.evidence.forEach((row, i) => {
          const isImage = 'image' in row;
          const r = el('div', { class: `evidence-row${isImage ? ' is-image' : ''}` });
          const kind = isImage ? 'photo' : 'link';
          /* A placeholder is not an accessible name — it is announced as a value
             hint at best and vanishes the moment anyone types. These inputs are
             otherwise unlabelled, so the name is spelled out, numbered the same
             way the Remove button numbers itself. */
          const label = el('input', {
            type: 'text', id: `evidence-${i}-label`, placeholder: isImage ? 'caption' : 'what it shows',
            'aria-label': `Evidence ${kind} ${i + 1} — ${isImage ? 'caption' : 'what it shows'}`,
            ...(isImage ? { 'aria-describedby': `err-evidence-${i}` } : {}),
          });
          label.value = row.label ?? '';
          label.addEventListener('input', () => {
            row.label = label.value; emit();
            if (isImage) thumb.alt = label.value.trim() || `Evidence photo ${i + 1}`;
          });
          const rm = button('Remove', () => { data.evidence.splice(i, 1); draw(); emit(); });
          rm.setAttribute('aria-label', `Remove evidence ${kind} ${i + 1}`);
          let thumb = null;
          if (isImage) {
            /* The thumbnail's alt is the caption, so the photo is named by the
               words the author gave it. `src` is the stored data URI. */
            thumb = el('img', { class: 'evidence-thumb', alt: (row.label ?? '').trim() || `Evidence photo ${i + 1}` });
            if (isImageDataURL(row.image)) thumb.src = row.image;
            r.append(thumb, label, rm);
          } else {
            const url = el('input', {
              type: 'url', id: `evidence-${i}-url`, placeholder: 'https://…',
              'aria-label': `Evidence link ${i + 1} — URL`,
              'aria-describedby': `err-evidence-${i}`,
            });
            url.value = row.url ?? '';
            url.addEventListener('input', () => { row.url = url.value; emit(); });
            r.append(url, label, rm);
          }
          /* Its own error slot, matching validateJustification's `evidence-${i}`
             key. Removing a row re-runs draw(), so the indices stay aligned. */
          r.append(el('p', { class: 'error', id: `err-evidence-${i}`, role: 'alert' }));
          list.append(r);
        });
      };
      const add = button('Add a link', () => { data.evidence.push({ url: '', label: '' }); draw(); emit(); });
      /* A photo: the hidden picker, js/image.js's downscale, one row. A refusal
         is a sentence in the fieldset's own slot (`err-evidence`), never in a
         row's — there is no row yet. */
      const picker = el('input', { type: 'file', accept: IMAGE_MIME.join(','), hidden: '',
                                   'aria-label': 'Choose an evidence photo' });
      picker.addEventListener('change', async () => {
        const f = picker.files?.[0];
        picker.value = '';
        if (!f) return;
        const slot = fieldErr();
        if (slot) slot.textContent = '';
        try {
          const { dataURL } = await readImageFile(f);
          data.evidence.push({ image: dataURL, label: '' });
          draw(); emit();
          list.lastElementChild?.querySelector('input')?.focus();
        } catch (e) {
          if (slot) slot.textContent = e?.message ?? 'That image could not be read.';
        }
      });
      const addPhoto = button('Add a photo', () => picker.click());
      draw();
      body.append(list, el('div', { class: 'row' }, add, addPhoto), picker);
    }, 'evidence'));

  container.append(frag);
  emit();

  /**
   * Every EXPLAIN key that has a control, in DOM order. Read fresh each time —
   * the evidence rows are rebuilt by draw() on add/remove. Rows are found via
   * `.evidence-row` (the list also carries `.indicator-grid` for layout), and
   * `evidence-N-url`/`evidence-N-label` ids are skipped in the id sweep: the
   * validator's key for a row is `evidence-N`, which is neither of them.
   */
  function controlsByKey() {
    const map = new Map();
    /* The row's FIRST input: the URL of a link row, the caption of a photo row. */
    container.querySelectorAll('.evidence-row')
      .forEach((r, i) => { const n = r.querySelector('input'); if (n) map.set(`evidence-${i}`, n); });
    for (const n of container.querySelectorAll('input[id], select[id], textarea[id]')) {
      if (!n.id.startsWith('evidence-')) map.set(n.id, n);
    }
    return map;
  }

  return {
    get value() { return structuredClone(data); },
    /** The injected narrative control, or null. See the `richText` seam above. */
    get rationale() { return rationaleCtl; },
    /** What is missing on THIS side, as field ids → message. */
    validate() { return splitProblems(validateJustification(data)).explain; },
    showErrors: makeShowErrors({
      container, side: 'explain', controlsByKey, rich: () => rationaleCtl,
    }),
  };
}

/**
 * The PAPERWORK: who you are. Step 4. It renders BEFORE the national gate has
 * finished (js/wizard.js `renderSubmit`), so typing an affiliation happens
 * behind the ~15 s of arithmetic rather than in front of it — possible because
 * nothing here reads a package.
 *
 * @param {object}   opts
 * @param {Element}  opts.container
 * @param {object}   [opts.value]       the WHOLE justification, to restore from
 * @param {Function} [opts.onChange]    called with the whole justification on edit
 * @param {Function} [opts.loadAuthor]  () => stored author block
 * @param {Function} [opts.saveAuthor]  (author) => void
 * @returns {{value, validate, showErrors}}
 */
export function initSubmitForm({
  container, value, onChange, loadAuthor, saveAuthor,
} = {}) {
  const data = structuredClone({ ...EMPTY(), ...(value ?? {}) });
  /* THE BLANKS IN `value.author` ARE NOT AN INSTRUCTION TO FORGET WHO YOU ARE.
     `EMPTY()` carries empty author strings, and the Explain form copies the
     whole justification through — so the first thing app state holds is an
     author block of blanks, written by a form that has no author fields on
     it. Spreading that over the stored block would wipe the name a returning
     author has typed once and never again, on the very first visit to step 4.
     So the stored block wins over an empty incoming field, and loses to a
     filled one; clearing a field for real still sticks, because `saveAuthor`
     persists the blank on the same keystroke. */
  data.author = {
    ...EMPTY().author,
    ...(loadAuthor?.() ?? {}),
    ...filledOnly(value?.author),
  };

  const emit = () => onChange?.(structuredClone(data));

  container.replaceChildren();
  const frag = document.createDocumentFragment();

  /* ── submitter ────────────────────────────────────────────────────────── */
  frag.append(fieldset('You', 'Kept in this browser so you only type it once. ' +
    'It travels with the proposal — a recommendation nobody can attribute is a ' +
    'recommendation nobody can follow up.', (body) => {
    for (const [key, label, type] of [
      ['name', 'Name', 'text'], ['email', 'Email', 'email'], ['affiliation', 'Affiliation', 'text'],
      /* Unvalidated, following `affiliation`'s own precedent exactly: an author
         speaking FOR a body — a drought task force, a tribal water board — may
         have no board seat of their own to name as an affiliation, and this is
         where that gets said instead. Never required, because most authors are
         not writing on anyone's behalf but their own. */
      ['onBehalfOf', 'On behalf of', 'text'],
    ]) {
      body.append(textField(`author-${key}`, label, {
        required: key !== 'affiliation' && key !== 'onBehalfOf', type,
        hint: key === 'onBehalfOf'
          ? 'Optional — e.g. the Montana Governor’s Drought and Water Supply Committee.'
          : undefined,
        get: () => data.author[key],
        set: (v) => { data.author[key] = v; saveAuthor?.(data.author); emit(); },
      }));
    }
    body.append(selectField('author-role', 'Role', ROLES, {
      required: true,
      get: () => data.author.role,
      set: (v) => { data.author.role = v; saveAuthor?.(data.author); emit(); },
    }));
  }));

  container.append(frag);
  emit();

  /** Every SUBMIT key that has a control, in DOM order. No evidence rows here
   *  any more — see `initExplainForm`'s `controlsByKey`, which they moved to —
   *  so a plain id sweep is enough. */
  function controlsByKey() {
    const map = new Map();
    for (const n of container.querySelectorAll('input[id], select[id], textarea[id]')) {
      map.set(n.id, n);
    }
    return map;
  }

  return {
    get value() { return structuredClone(data); },
    /** What is missing on THIS side, as field ids → message. */
    validate() { return splitProblems(validateJustification(data)).submit; },
    showErrors: makeShowErrors({ container, side: 'submit', controlsByKey }),
  };
}

/**
 * Pure: what is missing before this proposal can be packaged.
 *
 * `indicators` and `confidence` are retired and never checked — but an OLDER
 * file legitimately carries both (`verifyPackage` re-runs this over finished
 * packages), so their presence is never asserted against, only never demanded.
 */
export function validateJustification(d) {
  const problems = {};
  /* NON-EMPTY, AND NOTHING ABOUT LENGTH: "Rain, two weeks" is a real answer at
     15 characters and forty spaces is not one at all — a minimum length cannot
     tell those apart and only taught people to pad. */
  if (!d.rationale || !d.rationale.trim()) {
    problems.rationale = 'Say why this edit is right — a reviewer cannot act ' +
      'on a blank.';
  }
  if (!d.author?.name?.trim()) problems['author-name'] = 'Your name travels with the proposal.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.author?.email ?? '')) {
    problems['author-email'] = 'A reachable email, so a reviewer can ask a question.';
  }
  if (!ROLES.includes(d.author?.role)) problems['author-role'] = 'Choose the role you are writing in.';
  for (const [i, e] of (d.evidence ?? []).entries()) {
    if (e.url && !/^https?:\/\//i.test(e.url)) problems[`evidence-${i}`] = 'Links need http:// or https://.';
    /* Only reachable from a hand-edited file: the picker gates on the way in. */
    if (e.image != null && !isImageDataURL(e.image)) {
      problems[`evidence-${i}`] = 'That image could not be read; remove it and add it again.';
    }
  }
  return problems;
}

/* ── the shared error painter ─────────────────────────────────────────────── */

/**
 * Paint a validation report onto ONE of the two forms. Three things: the
 * message into the field's `role=alert` slot; `aria-invalid` on the control
 * (and OFF again when the key is absent); focus to the first offending control
 * in DOM order. `showErrors({})` clears everything and focuses nothing.
 *
 * IT FILTERS BY SIDE FIRST — the point of the seam, not belt-and-braces. Both
 * callers hold a WHOLE-justification report, and the clearing pass empties
 * every slot the report does not mention, so an unsorted report would have
 * step 4 wiping the errors step 3 had just put up.
 *
 * @param {object}   opts
 * @param {Element}  opts.container
 * @param {'explain'|'submit'} opts.side which half of `splitProblems` is mine
 * @param {Function} opts.controlsByKey () => Map<key, Element>, read fresh
 * @param {Function} [opts.rich]        () => the injected narrative controller
 */
function makeShowErrors({ container, side, controlsByKey, rich }) {
  return function showErrors(problems) {
    const mine = splitProblems(problems ?? {})[side];
    for (const [id, msg] of Object.entries(mine)) {
      const err = container.querySelector(`#err-${CSS.escape(id)}`);
      if (err) err.textContent = msg;
    }
    for (const err of container.querySelectorAll('.error')) {
      if (!mine[err.id.replace(/^err-/, '')]) err.textContent = '';
    }
    let first = null;
    for (const [key, node] of controlsByKey()) {
      if (!mine[key]) { node.removeAttribute('aria-invalid'); continue; }
      node.setAttribute('aria-invalid', 'true');
      const earlier = first
        && (first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
      if (!first || earlier) first = node;
    }
    /* THE INJECTED FIELD ANSWERS FOR ITSELF: a rich field HIDES its textarea,
       so `aria-invalid` on it is unread and `.focus()` on it does nothing —
       indistinguishable from the form ignoring Submit. Route the message and
       the focus through the controller (showError()/focus()); the loop above
       keeps owning the position. */
    const richCtl = rich?.() ?? null;
    if (richCtl) richCtl.showError(mine.rationale ?? '');
    if (richCtl && first === controlsByKey().get('rationale')) {
      richCtl.focus();
      return;
    }
    first?.focus();
  };
}

/** The entries of an author block that actually say something. See `data.author`. */
function filledOnly(author) {
  const out = {};
  for (const [k, v] of Object.entries(author ?? {})) {
    if (typeof v === 'string' ? v.trim() : v != null) out[k] = v;
  }
  return out;
}

/**
 * A titled group of controls. `errorId` gives a group whose validation key
 * names no single input its own `role=alert` slot — without one, showErrors
 * has nowhere to put the message and the failure is silent. Unused by either
 * form today; kept for the next fieldset that needs it. The slot renders
 * empty and `.error:empty` is display:none, so pre-creating it costs nothing.
 */
function fieldset(legend, hint, build, errorId) {
  const wrap = el('section', { class: 'field' });
  wrap.append(el('h3', { class: 'field-legend' }, legend));
  if (hint) wrap.append(el('p', { class: 'hint tight' }, hint));
  const body = el('div', { class: 'field' });
  build(body);
  wrap.append(body);
  if (errorId) wrap.append(el('p', { class: 'error', id: `err-${errorId}`, role: 'alert' }));
  return wrap;
}

function textField(id, label, { required, multiline, hint, type = 'text', get, set, expand } = {}) {
  const wrap = el('div', { class: 'field' });
  const lab = el('label', { for: id }, label);
  if (required) lab.append(el('span', { class: 'req', 'aria-hidden': 'true' }, ' *'));
  /* Pointed at the error slot from the start. It is legal — and the only way
     the message is announced with the control rather than only at the moment it
     appears — for aria-describedby to name a node that is currently empty and
     display:none; it simply contributes nothing until the validator fills it. */
  const described = { 'aria-describedby': `err-${id}` };
  const input = multiline
    ? el('textarea', { id, ...described, ...(required ? { required: '' } : {}) })
    : el('input', { id, type, ...described, ...(required ? { required: '' } : {}) });
  input.value = get?.() ?? '';
  input.addEventListener('input', () => set?.(input.value));
  wrap.append(lab);
  if (hint) wrap.append(el('p', { class: 'hint' }, hint));
  if (typeof expand === 'function') {
    /* The same "Larger editor" a markdown field offers (js/mdtext.js): the
       dialog writes through the caller's onChange and `mirror`s back here. */
    const big = el('button', {
      type: 'button', class: 'nav-btn md-expand',
      'aria-label': `Larger editor for ${label}, in a dialog`, title: 'Open in a larger editor',
    }, 'Larger editor');
    big.addEventListener('click', () => expand({ mirror: (v) => { input.value = v; } }));
    wrap.append(big);
  }
  wrap.append(input, el('p', { class: 'error', id: `err-${id}`, role: 'alert' }));
  return wrap;
}

function selectField(id, label, options, { required, hint, get, set } = {}) {
  const wrap = el('div', { class: 'field' });
  const lab = el('label', { for: id }, label);
  if (required) lab.append(el('span', { class: 'req', 'aria-hidden': 'true' }, ' *'));
  const sel = el('select', {
    id, 'aria-describedby': `err-${id}`, ...(required ? { required: '' } : {}),
  });
  sel.append(el('option', { value: '' }, 'Choose…'));
  for (const o of options) {
    const opt = el('option', { value: o }, o[0].toUpperCase() + o.slice(1));
    sel.append(opt);
  }
  sel.value = get?.() ?? '';
  sel.addEventListener('change', () => set?.(sel.value));
  wrap.append(lab);
  if (hint) wrap.append(el('p', { class: 'hint' }, hint));
  wrap.append(sel, el('p', { class: 'error', id: `err-${id}`, role: 'alert' }));
  return wrap;
}
