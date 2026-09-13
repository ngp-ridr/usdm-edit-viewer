/* ══ js/image.js — a photo becomes a data: URI the proposal can carry ═════════
   Serverless, so there is nowhere to host an image: it travels INSIDE the
   markdown as `![caption](data:image/…;base64,…)` — in a rationale, in the
   narrative, in an Evidence row — and the proposal JSON stays one self-contained
   file a reviewer can open with nothing but a markdown renderer. The price is
   bytes, so every image is DOWNSCALED here before it is stored: longest edge
   `IMAGE_MAX_EDGE`, JPEG at `IMAGE_QUALITY` (PNG kept for PNG/GIF sources, which
   may carry transparency; a GIF becomes its first frame), and refused past
   `IMAGE_MAX_CHARS` even after three rounds of shrinking. The soft total is
   advice on step 4, not a gate: `IMAGE_SOFT_TOTAL_CHARS`.

   `IMAGE_DATA_URL_RE` is the ONE gate the sanitizer (js/mdtext.js `cleanInto`)
   and the evidence validator (js/justify.js) both apply: an <img> whose src is
   not a base64 data URI of one of the four types is not an image here. Never a
   remote URL — `img-src 'self' data: blob:` would refuse to render it, and an
   emailed proposal that fetches from a third party is a beacon.

   DOM module (canvas, createImageBitmap); imports nothing from the engine.
   ══════════════════════════════════════════════════════════════════════════ */

/** The four raster types a browser decodes everywhere and a reviewer can open. */
export const IMAGE_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Longest edge after downscaling, px. A screenshot or a phone photo at 1600 px
    reads fine in a card and on a printed brief; 4000 px is bytes, not evidence. */
export const IMAGE_MAX_EDGE = 1600;
/** JPEG quality. 0.82 is where a photo stops looking re-encoded. */
export const IMAGE_QUALITY = 0.82;
/** Cap on ONE stored image, measured as the data-URL's length (≈ 1.5 MB decoded). */
export const IMAGE_MAX_CHARS = 2 * 1024 * 1024;
/** Past this many characters of images in a package, step 4 says so. */
export const IMAGE_SOFT_TOTAL_CHARS = 8 * 1024 * 1024;

/** Exactly the shape `canvas.toDataURL` produces for the allowed types. */
export const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isImageDataURL(s) {
  return typeof s === 'string' && s.length <= IMAGE_MAX_CHARS * 2 && IMAGE_DATA_URL_RE.test(s);
}

/**
 * Read a File the author picked (or pasted, or dropped) into a stored image.
 *
 * @param {File|Blob} file
 * @returns {Promise<{dataURL: string, width: number, height: number}>}
 * @throws {Error} with a SENTENCE for the author — wrong type, undecodable, or
 *         too large even after resizing.
 */
export async function readImageFile(file) {
  if (!file || !IMAGE_MIME.includes(file.type)) {
    throw new Error('That is not an image this tool can carry — use a PNG, JPEG, WebP or GIF.');
  }
  const bitmap = await decode(file);
  const keepPNG = file.type === 'image/png' || file.type === 'image/gif';
  let edge = IMAGE_MAX_EDGE;
  let type = keepPNG ? 'image/png' : 'image/jpeg';
  /* Up to four attempts: at the full edge (PNG for PNG/GIF, else JPEG), then
     JPEG, then three-quarters, then three-quarters again. */
  for (let attempt = 0; attempt < 4; attempt++) {
    const { canvas, width, height } = draw(bitmap, edge);
    const dataURL = canvas.toDataURL(type, type === 'image/jpeg' ? IMAGE_QUALITY : undefined);
    if (dataURL.length <= IMAGE_MAX_CHARS && IMAGE_DATA_URL_RE.test(dataURL)) {
      release(bitmap);
      return { dataURL, width, height };
    }
    if (type === 'image/png') type = 'image/jpeg';
    else edge = Math.round(edge * 0.75);
  }
  release(bitmap);
  throw new Error('That image is too large to carry even after resizing — try a smaller crop.');
}

/** Decode with EXIF orientation honoured where the browser can. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { /* fall through to the <img> route */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('That image could not be read.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function release(bitmap) {
  try { bitmap.close?.(); } catch { /* an <img> has nothing to close */ }
}

function draw(bitmap, maxEdge) {
  const w = bitmap.width ?? bitmap.naturalWidth, h = bitmap.height ?? bitmap.naturalHeight;
  if (!w || !h) throw new Error('That image could not be read.');
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  return { canvas, width, height };
}

/** Characters of image data in one markdown string. */
export function imageChars(markdown) {
  if (typeof markdown !== 'string' || !markdown.includes('data:image/')) return 0;
  let n = 0;
  for (const m of markdown.matchAll(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/g)) n += m[0].length;
  return n;
}

/**
 * Characters of image data across a built package: the justification's
 * prose, every evidence photo, and every change's rationale — which COPIES a
 * grouped reason into each member, so a photo in a group counts once per
 * member here exactly as it does in the file.
 */
export function packageImageChars(pkg) {
  let n = 0;
  const j = pkg?.justification ?? {};
  n += imageChars(j.rationale) + imageChars(j.impacts);
  for (const e of Array.isArray(j.evidence) ? j.evidence : []) if (isImageDataURL(e?.image)) n += e.image.length;
  for (const c of Array.isArray(pkg?.proposedChanges) ? pkg.proposedChanges : []) n += imageChars(c?.rationale);
  return n;
}
