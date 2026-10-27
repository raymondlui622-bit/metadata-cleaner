// HEIC / HEIF / AVIF (ISO-BMFF). Metadata lives in separate "items" (Exif, XMP, C2PA).
// Removing bytes would shift every offset in the file, so instead we overwrite the metadata
// items' bytes in place with blank values. Image data, rotation and colour boxes are untouched.
import { add, analyzeXmp, ascii, u16, u32, utf8, newReport, UserError } from './common.js';
import { parseTiff } from './tiff.js';

const BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis|MiHE|MiHA|MiHB)$/;
const EMPTY_EXIF = [0, 0, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]; // offset 0 + TIFF with no tags
const EMPTY_XMP = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'; // valid, empty

function boxes(b, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = u32(b, p), hdr = 8;
    const type = ascii(b, p + 4, 4);
    if (size === 1) { if (p + 16 > end) break; size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw new UserError('This HEIC file appears to be truncated or damaged.');
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (list, type) => list.find((x) => x.type === type);
const cstr = (b, p) => { const e = b.indexOf(0, p); const s = ascii(b, p, (e < 0 ? b.length : e) - p); return [s, e + 1]; };

function parse(b) {
  const top = boxes(b, 0, b.length);
  const ftyp = top[0]?.type === 'ftyp' ? top[0] : null;
  const brands = ftyp ? [ascii(b, ftyp.body, 4), ...Array.from({ length: (ftyp.end - ftyp.body - 8) / 4 }, (_, i) => ascii(b, ftyp.body + 8 + i * 4, 4))] : [];
  if (!brands.some((x) => BRANDS.test(x))) throw new UserError('Not a supported HEIC/HEIF image.');
  const meta = child(top, 'meta');
  if (!meta) throw new UserError('This HEIC file has no still image (it may be a video or sequence).');
  const mb = boxes(b, meta.body + 4, meta.end);
  const idat = child(mb, 'idat');

  const items = new Map();
  const iinf = child(mb, 'iinf');
  if (iinf) {
    const v = b[iinf.body];
    for (const infe of boxes(b, iinf.body + 4 + (v ? 4 : 2), iinf.end).filter((x) => x.type === 'infe')) {
      const iv = b[infe.body];
      let p = infe.body + 4, id, type = 'mime';
      if (iv >= 2) {
        id = iv === 2 ? u16(b, p) : u32(b, p); p += iv === 2 ? 4 : 6;
        type = ascii(b, p, 4); p += 4;
      } else { id = u16(b, p); p += 4; }
      let [, q] = cstr(b, p); // item name
      const contentType = type === 'mime' && q > 0 && q < infe.end ? cstr(b, q)[0] : '';
      items.set(id, { id, type, contentType, extents: [], method: 0 });
    }
  }

  const iloc = child(mb, 'iloc');
  if (iloc) {
    const v = b[iloc.body];
    let p = iloc.body + 4;
    const offSize = b[p] >> 4, lenSize = b[p] & 15, baseSize = b[p + 1] >> 4, idxSize = v ? b[p + 1] & 15 : 0;
    p += 2;
    const read = (n) => { const x = n === 8 ? u32(b, p) * 2 ** 32 + u32(b, p + 4) : n === 4 ? u32(b, p) : n === 2 ? u16(b, p) : 0; p += n; return x; };
    const count = read(v < 2 ? 2 : 4);
    for (let i = 0; i < count && p < iloc.end; i++) {
      const id = read(v < 2 ? 2 : 4);
      const method = v ? read(2) & 15 : 0;
      read(2); // data_reference_index
      const base = read(baseSize);
      const n = read(2);
      const extents = [];
      for (let k = 0; k < n; k++) {
        read(idxSize);
        const off = base + read(offSize), len = read(lenSize);
        const abs = method === 1 && idat ? idat.body + off : off;
        extents.push([abs, len || b.length - abs]);
      }
      const it = items.get(id);
      if (it) { it.extents = extents; it.method = method; }
    }
  }

  // primary image size + rotation/colour properties
  const info = { width: 0, height: 0, kept: [] };
  const pitm = child(mb, 'pitm');
  const primary = pitm ? (b[pitm.body] ? u32(b, pitm.body + 4) : u16(b, pitm.body + 4)) : 0;
  const iprp = child(mb, 'iprp');
  if (iprp) {
    const ib = boxes(b, iprp.body, iprp.end);
    const props = child(ib, 'ipco') ? boxes(b, child(ib, 'ipco').body, child(ib, 'ipco').end) : [];
    const ipma = child(ib, 'ipma');
    if (ipma) {
      const v = b[ipma.body], wide = b[ipma.body + 3] & 1;
      let p = ipma.body + 4;
      const n = u32(b, p); p += 4;
      for (let i = 0; i < n && p < ipma.end; i++) {
        const id = v ? u32(b, p) : u16(b, p); p += v ? 4 : 2;
        const c = b[p++];
        for (let k = 0; k < c; k++) {
          const idx = wide ? u16(b, p) & 0x7fff : b[p] & 0x7f; p += wide ? 2 : 1;
          const prop = props[idx - 1];
          if (id !== primary || !prop) continue;
          if (prop.type === 'ispe') { info.width = u32(b, prop.body + 4); info.height = u32(b, prop.body + 8); }
          if (prop.type === 'irot' || prop.type === 'imir') info.kept.push('Rotation (keeps the photo upright)');
          if (prop.type === 'colr') info.kept.push('Colour profile');
        }
      }
    }
  }
  const uuids = top.filter((x) => x.type === 'uuid');
  return { items: [...items.values()], info, uuids };
}

const itemData = (b, it) => {
  const parts = it.extents.filter(([o, l]) => o + l <= b.length).map(([o, l]) => b.subarray(o, o + l));
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
};
const kind = (it) => it.type === 'Exif' ? 'exif'
  : it.type === 'mime' && /rdf\+xml|xmp/i.test(it.contentType) ? 'xmp'
  : it.type === 'mime' && /c2pa/i.test(it.contentType) ? 'c2pa'
  : it.type === 'mime' && !/^image\//.test(it.contentType) ? 'mime' : null;

export async function inspect(b) {
  const r = newReport('heic', 'HEIC/HEIF image');
  const { items, info, uuids } = parse(b);
  for (const it of items) {
    const k = kind(it);
    if (!k) continue;
    const d = itemData(b, it);
    if (!d.some((x) => x !== 0 && x !== 0x20) || (k === 'xmp' && utf8(d).trim() === EMPTY_XMP)) continue; // blank
    if (it.method === 2) add(r, 'other', 'Metadata stored by reference (not removable)');
    if (k === 'exif') parseTiff(r, d.subarray(4 + u32(d, 0)));
    else if (k === 'xmp') analyzeXmp(r, utf8(d));
    else if (k === 'c2pa') add(r, 'ai', 'C2PA content credentials', `${d.length} bytes`);
    else add(r, 'other', `Embedded "${it.contentType || 'unknown'}" data`, `${d.length} bytes`);
  }
  for (const u of uuids) if (b.subarray(u.body, u.end).some((x) => x)) add(r, 'other', 'Custom "uuid" data box (may hold C2PA credentials)', `${u.end - u.start} bytes`);
  Object.assign(r, { width: info.width, height: info.height, kept: [...new Set(info.kept)] });
  if (!r.width) throw new UserError('Could not find the main image in this HEIC file.');
  return r;
}

export async function clean(b) {
  const { items, uuids } = parse(b);
  const out = new Uint8Array(b); // copy — original untouched
  const notes = [];
  for (const it of items) {
    const k = kind(it);
    if (!k || it.method === 2) continue;
    const size = it.extents.reduce((n, [, l]) => n + l, 0);
    const fill = k === 'exif' ? EMPTY_EXIF : k === 'xmp' && size >= EMPTY_XMP.length ? [...new TextEncoder().encode(EMPTY_XMP)] : [];
    let i = 0;
    for (const [o, l] of it.extents) {
      for (let p = o; p < o + l && p < out.length; p++, i++) out[p] = i < fill.length ? fill[i] : k === 'xmp' ? 0x20 : 0;
    }
  }
  for (const u of uuids) { out.set([0x66, 0x72, 0x65, 0x65], u.start + 4); out.fill(0, u.body, u.end); } // → "free" box
  notes.push('Metadata was blanked in place, so the file size stays the same. Image data was not touched.');
  return { bytes: out, notes };
}
