/* ============================================================================
   USDM Edit Viewer · js/load.js
   Intake: bytes in, proposals out, and a sentence for every refusal.

   docs/contracts.md § 9 (the interface) and § 15 (the sentences). Four ways in,
   ONE pipeline behind them:

     a file picker (`#load-file-input`, multiple)
     a drop anywhere over `#map-frame`
     `?load=<url>,…`
     `?demo` → demo/index.json → the twelve bundled packages

              bytes ─┬─ gzip magic? ─→ gunzipText ─┐
                     └─ else TextDecoder ──────────┴─→ JSON.parse ─→ session.add

   ── Four rules this file exists to hold ────────────────────────────────────
   1. BY MAGIC, NEVER BY EXTENSION. A file somebody chose is arbitrary bytes and
      its name is the one part of it nothing verifies. A `.json` that is really
      gzip opens; a `.gz` that is really plain JSON opens too (which is also
      what the editor's no-compression fallback writes). This is the editor's
      `wizard.js` `readChosenText`, kept identical on purpose — the two apps
      have to agree about what a proposal file is.

   2. THE ORIGIN CHECK HAPPENS BEFORE THE FETCH. `connect-src` allows exactly
      `'self'` and `https://data.sustainable-fsa.com`; a CSP block is SILENT —
      the fetch rejects with a TypeError indistinguishable from a dead network,
      and the reader is told "could not be reached" about a url that was never
      going to be tried. Checked first, the answer is the true one: this tool
      does not fetch from there. A new origin is a CSP edit AND a verify § 1
      edit, never a silent addition here.

   3. ONE TOAST PER TURN. The kit's `showToast` is a singleton: a second call in
      the same turn means the first was never read. A drop of eight files can
      fail eight different ways, so the toast carries ONE sentence and the whole
      list goes to `#app-note.is-error`. Progress goes to the live region only —
      it is narration, not news.

   4. THE SENTENCES ARE THE ENGINE'S WHERE THE ENGINE RAISED THEM. A
      `ProposalError`/`SessionError` arrives carrying a § 15 sentence in
      `.message` and a machine-readable `.reason`; this file uses the message it
      was given and falls back to its own table only when a reason arrives with
      no sentence. The table below is authoritative for the failures load.js
      detects ITSELF — before the engine ever sees the bytes.

   Not DOM-free (it reads Files and fetches), but it touches no element: every
   sentence leaves through the `say` / `live` / `note` hooks the app hands in,
   and `attachDropTarget` is given its element.
   ========================================================================== */

import { looksLikeGzip, gunzipText } from '../vendor/usdm-editor/js/gzip.js';

/**
 * The cap on bytes ON DISK — the editor's `wizard.js` number, because the two
 * apps read the same files. The INFLATED size has its own cap inside the
 * vendored gzip.js (64 MB, checked against the trailer before the inflate
 * runs), which is the guard that matters for a compressed file: a few hundred
 * KB of zeroes inflate to gigabytes.
 */
export const MAX_FILE_BYTES = 24 * 1024 * 1024;

/** Where `?demo` starts. One fetch, then N — docs/contracts.md § 16.6. */
export const DEMO_INDEX = 'demo/index.json';

/**
 * The origins `?load=` may read a package from.
 *
 * A function, not a constant: `location.origin` is not knowable at module load
 * under Node, and this list has to be re-readable in a test that stubs it.
 * KEEP IN STEP WITH THE CSP `connect-src` IN index.html AND verify § 1.
 */
export function allowedOrigins() {
  const out = ['https://data.sustainable-fsa.com'];
  if (typeof location === 'object' && location?.origin) out.unshift(location.origin);
  return out;
}

/**
 * The refusals load.js raises on its own account (docs/contracts.md § 15).
 *
 * Every one of these is decided before the engine is called, so the sentence
 * has to live here. The engine's own reasons (`schemaV1`, `notAProposal`,
 * `missingGeometry`, `missingBands`, `missingWeek`, the session's week and
 * duplicate rules) arrive with their sentence already written — a thrown
 * `ProposalError`/`SessionError` carries it in `.message`, a session WARNING in
 * `.sentence`. The entries below that duplicate them are a FALLBACK for one
 * that arrives with a reason and no sentence, and they are written to match
 * § 15 word for word.
 */
export const SENTENCES = Object.freeze({
  notGzipOrJson: () => 'That file is neither JSON nor gzipped JSON.',
  badJson: () => 'That file could not be read as JSON.',
  notAProposal: ({ schema } = {}) =>
    `That is not a USDM proposal file — it says ${schema ? `\`${schema}\`` : 'nothing at all'}.`,
  schemaV1: () => 'That is a version 1 proposal. Version 1 cannot be compared — ' +
    'open it in the editor and save it again.',
  missingGeometry: () => 'That proposal carries no working-area geometry, so there is ' +
    'nothing to place it on.',
  missingBands: () => 'That proposal carries no derived bands, so its classes cannot be drawn.',
  missingWeek: () => 'That proposal does not say which week it was drawn against.',
  tooLarge: ({ mb } = {}) => `That file is larger than this tool will open (${mb} MB).`,
  badOrigin: ({ origin } = {}) => `${origin} is not an origin this tool will fetch from.`,
  unreachable: ({ status } = {}) => status
    ? `That file could not be fetched — the server answered ${status}.`
    : 'That file could not be fetched.',
  noDemoIndex: () => 'The bundled example set could not be read from this copy of the tool.',
  /* The session's two, for the same fallback reason. */
  differentWeek: ({ other, week } = {}) =>
    `That proposal was drawn against ${other ?? 'another week'}; this comparison is of ` +
    `${week ?? 'one week'} — load it in a session of its own.`,
  alreadyLoaded: () => 'That proposal is already loaded.',
});

/**
 * Intake.
 *
 * @param {object} deps
 * @param {object} deps.session  the engine's Session (docs/contracts.md § 3)
 * @param {(s: string) => void} deps.say   ONE toast
 * @param {(s: string) => void} deps.live  the polite live region
 * @param {(s: string, o?: {error?: boolean}) => void} deps.note  `#app-note`
 * @param {(report: object) => (void|Promise<void>)} deps.onLoaded
 *        called ONCE per run, after every file in it, so the app recomputes the
 *        comparison once for a dropped folder rather than once per file.
 */
export function createLoader({ session, say, live, note, onLoaded }) {
  /** True while a run is in flight — a second drop mid-run queues behind it. */
  let busy = null;

  /* ── The pipeline ──────────────────────────────────────────────────────── */

  /**
   * One file's bytes → one proposal in the session, or one problem.
   *
   * `name` is for the sentences and for `Proposal.fileName`; `source` is the
   * url it came from (null for a local file — which is exactly why a link to a
   * locally loaded session opens empty, and why the session line says so).
   */
  async function ingest(bytes, { name, source = null }, report) {
    if (bytes.length > MAX_FILE_BYTES) {
      return fail(report, name, 'tooLarge',
        { mb: (bytes.length / 1024 / 1024).toFixed(0) });
    }

    let text;
    try {
      text = looksLikeGzip(bytes)
        ? await gunzipText(bytes)
        : new TextDecoder().decode(bytes);
    } catch (err) {
      /* Only the UNWRAP can fail here, and it fails with a sentence of its own
         (truncated, or a browser with no DecompressionStream). Reported apart
         from the parse below: "not readable JSON" is the wrong thing to tell
         somebody whose download was cut short. */
      return fail(report, name, 'notGzipOrJson', {},
        `${name} could not be read — ${err.message}.`);
    }

    /* A gzip file whose contents are not JSON, and a plain file that is neither,
       land on the same sentence: what arrived is not a proposal package. The
       distinction between "not gzip" and "not JSON" is one the reader cannot
       act on differently. */
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      return fail(report, name, 'badJson');
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      return fail(report, name, 'notAProposal', { schema: null });
    }

    const sha256 = await sha256Of(bytes);

    try {
      const { proposal, warnings = [] } = await session.add(pkg, { fileName: name, sha256, source });
      report.loaded.push(proposal);
      for (const w of warnings) report.warnings.push(sentenceOf(w, name));
      return proposal;
    } catch (err) {
      return fail(report, name, err?.reason ?? 'notAProposal',
        { schema: typeof pkg.schema === 'string' ? pkg.schema : null }, err?.message);
    }
  }

  /** Record a refusal. Returns null so callers can `return fail(...)`. */
  function fail(report, name, reason, params = {}, message = null) {
    const sentence = message || SENTENCES[reason]?.(params) ||
      `${name} could not be loaded.`;
    report.problems.push({ name, reason, sentence });
    return null;
  }

  /**
   * A warning from the engine, as one readable sentence.
   *
   * js/session.js writes `{ reason, sentence }`; a thrown error carries
   * `.message`. Both are read here, in that order, so neither module has to
   * know which shape the other chose, and the table is the last resort.
   */
  function sentenceOf(w, name) {
    if (typeof w === 'string') return w;
    return w?.sentence || w?.message || SENTENCES[w?.reason]?.(w ?? {})
      || `${name} loaded with a warning.`;
  }

  /* ── The four ways in ──────────────────────────────────────────────────── */

  /**
   * Files from the picker, the empty state, or a drop.
   *
   * SEQUENTIAL, deliberately. Twelve packages are ~11 MiB of JSON once inflated
   * and each one is parsed, partitioned and frozen; running them in parallel
   * holds every intermediate string alive at once for no wall-clock gain (the
   * work is CPU, not latency). Sequential also makes load order — which is what
   * assigns the letters A, B, C… — the order the reader chose.
   */
  async function fromFiles(files) {
    const list = [...(files ?? [])];
    if (!list.length) return emptyReport();
    return run(async (report) => {
      let n = 0;
      for (const file of list) {
        live(`Reading ${file.name} — ${++n} of ${list.length}.`);
        let bytes;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
        } catch (err) {
          fail(report, file.name, 'notGzipOrJson', {},
            `${file.name} could not be read from disk — ${err.message}.`);
          continue;
        }
        await ingest(bytes, { name: file.name, source: null }, report);
      }
      report.local = report.loaded.length > 0;
    });
  }

  /**
   * `?load=<url>,…`.
   *
   * THE ORIGIN CHECK IS FIRST, for every url, BEFORE any fetch — see the
   * header. A refused url is a problem with a sentence, not an exception, and
   * the urls that pass are still loaded: one bad link in five does not cost the
   * other four.
   */
  async function fromUrls(urls) {
    const list = (urls ?? []).map((u) => String(u).trim()).filter(Boolean);
    if (!list.length) return emptyReport();
    return run(async (report) => {
      const ok = [];
      for (const raw of list) {
        let url;
        try {
          url = new URL(raw, location.href);
        } catch {
          fail(report, raw, 'badOrigin', { origin: raw });
          continue;
        }
        if (!allowedOrigins().includes(url.origin)) {
          fail(report, nameFromUrl(url), 'badOrigin', { origin: url.origin });
          continue;
        }
        ok.push(url);
      }
      let n = 0;
      for (const url of ok) {
        const name = nameFromUrl(url);
        live(`Fetching ${name} — ${++n} of ${ok.length}.`);
        let bytes;
        try {
          const res = await fetch(url.href);
          if (!res.ok) { fail(report, name, 'unreachable', { status: res.status }); continue; }
          bytes = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
          fail(report, name, 'unreachable', {},
            `${name} could not be fetched — ${err.message}.`);
          continue;
        }
        await ingest(bytes, { name, source: url.href }, report);
      }
    });
  }

  /**
   * `?demo` — the twelve bundled packages.
   *
   * One fetch of the index, then N, and the index's ORDER IS THE LOAD ORDER,
   * which is what assigns the letters. Same-origin by construction, so it goes
   * through `fromUrls` and inherits the origin check for free rather than
   * skipping it.
   */
  async function fromDemo() {
    let index;
    try {
      const res = await fetch(new URL(DEMO_INDEX, location.href).href);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index = await res.json();
    } catch (err) {
      console.warn('[viewer/load] the demo index could not be read', err);
      const report = emptyReport();
      report.problems.push({
        name: DEMO_INDEX, reason: 'noDemoIndex', sentence: SENTENCES.noDemoIndex(),
      });
      announce(report);
      return report;
    }
    const base = new URL(DEMO_INDEX, location.href);
    const files = (index?.files ?? []).map((f) => new URL(f, base).href);
    live(`Loading the example set — ${files.length} proposals for the week of ` +
      `${index?.week ?? 'an unnamed week'}.`);
    return fromUrls(files);
  }

  /**
   * Drag and drop over an element — the whole map frame, so the target is as
   * big as the thing a reader is looking at.
   *
   * `dragleave` fires on every child crossing, so the DEPTH COUNTER is not
   * defensive programming: without it the hint flickers off the moment the
   * pointer passes over the attribution control.
   *
   * @param {Element} element
   * @param {{onDragState?: (over: boolean) => void}} [opts]
   *        the app owns `#drop-hint`; this module owns the events.
   * @returns {() => void} unsubscribe
   */
  function attachDropTarget(element, { onDragState = () => {} } = {}) {
    if (!element) return () => {};
    let depth = 0;
    const hasFiles = (e) => !!e.dataTransfer?.types?.includes('Files');

    const onEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++; onDragState(true);
    };
    const onOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) onDragState(false);
    };
    const onDrop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0; onDragState(false);
      fromFiles(e.dataTransfer.files);
    };

    element.addEventListener('dragenter', onEnter);
    element.addEventListener('dragover', onOver);
    element.addEventListener('dragleave', onLeave);
    element.addEventListener('drop', onDrop);
    return () => {
      element.removeEventListener('dragenter', onEnter);
      element.removeEventListener('dragover', onOver);
      element.removeEventListener('dragleave', onLeave);
      element.removeEventListener('drop', onDrop);
    };
  }

  /* ── Running one turn ──────────────────────────────────────────────────── */

  /**
   * One intake turn: the work, then the app's recompute, then ONE sentence.
   *
   * Turns SERIALISE. Two drops a second apart would otherwise interleave their
   * `session.add`s, and load order is not an ordering anybody could then
   * predict — which would make the letters unstable across a reload.
   */
  function run(work) {
    const next = (busy ?? Promise.resolve()).then(async () => {
      const report = emptyReport();
      try {
        await work(report);
      } finally {
        if (report.loaded.length) {
          try {
            await onLoaded?.(report);
          } catch (err) {
            console.error('[viewer/load] the comparison failed', err);
            report.problems.push({
              name: 'the comparison', reason: 'compareFailed',
              sentence: `The proposals loaded, but the comparison failed — ${err?.message ?? 'unknown error'}.`,
            });
          }
        }
        announce(report);
      }
      return report;
    });
    busy = next.catch(() => {});
    return next;
  }

  /**
   * The one sentence, and the list.
   *
   * A CLEAN LOAD SAYS NOTHING HERE. The app announces what was found the moment
   * the comparison lands ("12 proposals loaded … 3 conflicts …"), and a toast
   * reading "12 files loaded" in front of it would spend the singleton's one
   * slot on the less informative of the two. This is the editor's rule at
   * `wizard.js` `openFile`, and it is why `say` is called at most once here.
   */
  function announce(report) {
    const { problems, warnings, loaded } = report;
    if (!problems.length && !warnings.length) { note(null); return; }

    if (problems.length) {
      /* The whole list on the map — a dropped folder can fail eight ways and a
         toast is one sentence. */
      note(problems.map((p) => `${p.name}: ${p.sentence}`).join(' '), { error: true });
    } else {
      note(warnings.join(' '));
    }

    if (problems.length === 1 && !warnings.length) {
      say(problems[0].sentence);
    } else if (problems.length > 1) {
      say(`${problems.length} files could not be loaded` +
        (loaded.length ? `; ${loaded.length} ${loaded.length === 1 ? 'was' : 'were'}` : '') +
        '. The reasons are listed over the map.');
    } else if (warnings.length === 1) {
      say(warnings[0]);
    } else {
      say(`${loaded.length} proposals loaded, with ${warnings.length} warnings — ` +
        'they are listed over the map.');
    }
  }

  return { fromFiles, fromUrls, fromDemo, attachDropTarget, get busy() { return busy; } };
}

/* ── Leaves ─────────────────────────────────────────────────────────────── */

function emptyReport() {
  return { loaded: [], problems: [], warnings: [], local: false };
}

/** The file name at the end of a url, for the sentences. */
function nameFromUrl(url) {
  const last = String(url.pathname ?? url).split('/').filter(Boolean).pop();
  return last || String(url);
}

/**
 * The sha256 of a file's BYTES — what `shasum -a 256 the-file.json.gz` prints,
 * so a brief's pin line is a thing a reader can check by hand.
 *
 * Null rather than an error where `crypto.subtle` is absent: it exists only in
 * a secure context, `http://` on a LAN address is not one, and a hash nobody
 * asked for must not be the reason a proposal will not open. `Proposal.sha256`
 * is documented as "or null when unknown" for exactly this.
 */
async function sha256Of(bytes) {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
