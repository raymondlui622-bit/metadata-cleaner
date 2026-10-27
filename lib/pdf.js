// PDF: removes document metadata (Info dictionary, XMP, per-object metadata, document ID, old revisions)
// and, only when selected, annotations / attachments / scripts. Page content is never modified.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFStream, PDFRef, PDFString, PDFHexString, decodePDFRawStream, EncryptedPDFError } from '../vendor/pdf-lib.esm.min.js';
import { add, analyzeXmp, hasAiHint, latin1, utf8, indexOfAscii, newReport, UserError } from './common.js';

const N = (s) => PDFName.of(s);
const INFO_CAT = { Author: 'author', Title: 'text', Subject: 'text', Keywords: 'text', Creator: 'software', Producer: 'software', CreationDate: 'dates', ModDate: 'dates' };
const KEEP_ANNOTS = new Set(['/Link', '/Widget']); // links and form fields are document content

async function load(b) {
  try {
    const doc = await PDFDocument.load(b, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
    doc.getPages(); // throws here if the page tree is missing or broken
    return doc;
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(e.message)) throw new UserError('This PDF is password-protected or encrypted. Remove the protection first, then try again.');
    throw new UserError('This PDF could not be read. It may be damaged or use features this app does not support.');
  }
}

const text = (v) => v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v);
const dictOf = (o) => o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null;

// Visits every dictionary reachable from `roots`. Returns the set of reachable indirect refs.
function walk(ctx, roots, visit) {
  const seen = new Set(), stack = [...roots];
  while (stack.length) {
    let o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      o = ctx.lookup(o);
    }
    const d = dictOf(o);
    if (d) { visit?.(d); stack.push(...d.values()); }
    else if (o instanceof PDFArray) stack.push(...o.asArray());
  }
  return seen;
}

function streamText(s) {
  try { return utf8(decodePDFRawStream(s).decode()); } catch { return ''; }
}

const isJs = (o, ctx) => { const d = dictOf(ctx.lookup(o)); return d && (d.get(N('S'))?.toString() === '/JavaScript' || d.has(N('JS'))); };

function revisions(b) {
  let n = 0;
  for (let p = indexOfAscii(b, '%%EOF'); p !== -1; p = indexOfAscii(b, '%%EOF', p + 5)) n++;
  if (latin1(b.subarray(0, 1024)).includes('/Linearized')) n--;
  return n;
}

export async function inspect(b) {
  const r = newReport('pdf', 'PDF document');
  const doc = await load(b);
  const ctx = doc.context, catalog = doc.catalog;
  r.pages = doc.getPageCount();
  r.pageSizes = doc.getPages().map((p) => { const m = p.getMediaBox(); return `${m.width.toFixed(1)}×${m.height.toFixed(1)}`; });

  const info = ctx.lookup(ctx.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [k, v] of info.entries()) {
      const key = k.decodeText(), val = text(ctx.lookup(v) ?? v);
      if (key === 'Trapped') continue;
      add(r, 'docinfo', key, val);
      if (INFO_CAT[key]) add(r, INFO_CAT[key], key, val);
      if (hasAiHint(val)) add(r, 'ai', key, val);
    }
  }
  if (ctx.trailerInfo.ID) add(r, 'docid', 'Document ID', text(ctx.trailerInfo.ID));
  const revs = revisions(b);
  if (revs > 1) add(r, 'revisions', 'File sections (incremental saves)', revs);

  walk(ctx, [ctx.trailerInfo.Root], (d) => {
    const meta = d.get(N('Metadata'));
    if (meta) {
      const s = ctx.lookup(meta);
      const x = s instanceof PDFStream ? streamText(s) : '';
      if (d === catalog) { if (x) analyzeXmp(r, x); else add(r, 'xmp', 'XMP metadata stream'); }
      else { add(r, 'objmeta', 'Embedded metadata stream'); if (x && hasAiHint(x)) add(r, 'ai', 'AI marker in embedded metadata'); }
    }
    if (d.has(N('PieceInfo'))) add(r, 'software', 'Private application data (PieceInfo)');
    if (d.has(N('LastModified'))) add(r, 'dates', 'Last modified', text(d.get(N('LastModified'))));
    const type = d.get(N('Type'))?.toString(), sub = d.get(N('Subtype'))?.toString();
    if (sub === '/FileAttachment' || (type === '/Filespec' && d.has(N('EF')))) add(r, 'attachments', 'Attached file', d.has(N('F')) ? text(d.get(N('F'))) : '');
    else if ((type === '/Annot' || d.has(N('Rect')) && sub) && sub && !KEEP_ANNOTS.has(sub) && sub !== '/Popup') {
      add(r, 'annotations', sub.slice(1), d.has(N('Contents')) ? text(d.get(N('Contents'))) : '');
    }
    if (d.get(N('S'))?.toString() === '/JavaScript' || d.has(N('JS'))) add(r, 'scripts', 'JavaScript action');
  });
  const names = dictOf(ctx.lookup(catalog.get(N('Names'))));
  if (names?.has(N('EmbeddedFiles'))) add(r, 'attachments', 'Attached files list');
  if (names?.has(N('JavaScript'))) add(r, 'scripts', 'Document JavaScript');
  if (r.pages === 0) throw new UserError('This PDF has no pages.');
  return r;
}

// opts: { annotations, attachments, scripts } — each removes that kind of content only when true.
export async function clean(b, opts = {}) {
  const doc = await load(b);
  const ctx = doc.context, catalog = doc.catalog;
  ctx.trailerInfo.Info = undefined;
  ctx.trailerInfo.ID = undefined;

  if (opts.annotations || opts.attachments) {
    for (const page of doc.getPages()) {
      const annots = ctx.lookup(page.node.get(N('Annots')));
      if (!(annots instanceof PDFArray)) continue;
      const keep = annots.asArray().filter((a) => {
        const sub = dictOf(ctx.lookup(a))?.get(N('Subtype'))?.toString();
        if (sub === '/FileAttachment') return !opts.attachments;
        return KEEP_ANNOTS.has(sub) || !opts.annotations;
      });
      page.node.set(N('Annots'), ctx.obj(keep));
    }
  }
  const names = dictOf(ctx.lookup(catalog.get(N('Names'))));
  if (opts.attachments) { names?.delete(N('EmbeddedFiles')); catalog.delete(N('AF')); }
  if (opts.scripts) names?.delete(N('JavaScript'));

  walk(ctx, [ctx.trailerInfo.Root], (d) => {
    for (const k of ['Metadata', 'PieceInfo', 'LastModified']) d.delete(N(k));
    if (opts.scripts) {
      d.delete(N('AA'));
      for (const k of ['A', 'OpenAction']) if (d.has(N(k)) && isJs(d.get(N(k)), ctx)) d.delete(N(k));
    }
  });

  // Drop every object no longer reachable: old revisions, removed metadata, orphaned data.
  const live = walk(ctx, [ctx.trailerInfo.Root, ctx.trailerInfo.Encrypt].filter(Boolean));
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!live.has(ref.tag)) ctx.delete(ref);

  const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false });
  const notes = ['The PDF was rewritten as a fresh file. Page content was not changed.'];
  const skipped = ['annotations', 'attachments', 'scripts'].filter((k) => !opts[k]);
  if (skipped.length) notes.push(`Not selected for removal: ${skipped.join(', ')}.`);
  return { bytes, notes };
}
