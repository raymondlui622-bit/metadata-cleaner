// EXIF (TIFF-structured) reader, plus a writer for a minimal orientation-only EXIF block.
import { add, hasAiHint, latin1 } from './common.js';

const NAMES = {
  0x000b: 'Processing software', 0x010e: 'Image description', 0x010f: 'Camera make', 0x0110: 'Camera model',
  0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'Date/time modified', 0x013b: 'Artist', 0x013c: 'Host computer',
  0x8298: 'Copyright', 0x829a: 'Exposure time', 0x829d: 'F-number', 0x8822: 'Exposure program', 0x8827: 'ISO',
  0x9003: 'Date/time original', 0x9004: 'Date/time digitized', 0x9010: 'Time zone', 0x9011: 'Time zone (original)',
  0x9012: 'Time zone (digitized)', 0x9207: 'Metering mode', 0x9209: 'Flash', 0x920a: 'Focal length', 0x927c: 'Maker notes',
  0x9286: 'User comment', 0x9290: 'Sub-second time', 0x9291: 'Sub-second time (original)', 0x9292: 'Sub-second time (digitized)',
  0x9c9b: 'Windows title', 0x9c9c: 'Windows comment', 0x9c9d: 'Windows author', 0x9c9e: 'Windows keywords', 0x9c9f: 'Windows subject',
  0xa403: 'White balance', 0xa420: 'Image unique ID', 0xa430: 'Camera owner', 0xa431: 'Camera serial number',
  0xa433: 'Lens make', 0xa434: 'Lens model', 0xa435: 'Lens serial number',
};
const CATS = {
  camera: [0x010f, 0x0110, 0x927c, 0xa430, 0xa431, 0xa433, 0xa434, 0xa435],
  dates: [0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292],
  software: [0x000b, 0x0131, 0x013c],
  author: [0x013b, 0x8298, 0x9c9d],
  text: [0x010e, 0x9286, 0x9c9b, 0x9c9c, 0x9c9e, 0x9c9f, 0xa420],
};
const TAG_CAT = new Map();
for (const [cat, tags] of Object.entries(CATS)) for (const t of tags) TAG_CAT.set(t, cat);
// Structural / rendering tags that are not "camera settings".
const STRUCTURAL = new Set([0x0112, 0x011a, 0x011b, 0x0128, 0x0213, 0x8769, 0x8825, 0xa005, 0x9000, 0xa000, 0xa001, 0xa002, 0xa003, 0x9101, 0x0201, 0x0202]);
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

// Parses TIFF bytes (starting at "II*\0" or "MM\0*"). Adds findings to the report.
// Returns { orientation, tagCount }. Never throws on malformed data — stops reading instead.
export function parseTiff(report, b) {
  const result = { orientation: 1, tagCount: 0 };
  if (b.length < 8) return result;
  const le = b[0] === 0x49;
  if (!(le ? b[1] === 0x49 && b[2] === 42 : b[0] === 0x4d && b[1] === 0x4d && b[3] === 42)) return result;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const r16 = (p) => dv.getUint16(p, le), r32 = (p) => dv.getUint32(p, le);
  const seen = new Set();
  const gps = {};

  const value = (type, count, p) => {
    const size = (SIZES[type] || 1) * count;
    const at = size > 4 ? r32(p) : p;
    if (at + size > b.length) return '';
    if (type === 2) return latin1(b.subarray(at, at + count)).replace(/\0+$/, '');
    if (type === 3 && count <= 4) return Array.from({ length: count }, (_, i) => r16(at + i * 2)).join(', ');
    if ((type === 4 || type === 13) && count === 1) return r32(at);
    if ((type === 5 || type === 10) && count <= 4) return Array.from({ length: count }, (_, i) => r32(at + i * 8) / (r32(at + i * 8 + 4) || 1));
    if (type === 1 && count <= 4) return Array.from(b.subarray(at, at + count)).join('.');
    if (type === 1 && count % 2 === 0) return new TextDecoder('utf-16le').decode(b.subarray(at, at + count)).replace(/\0+$/, ''); // XP* tags
    return `${size} bytes`;
  };

  const readIfd = (off, kind) => {
    if (!off || seen.has(off) || off + 2 > b.length || seen.size > 16) return 0;
    seen.add(off);
    const n = r16(off);
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      if (p + 12 > b.length) break;
      const tag = r16(p), type = r16(p + 2), count = r32(p + 4);
      if (!type || type > 13) continue;
      const v = value(type, count, p + 8);
      if (tag !== 0x0112) result.tagCount++; // orientation is intentionally kept, so not counted
      if (kind === 'gps') { gps[tag] = v; continue; }
      if (tag === 0x8769 || tag === 0xa005) { readIfd(Number(v), 'exif'); continue; }
      if (tag === 0x8825) { readIfd(Number(v), 'gps'); continue; }
      if (tag === 0x0112) { result.orientation = Number(v) || 1; continue; }
      const name = NAMES[tag] || `Tag 0x${tag.toString(16).padStart(4, '0')}`;
      const cat = TAG_CAT.get(tag) || (kind === 'exif' && !STRUCTURAL.has(tag) ? 'settings' : STRUCTURAL.has(tag) ? null : 'exif');
      if (cat) add(report, cat, name, v);
      if (typeof v === 'string' && hasAiHint(v)) add(report, 'ai', name, v);
    }
    return off + 2 + n * 12 + 4 <= b.length ? r32(off + 2 + n * 12) : 0;
  };

  const ifd1 = readIfd(r32(4), 'ifd0');
  if (ifd1 && !seen.has(ifd1) && ifd1 + 2 <= b.length) { readIfd(ifd1, 'ifd1'); add(report, 'thumbnail', 'EXIF thumbnail'); }

  if (Object.keys(gps).length) {
    const coord = (v, ref) => Array.isArray(v) && v.length === 3 ? `${(v[0] + v[1] / 60 + v[2] / 3600).toFixed(5)} ${ref || ''}` : 'present';
    add(report, 'gps', 'GPS latitude', coord(gps[2], gps[1]));
    add(report, 'gps', 'GPS longitude', coord(gps[4], gps[3]));
    if (gps[6] !== undefined) add(report, 'gps', 'GPS altitude', gps[6]);
  }
  if (result.tagCount) add(report, 'exif', 'EXIF tags', result.tagCount);
  return result;
}

// Minimal big-endian TIFF with one tag: Orientation. Used so cleaned photos still display upright.
export function orientationOnlyTiff(orientation) {
  const b = new Uint8Array(26);
  b.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  return b;
}
