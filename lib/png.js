// PNG: lossless metadata removal by keeping only image/colour chunks. Pixel data is copied byte-for-byte.
import { add, analyzeXmp, hasAiHint, latin1, utf8, ascii, u32, concat, inflate, newReport, UserError } from './common.js';
import { parseTiff, orientationOnlyTiff } from './tiff.js';
import { crc32 } from './zip.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
// Chunks needed to display the image correctly (incl. colour + animation). Everything else is dropped.
const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'mDCv', 'cLLI', 'cLLi',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);
const AI_KEYS = /^(parameters|prompt|workflow|negative_prompt|Dream|sd-metadata|invokeai_metadata|generation_data|AI)$/i;

function chunks(b) {
  if (!SIG.every((x, i) => b[i] === x)) throw new UserError('Not a valid PNG file.');
  const out = [];
  for (let p = 8; p < b.length;) {
    if (p + 12 > b.length) throw new UserError('This PNG appears to be truncated or damaged.');
    const len = u32(b, p), type = ascii(b, p + 4, 4);
    const end = p + 12 + len;
    if (end > b.length || !/^[A-Za-z]{4}$/.test(type)) throw new UserError('This PNG appears to be truncated or damaged.');
    out.push({ type, start: p, end, data: b.subarray(p + 8, p + 8 + len) });
    p = end;
    if (type === 'IEND') return { out, iend: end };
  }
  throw new UserError('This PNG is incomplete (no end chunk).');
}

async function textChunk(r, type, d) {
  const nul = d.indexOf(0);
  const key = latin1(d.subarray(0, nul));
  let value = '';
  try {
    if (type === 'tEXt') value = latin1(d.subarray(nul + 1));
    else if (type === 'zTXt') value = latin1(await inflate(d.subarray(nul + 2)));
    else { // iTXt: key\0 flag method lang\0 translated\0 text
      const flag = d[nul + 1];
      let p = d.indexOf(0, nul + 3); p = d.indexOf(0, p + 1) + 1;
      value = utf8(flag ? await inflate(d.subarray(p)) : d.subarray(p));
    }
  } catch { value = '(unreadable)'; }
  if (key === 'XML:com.adobe.xmp') return analyzeXmp(r, value);
  if (/^Raw profile type (exif|APP1)$/i.test(key)) return add(r, 'exif', key, `${value.length} characters`);
  const cat = AI_KEYS.test(key) ? 'ai'
    : /^(Author|Copyright|Artist)$/i.test(key) ? 'author'
    : /^(Creation Time|Date|Time|ModifyDate)$/i.test(key) ? 'dates'
    : /^(Software|Source)$/i.test(key) ? 'software'
    : 'text';
  add(r, cat, `Text field "${key}"`, value);
  if (cat !== 'ai' && hasAiHint(value)) add(r, 'ai', `Text field "${key}"`, value);
}

export async function inspect(b) {
  const r = newReport('png', 'PNG image');
  const { out, iend } = chunks(b);
  for (const c of out) {
    const d = c.data;
    if (c.type === 'IHDR') { r.width = u32(d, 0); r.height = u32(d, 4); }
    else if (c.type === 'iCCP') r.kept.push('Colour profile');
    else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') await textChunk(r, c.type, d);
    else if (c.type === 'eXIf') r.orientation = parseTiff(r, d).orientation;
    else if (c.type === 'tIME') add(r, 'dates', 'Last modified time');
    else if (c.type === 'caBX') add(r, 'ai', 'C2PA content credentials', `${d.length} bytes`);
    else if (!KEEP.has(c.type)) add(r, 'other', `Chunk "${c.type}"`, `${d.length} bytes`);
  }
  if (iend < b.length) add(r, 'other', 'Data after end of image', `${b.length - iend} bytes`);
  if (!r.width) throw new UserError('This PNG has no image header.');
  if (r.orientation > 1) r.kept.push('Orientation (keeps the image upright)');
  return r;
}

function makeChunk(type, data) {
  const c = new Uint8Array(12 + data.length);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, data.length);
  c.set(new TextEncoder().encode(type), 4);
  c.set(data, 8);
  dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
  return c;
}

export async function clean(b) {
  const { out } = chunks(b);
  const exif = out.find((c) => c.type === 'eXIf');
  const orientation = exif ? parseTiff(newReport(), exif.data).orientation : 1;
  const parts = [b.subarray(0, 8)];
  let wroteExif = false;
  for (const c of out) {
    if (!KEEP.has(c.type)) continue;
    if (c.type === 'IDAT' && !wroteExif && orientation > 1 && orientation <= 8) {
      parts.push(makeChunk('eXIf', orientationOnlyTiff(orientation)));
      wroteExif = true;
    }
    parts.push(b.subarray(c.start, c.end));
  }
  return { bytes: concat(parts), notes: wroteExif ? ['Kept the orientation tag so the image stays upright.'] : [] };
}
