// JPEG: lossless metadata removal by dropping marker segments. Pixel data is copied byte-for-byte.
import { add, analyzeXmp, analyzePhotoshop, hasAiHint, latin1, utf8, startsWith, concat, u16, newReport, UserError } from './common.js';
import { parseTiff, orientationOnlyTiff } from './tiff.js';

const EXIF = 'Exif\0\0', XMP = 'http://ns.adobe.com/xap/1.0/\0', XMP_EXT = 'http://ns.adobe.com/xmp/extension/\0';
const ICC = 'ICC_PROFILE\0';

// Splits a JPEG into segments: { marker, start, end, data } where data excludes marker + length.
// The entropy-coded scan data after SOS is included in that SOS segment.
function segments(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new UserError('Not a valid JPEG file.');
  const out = [];
  let p = 2;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new UserError('This JPEG appears to be damaged (unexpected data).');
    while (b[p] === 0xff && b[p + 1] === 0xff) p++; // fill bytes
    const marker = b[p + 1];
    if (marker === 0xd9) { out.push({ marker, start: p, end: p + 2 }); return { out, eoi: p + 2 }; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    if (p + 4 > b.length) break;
    const len = u16(b, p + 2);
    let end = p + 2 + len;
    if (len < 2 || end > b.length) throw new UserError('This JPEG appears to be truncated or damaged.');
    if (marker === 0xda) { // scan data runs until the next real marker
      while (end < b.length - 1 && !(b[end] === 0xff && b[end + 1] !== 0 && !(b[end + 1] >= 0xd0 && b[end + 1] <= 0xd7))) end++;
      if (end >= b.length - 1) end = b.length;
    }
    out.push({ marker, start: p, end, data: b.subarray(p + 4, p + 2 + len) });
    p = end;
  }
  throw new UserError('This JPEG is incomplete (no end-of-image marker).');
}

export async function inspect(b) {
  const r = newReport('jpeg', 'JPEG image');
  const { out, eoi } = segments(b);
  for (const s of out) {
    const d = s.data, m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && d) { r.height = u16(d, 1); r.width = u16(d, 3); }
    else if (m === 0xe0) {
      if (startsWith(d, 0, 'JFXX')) add(r, 'thumbnail', 'JFIF extension thumbnail');
      else if (startsWith(d, 0, 'JFIF') && d[12] * d[13] > 0) add(r, 'thumbnail', 'JFIF thumbnail');
      else if (!startsWith(d, 0, 'JFIF')) add(r, 'other', 'APP0 data');
    } else if (m === 0xe1) {
      if (startsWith(d, 0, EXIF)) r.orientation = parseTiff(r, d.subarray(6)).orientation;
      else if (startsWith(d, 0, XMP)) analyzeXmp(r, utf8(d.subarray(XMP.length)));
      else if (startsWith(d, 0, XMP_EXT)) analyzeXmp(r, utf8(d.subarray(XMP_EXT.length + 40)));
      else add(r, 'other', 'APP1 data', `${d.length} bytes`);
    } else if (m === 0xe2) {
      if (startsWith(d, 0, ICC)) { if (!r.kept.includes('Colour profile')) r.kept.push('Colour profile'); }
      else if (startsWith(d, 0, 'MPF\0')) add(r, 'other', 'Extra embedded images (HDR / depth map)');
      else add(r, 'other', 'APP2 data', `${d.length} bytes`);
    } else if (m === 0xeb) {
      add(r, 'ai', 'C2PA / JUMBF content credentials', `${d.length} bytes`);
    } else if (m === 0xed) {
      if (startsWith(d, 0, 'Photoshop 3.0\0')) analyzePhotoshop(r, d.subarray(14));
      else add(r, 'other', 'APP13 data');
    } else if (m === 0xfe) {
      const text = latin1(d);
      add(r, 'text', 'JPEG comment', text);
      if (hasAiHint(text)) add(r, 'ai', 'Comment AI marker', text);
    } else if (m === 0xec && startsWith(d, 0, 'Ducky')) add(r, 'software', 'Photoshop "Save for Web" data');
    else if (m >= 0xe3 && m <= 0xef && m !== 0xee) add(r, 'other', `APP${m - 0xe0} segment`, `${d.length} bytes`);
  }
  if (eoi < b.length && b.subarray(eoi).some((x) => x !== 0)) add(r, 'other', 'Data after end of image', `${b.length - eoi} bytes`);
  if (!r.width) throw new UserError('This JPEG has no image frame.');
  if (r.orientation > 1) r.kept.push('Orientation (keeps the photo upright)');
  return r;
}

export async function clean(b) {
  const { out } = segments(b);
  let orientation = 1;
  const parts = [new Uint8Array([0xff, 0xd8])];
  let insertAt = 1;
  for (const s of out) {
    const d = s.data, m = s.marker;
    if (m === 0xe0) {
      if (startsWith(d, 0, 'JFIF') && d.length >= 12) { // rebuild JFIF header without its thumbnail
        parts.push(new Uint8Array([0xff, 0xe0, 0, 16, ...d.subarray(0, 12), 0, 0]));
        insertAt = parts.length;
      }
      continue;
    }
    if (m === 0xe1) {
      if (startsWith(d, 0, EXIF)) orientation = parseTiff(newReport(), d.subarray(6)).orientation;
      continue;
    }
    if (m === 0xe2 && !startsWith(d, 0, ICC)) continue; // keep colour profile only
    if (m === 0xee || m === 0xe2 || m < 0xe0 || (m > 0xef && m !== 0xfe)) { parts.push(b.subarray(s.start, s.end)); continue; }
    // everything else: APP3–APP13, APP15, COM — dropped
  }
  if (orientation > 1 && orientation <= 8) {
    const tiff = orientationOnlyTiff(orientation);
    const len = 2 + 6 + tiff.length;
    parts.splice(insertAt, 0, concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), new TextEncoder().encode(EXIF), tiff]));
  }
  // EOI is the last segment; anything after it (trailers, extra images) is dropped.
  return { bytes: concat(parts), notes: orientation > 1 ? ['Kept the orientation tag so the photo stays upright.'] : [] };
}
