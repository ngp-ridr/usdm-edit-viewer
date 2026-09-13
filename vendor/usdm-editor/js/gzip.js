/* ============================================================================
   USDM Editor · js/gzip.js
   Text in, gzip out — and back. A LEAF: it imports nothing, touches no DOM,
   and knows nothing about proposals; js/submit.js names the file and
   js/wizard.js unwraps it.

   WHY IT EXISTS: the proposal travels by email as an attachment, and a
   pretty-printed package is mostly coordinates and indentation. Measured on
   a real one — the Montana proposal tools/verify.mjs § 6 builds and downloads
   — 694 KB of JSON in a ~128 KB file, 18%. Printed rings ALONE do better
   (97 KB → 13 KB, tools/gzip.test.mjs); a package carrying evidence PHOTOS
   does worse, because they ride as base64 JPEG (js/image.js) and base64 of
   already-compressed bytes deflates to about 76%. Every one of those is a
   win and none is a promise, which is why nothing in this app asserts a
   ratio.

   GZIP, NOT ZIP — a decision made 2026-09-12 after shipping zip for a day.
   Same deflate underneath, so the same size; the difference is the wrapper.
   A `.json.gz` SAYS what it holds where a `.zip` hides it until opened; it
   is one stream rather than a container with a directory, so the whole
   format is the platform's `CompressionStream('gzip')` and there is no
   header, CRC or directory code of this app's to get wrong (gzip carries its
   own CRC-32 and length in its trailer, and the decompressor checks both);
   `.zip` is the one archive type mail filters specifically target; and a
   server-side gate can serve or accept `.json.gz` as `Content-Encoding:
   gzip` and never see a container at all. What it costs: Windows before 11
   (23H2) does not open `.gz` by double-click. Accepted.

   NO FALLBACK COMPRESSION. Where `CompressionStream` is missing (or lacks
   'gzip'), `gzipText` answers null and the caller writes PLAIN JSON under a
   `.json` name — a bigger attachment, not an error, and a file this app
   reads back the same way (js/wizard.js sniffs the magic bytes, never the
   extension). A ZIP could fall back to a stored entry; gzip has no stored
   mode, and inventing one would be the container code this file exists not
   to have.
   ========================================================================== */

/** RFC 1952 § 2.3.1: every gzip member begins 1f 8b. */
const MAGIC_0 = 0x1f;
const MAGIC_1 = 0x8b;

/**
 * What this app is willing to INFLATE from a file somebody chose.
 *
 * The caller's own size cap is on the bytes ON DISK, and a compressed file is
 * exactly the shape that defeats it — a few hundred KB of zeroes inflate to
 * gigabytes. The trailer's ISIZE (uncompressed length mod 2^32) is checked
 * BEFORE the inflate runs, and the output again after, because the trailer is
 * just four bytes in a file.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** Can this engine gzip? Cached after the first answer. */
let canGzip = null;
function gzipAvailable() {
  if (canGzip !== null) return canGzip;
  try {
    canGzip = typeof CompressionStream === 'function' && !!new CompressionStream('gzip');
  } catch {
    /* Safari shipped CompressionStream before every format; asking for one it
       lacks throws. Not an error — the caller writes plain JSON. */
    canGzip = false;
  }
  return canGzip;
}

/**
 * Text, gzipped.
 *
 * @param {string} text
 * @returns {Promise<Blob|null>} `application/gzip`, or null when this
 *          browser cannot compress — the caller then writes the text as is.
 */
export async function gzipText(text) {
  if (!gzipAvailable()) return null;
  const raw = new TextEncoder().encode(text);
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
  } catch (err) {
    console.warn('[usdm/gzip] compression failed; writing the text uncompressed', err);
    return null;
  }
}

/**
 * Do these bytes start like a gzip file?
 *
 * By MAGIC, not by filename: a file somebody chose is arbitrary bytes and its
 * name is the one part of it nothing verifies.
 *
 * @param {Uint8Array} bytes
 */
export function looksLikeGzip(bytes) {
  return bytes.length >= 18 && bytes[0] === MAGIC_0 && bytes[1] === MAGIC_1;
}

/**
 * The uncompressed length a gzip file claims, from its trailer — ISIZE, the
 * last four bytes, little-endian, mod 2^32. Meaningful only for a single-
 * member file, which is every file this app writes and every one it expects.
 */
function claimedSize(bytes) {
  const n = bytes.length;
  return (bytes[n - 4] | (bytes[n - 3] << 8) | (bytes[n - 2] << 16) | (bytes[n - 1] << 24)) >>> 0;
}

/**
 * A gzip file's text.
 *
 * @param {Uint8Array} bytes the whole file
 * @returns {Promise<string>}
 */
export async function gunzipText(bytes) {
  if (!looksLikeGzip(bytes)) throw new Error('the file is not gzip');
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot read a compressed file');
  }
  /* A TRUNCATED file has a random trailer, so an absurd ISIZE is as likely to
     mean "cut short" as "too big" — the sentence says both. */
  const claimed = claimedSize(bytes);
  if (claimed > MAX_INFLATED_BYTES) {
    throw new Error('the file is cut short, or says it unpacks to ' +
      `${(claimed / 1024 / 1024).toFixed(0)} MB — more than this tool will read`);
  }
  let out;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    /* SAY SOMETHING. A stream that rejects on corrupt or truncated input
       rejects with an error whose `message` is EMPTY in Chromium, and this
       message is shown to the author verbatim (js/wizard.js). The
       decompressor has already checked the trailer's CRC-32 and length, so
       "damaged" is what a rejection means. */
    throw new Error('the compressed data is damaged or cut short and could not be unpacked' +
      (err?.message ? ` (${err.message})` : ''));
  }
  if (out.length > MAX_INFLATED_BYTES) {
    throw new Error('the file unpacked to more than this tool will read');
  }
  return new TextDecoder().decode(out);
}
