/* ══ Every module parses AS A MODULE ═════════════════════════════════════════
   USDM Edit Viewer · tools/parse.test.mjs

   One check, inherited from the editor, and it exists because of a specific
   escape there. A range delete in js/layers.js left a stray `});` at module top
   level; the app did not boot at all, and none of the gates that run in under a
   second noticed:

     · `node --check file.js` parses as COMMONJS, where a top-level `});` is
       legal. It reported the file fine.
     · tokens.test.mjs and html-validate never load js/.
     · the browser suites do — but they cost minutes, so they are the last thing
       you run, and this was the first thing that broke.

   `node --input-type=module --check` is the one-line difference, so it belongs
   in the fast half of the gate rather than behind Chromium.

   IT ALSO PARSES THE VENDORED COPY, which is not redundant: the copy is checked
   for BYTES by `sync-from-editor --check`, and for SYNTAX here. A half-finished
   copy (a `--write` interrupted mid-file) satisfies neither, and this is the
   cheaper of the two to read.

   It says NOTHING about whether the code is correct; it says the browser will
   get as far as running it, which is the failure mode this catches and the
   other cheap gates cannot.
   ========================================================================== */

import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = [
  'js',                                        // this app
  'vendor/usdm-editor/js',                     // the synced editor modules
  'vendor/usdm-editor/vendor/style/ui',        // the kit's components
  'tools',
];

let failures = 0;
const ok = (m) => console.log(`    ok   ${m}`);
const bad = (m) => { failures++; console.log(`    FAIL ${m}`); };

console.log('── every module parses as an ES module ─────────────────────────');

for (const dir of DIRS) {
  let names;
  try {
    names = readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.js') || n.endsWith('.mjs'));
  } catch {
    bad(`${dir} is not readable`);
    continue;
  }
  if (!names.length) { bad(`${dir} holds no modules — is the path still right?`); continue; }
  let clean = 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      /* Through stdin, because `--input-type` is only honoured for stdin and a
         `.js` file on disk is parsed by extension — which is exactly the
         CommonJS reading this test exists to avoid. */
      execFileSync(process.execPath, ['--input-type=module', '--check'],
        { input: readFileSync(join(ROOT, file)), stdio: ['pipe', 'pipe', 'pipe'] });
      clean++;
    } catch (err) {
      const why = String(err.stderr ?? err.message).split('\n')
        .find((l) => /SyntaxError/.test(l)) ?? 'unknown parse error';
      bad(`${file} — ${why.trim()}`);
    }
  }
  if (clean === names.length) ok(`${dir}: ${clean} module(s)`);
}

console.log(`\n${failures === 0 ? '✓ all checks passed' : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
