// Shared helpers: category labels, text analysis (XMP / IPTC / AI hints), byte utilities.

// Every metadata finding maps to one of these user-facing categories.
export const CATEGORIES = {
  gps: 'Location (GPS / place names)',
  camera: 'Camera & device info',
  settings: 'Camera settings',
  dates: 'Dates & times',
  software: 'Software & editing history',
  author: 'Author & copyright',
  text: 'Titles, descriptions & comments',
  ai: 'AI generation / provenance info',
  exif: 'EXIF data block',
  xmp: 'XMP data block',
  iptc: 'IPTC data block',
  thumbnail: 'Embedded preview thumbnail',
  other: 'Other hidden data',
  // PDF-specific
  docinfo: 'Document properties',
  objmeta: 'Metadata inside pages, images or fonts',
  docid: 'Document ID (file fingerprint)',
  revisions: 'Earlier saved versions',
  annotations: 'Comments & annotations',
  attachments: 'Attached files',
  scripts: 'Scripts (JavaScript)',
};

export function newReport(type, label) {
  return { type, label, found: new Set(), details: [], kept: [], width: 0, height: 0, pages: 0, pageSizes: [] };
}

export function add(report, cat, key, value) {
  report.found.add(cat);
  if (key) report.details.push([cat, key, value === undefined ? '' : String(value).slice(0, 200)]);
}

const AI_RE = /trainedAlgorithmicMedia|compositeSynthetic|algorithmicMedia|c2pa|OpenAI|ChatGPT|DALL[·\-\s]?E|Midjourney|Stable Diffusion|Adobe Firefly|Imagen|Gemini|Google AI|AI[- ]generated|Made with AI|Anthropic|Ideogram|Leonardo\.ai|sora/i;
export const hasAiHint = (text) => AI_RE.test(text);

const XMP_RULES = [
  ['gps', /exif:GPS|photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)|LocationCreated|LocationShown/],
  ['camera', /tiff:(Make|Model)|aux:(SerialNumber|Lens|OwnerName)|exifEX:(Lens|BodySerial|CameraOwner)/],
  ['settings', /exif:(ExposureTime|FNumber|ISOSpeed|FocalLength|Flash|WhiteBalance)|crs:/],
  ['dates', /xmp:(CreateDate|ModifyDate|MetadataDate)|photoshop:DateCreated|exif:DateTime/],
  ['software', /xmp:CreatorTool|photoshop:History|xmpMM:(History|DocumentID|InstanceID|OriginalDocumentID)|softwareAgent/],
  ['author', /dc:(creator|rights)|xmpRights:|photoshop:(AuthorsPosition|Credit)|CreatorContactInfo/],
  ['text', /dc:(description|title|subject)|photoshop:(Headline|Instructions)|exif:UserComment/],
];

// Flags categories found in an XMP (RDF/XML) packet.
export function analyzeXmp(report, text) {
  add(report, 'xmp', 'XMP packet', `${text.length} characters`);
  for (const [cat, re] of XMP_RULES) {
    const m = text.match(re);
    if (m) add(report, cat, 'XMP field', m[0]);
  }
  const tool = text.match(/CreatorTool[^>]*?>([^<]{1,100})<|CreatorTool="([^"]{1,100})"/);
  if (tool) add(report, 'software', 'Creator tool', tool[1] || tool[2]);
  const ai = text.match(AI_RE);
  if (ai) add(report, 'ai', 'AI / provenance marker', ai[0]);
}

const IPTC_MAP = {
  5: ['text', 'Title'], 25: ['text', 'Keywords'], 105: ['text', 'Headline'], 120: ['text', 'Caption'],
  80: ['author', 'By-line'], 110: ['author', 'Credit'], 115: ['author', 'Source'], 116: ['author', 'Copyright'],
  55: ['dates', 'Date created'], 60: ['dates', 'Time created'], 62: ['dates', 'Digital creation date'],
  90: ['gps', 'City'], 92: ['gps', 'Sub-location'], 95: ['gps', 'State/Province'], 101: ['gps', 'Country'],
  65: ['software', 'Originating program'], 70: ['software', 'Program version'],
};

// Parses Photoshop "8BIM" image resources (JPEG APP13), flagging IPTC datasets.
export function analyzePhotoshop(report, b) {
  let p = 0, sawIptc = false;
  while (p + 12 <= b.length && ascii(b, p, 4) === '8BIM') {
    const id = (b[p + 4] << 8) | b[p + 5];
    const nameLen = b[p + 6];
    let q = p + 6 + 1 + nameLen;
    if ((1 + nameLen) % 2) q++;
    if (q + 4 > b.length) break;
    const size = u32(b, q);
    const data = b.subarray(q + 4, Math.min(b.length, q + 4 + size));
    if (id === 0x0404) { sawIptc = true; analyzeIptc(report, data); }
    else if (id === 0x0409 || id === 0x040c) add(report, 'thumbnail', 'Photoshop thumbnail', `${size} bytes`);
    else add(report, 'other', `Photoshop resource 0x${id.toString(16)}`, `${size} bytes`);
    p = q + 4 + size + (size % 2);
  }
  if (!sawIptc) add(report, 'other', 'Photoshop data block');
}

function analyzeIptc(report, b) {
  add(report, 'iptc', 'IPTC block', `${b.length} bytes`);
  for (let p = 0; p + 5 <= b.length && b[p] === 0x1c;) {
    const rec = b[p + 1], ds = b[p + 2], len = (b[p + 3] << 8) | b[p + 4];
    const val = latin1(b.subarray(p + 5, p + 5 + len));
    const m = rec === 2 && IPTC_MAP[ds];
    if (m) add(report, m[0], `IPTC ${m[1]}`, val);
    if (hasAiHint(val)) add(report, 'ai', 'IPTC AI marker', val);
    p += 5 + len;
  }
}

// ---- byte helpers ----
export const u16 = (b, p) => (b[p] << 8) | b[p + 1];
export const u32 = (b, p) => ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
export const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
export const latin1 = (b) => new TextDecoder('latin1').decode(b);
export const utf8 = (b) => new TextDecoder('utf-8').decode(b);

export function startsWith(b, p, str) {
  if (p + str.length > b.length) return false;
  for (let i = 0; i < str.length; i++) if (b[p + i] !== str.charCodeAt(i)) return false;
  return true;
}

export function indexOfAscii(b, str, from = 0) {
  const first = str.charCodeAt(0);
  outer: for (let i = b.indexOf(first, from); i !== -1 && i <= b.length - str.length; i = b.indexOf(first, i + 1)) {
    for (let j = 1; j < str.length; j++) if (b[i + j] !== str.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

// Decompresses zlib data, capped so a malicious "zip bomb" text chunk can't exhaust memory.
export async function inflate(bytes, cap = 4 << 20) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    if (total > cap) { reader.cancel(); break; }
  }
  return concat(parts);
}

export class UserError extends Error {}
