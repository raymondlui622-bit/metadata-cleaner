// Detects file type from its bytes, cleans it, then re-inspects the OUTPUT to verify the result.
import { CATEGORIES, indexOfAscii, UserError } from './common.js';
import * as jpeg from './jpeg.js';
import * as png from './png.js';
import * as heic from './heic.js';

const EXT = { jpeg: 'jpg', png: 'png', heic: 'heic', pdf: 'pdf' };
export const MAX_BYTES = 300 * 1024 * 1024;
// Signatures that should never appear in a cleaned image (checked as a second, independent safety net).
const RAW_SIGNATURES = ['<x:xmpmeta', 'http://ns.adobe.com/xap/1.0/', 'Photoshop 3.0\0', 'c2pa.', 'XML:com.adobe.xmp'];

export function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'heic';
  if (indexOfAscii(b.subarray(0, 1024), '%PDF-') !== -1) return 'pdf';
  return null;
}

const handler = async (type) => type === 'pdf' ? import('./pdf.js') : { jpeg, png, heic }[type];

export function cleanName(name, type, index) {
  if (index !== undefined) return `${type === 'pdf' ? 'document' : 'image'}_${index}_clean.${EXT[type]}`;
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,5})?$/);
  return `${m[1] || 'file'}_clean${m[2] || '.' + EXT[type]}`;
}

function unsupported(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const hints = {
    gif: 'GIF images are not supported yet.', webp: 'WebP images are not supported yet.',
    tif: 'TIFF images are not supported.', tiff: 'TIFF images are not supported.',
    mov: 'Videos are not supported.', mp4: 'Videos are not supported.',
    docx: 'Word documents are not supported. Export to PDF first.', doc: 'Word documents are not supported. Export to PDF first.',
    dng: 'RAW photos are not supported.',
  };
  return new UserError(hints[ext] || 'This file type is not supported. Supported: JPG, PNG, HEIC/HEIF and PDF.');
}

export async function inspectBytes(bytes, name = '') {
  const type = sniff(bytes);
  if (!type) throw unsupported(name);
  return (await handler(type)).inspect(bytes);
}

const PDF_OPTIONAL = new Set(['annotations', 'attachments', 'scripts']);

// Returns { type, bytes, before, after, rows, kept, notes, warnings, status }
// status: 'clean' | 'remains' | 'unverified'
export async function cleanBytes(bytes, name = '', opts = {}) {
  const type = sniff(bytes);
  if (!type) throw unsupported(name);
  const mod = await handler(type);
  const before = await mod.inspect(bytes);
  const { bytes: out, notes } = await mod.clean(bytes, opts);
  const warnings = [];

  let after = null;
  try { after = await mod.inspect(out); } catch (e) { warnings.push(`Could not re-read the cleaned file to verify it (${e.message}).`); }
  if (after && type !== 'pdf') {
    for (const sig of RAW_SIGNATURES) if (indexOfAscii(out, sig) !== -1) after.found.add('other'), after.details.push(['other', 'Leftover metadata signature', sig.replace('\0', '')]);
    if (after.width !== before.width || after.height !== before.height) warnings.push(`Image size changed (${before.width}×${before.height} → ${after.width}×${after.height}).`);
  }
  if (after && type === 'pdf') {
    if (after.pages !== before.pages) warnings.push(`Page count changed (${before.pages} → ${after.pages}).`);
    else if (after.pageSizes.join() !== before.pageSizes.join()) warnings.push('Page sizes changed.');
  }

  const rows = [];
  for (const cat of Object.keys(CATEGORIES)) {
    const was = before.found.has(cat), now = after ? after.found.has(cat) : null;
    if (!was && !now) continue;
    let result;
    if (!after) result = 'Not verified';
    else if (!now) result = 'Removed';
    else if (PDF_OPTIONAL.has(cat) && !opts[cat]) result = 'Kept (not selected)';
    else result = 'Potential metadata remains';
    rows.push({ cat, label: CATEGORIES[cat], before: was ? 'Found' : 'Not found', after: result });
  }
  const status = !after || warnings.length ? 'unverified'
    : rows.some((r) => r.after === 'Potential metadata remains') ? 'remains' : 'clean';
  return { type, bytes: out, before, after, rows, kept: before.kept, notes, warnings, status };
}

// Cleans files one at a time (keeps memory low on iPhone). One failure never stops the batch.
// files: [{ name, size, read: () => Promise<Uint8Array> }]; onResult(index, { name, ok, error?, ...result })
export async function cleanBatch(files, opts, onResult) {
  for (const [i, f] of files.entries()) {
    let res;
    try {
      if (f.size > MAX_BYTES) throw new UserError('This file is too large to process on this device (limit 300 MB).');
      res = { name: f.name, ok: true, ...(await cleanBytes(await f.read(), f.name, opts)) };
    } catch (e) {
      res = { name: f.name, ok: false, error: e instanceof UserError ? e.message : 'This file appears to be damaged or uses an unsupported structure. It was not changed.' };
    }
    await onResult(i, res);
  }
}
