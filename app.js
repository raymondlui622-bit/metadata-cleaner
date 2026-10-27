// UI. All processing runs locally via lib/engine.js. Metadata values are untrusted, so they are
// only ever inserted as text (never as HTML).
import { inspectBytes, cleanBatch, cleanName, sniff, MAX_BYTES } from './lib/engine.js';
import { CATEGORIES, UserError } from './lib/common.js';
import { makeZip } from './lib/zip.js';

const $ = (id) => document.getElementById(id);
const MIME = { jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', pdf: 'application/pdf' };
let items = []; // { id, file, type, report, error, result, outName, blob, card }
const urls = new Set();
let nextId = 1;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const objectUrl = (blob) => { const u = URL.createObjectURL(blob); urls.add(u); return u; };
const size = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const status = (text) => { $('status').textContent = text; };

// ---------- selecting ----------
async function addFiles(fileList) {
  const fresh = [...fileList].map((file) => ({ id: nextId++, file }));
  if (!fresh.length) return;
  items.push(...fresh);
  for (const it of fresh) { it.card = h('article', { class: 'card' }); $('list').append(it.card); render(it); }
  refresh();
  for (const [i, it] of fresh.entries()) {
    status(`Checking ${i + 1} of ${fresh.length}…`);
    try {
      if (it.file.size > MAX_BYTES) throw new UserError('This file is too large to process on this device (limit 300 MB).');
      const bytes = new Uint8Array(await it.file.arrayBuffer());
      it.type = sniff(bytes);
      it.report = await inspectBytes(bytes, it.file.name);
    } catch (e) {
      it.error = e instanceof UserError ? e.message : 'This file appears to be damaged or uses an unsupported structure.';
    }
    render(it);
    refresh();
  }
  status(`${items.length} file${items.length > 1 ? 's' : ''} ready. Tap “Remove Metadata”.`);
}

// ---------- cleaning ----------
async function cleanAll() {
  const todo = items.filter((it) => !it.error);
  if (!todo.length) return;
  $('clean').disabled = true;
  const opts = {
    annotations: $('opt-annotations').checked, attachments: $('opt-attachments').checked, scripts: $('opt-scripts').checked,
  };
  const generic = $('opt-generic').checked;
  const files = todo.map((it) => ({ name: it.file.name, size: it.file.size, read: async () => new Uint8Array(await it.file.arrayBuffer()) }));
  let n = 0;
  await cleanBatch(files, opts, (i, res) => {
    const it = todo[i];
    status(`Cleaned ${++n} of ${todo.length}…`);
    if (!res.ok) { it.error = res.error; it.result = null; it.blob = null; }
    else {
      it.blob = new Blob([res.bytes], { type: MIME[res.type] });
      it.outName = cleanName(it.file.name, res.type, generic ? items.indexOf(it) + 1 : undefined);
      delete res.bytes; // keep only the Blob — the browser can hold it outside JS memory
      it.result = res;
    }
    render(it);
    return new Promise((r) => setTimeout(r)); // let the UI update between files
  });
  const done = items.filter((it) => it.result);
  const bad = done.filter((it) => it.result.status !== 'clean').length;
  status(bad ? `Done. ${bad} file${bad > 1 ? 's need' : ' needs'} attention — see below.` : `Done. ${done.length} cleaned file${done.length > 1 ? 's' : ''} ready to save.`);
  $('clean').disabled = false;
  refresh();
}

// ---------- saving ----------
const asFile = (it) => new File([it.blob], it.outName, { type: it.blob.type });

async function share(list) {
  const files = list.map(asFile);
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  if (list.length > 1) return downloadZip(); // browsers block many downloads at once
  download(list[0].blob, list[0].outName);
}

function download(blob, name) {
  const a = h('a', { href: objectUrl(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

async function downloadZip() {
  const done = items.filter((it) => it.blob);
  status('Preparing ZIP…');
  const entries = [];
  const used = new Set();
  for (const it of done) {
    let name = it.outName;
    for (let k = 2; used.has(name); k++) name = it.outName.replace(/(\.[^.]+)$/, `_${k}$1`);
    used.add(name);
    entries.push({ name, bytes: new Uint8Array(await it.blob.arrayBuffer()) });
  }
  download(makeZip(entries), 'cleaned_files.zip');
  status('ZIP ready.');
}

function clearAll() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls.clear();
  items = [];
  $('list').replaceChildren();
  $('file').value = '';
  status('Cleared. Nothing was kept.');
  refresh();
}

// ---------- rendering ----------
function render(it) {
  const { file, report, error, result } = it;
  const isImage = /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif)$/i.test(file.name);
  let thumb;
  if (isImage && !error) {
    thumb = h('img', { class: 'thumb', alt: '', src: it.thumbUrl ||= objectUrl(file) });
    thumb.onerror = () => thumb.replaceWith(h('div', { class: 'thumb' }, (it.type || 'IMG').toUpperCase().slice(0, 4)));
  } else thumb = h('div', { class: 'thumb' }, (file.name.split('.').pop() || '?').toUpperCase().slice(0, 4));

  const metaLine = [report?.label || file.type || 'Unknown type', size(file.size)];
  if (report?.width) metaLine.push(`${report.width}×${report.height}`);
  if (report?.pages) metaLine.push(`${report.pages} page${report.pages > 1 ? 's' : ''}`);

  const badge = error ? h('span', { class: 'badge bad' }, 'Not supported')
    : !report ? h('span', { class: 'badge' }, 'Checking…')
    : !result ? h('span', { class: report.found.size ? 'badge warn' : 'badge ok' }, report.found.size ? `${foundCats(report).length} found` : 'Nothing found')
    : result.status === 'clean' ? h('span', { class: 'badge ok' }, 'Verified clean')
    : result.status === 'remains' ? h('span', { class: 'badge bad' }, 'Some remains')
    : h('span', { class: 'badge warn' }, 'Not verified');

  const body = [];
  if (error) body.push(h('p', { class: 'msg bad' }, error, ' The original file was not changed.'));
  else if (report && !result) body.push(beforeView(report));
  else if (result) body.push(...afterView(it));

  it.card.replaceChildren(
    h('div', { class: 'card-head' }, thumb, h('div', { class: 'grow' }, h('div', { class: 'name' }, file.name), h('div', { class: 'meta' }, metaLine.join(' · '))), badge),
    ...body,
  );
}

const foundCats = (report) => Object.keys(CATEGORIES).filter((c) => report.found.has(c));

function beforeView(report) {
  const cats = foundCats(report);
  if (!cats.length) return h('p', { class: 'msg ok' }, 'No hidden metadata found. You can still make a clean copy.');
  return h('div', {},
    h('table', { class: 'report' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Hidden information'), h('th', {}, 'Status'))),
      h('tbody', {}, cats.map((c) => h('tr', {}, h('td', {}, CATEGORIES[c]), h('td', { class: 'found' }, 'Found'))))),
    keptNote(report.kept),
    techDetails([['Found in original', report.details]]));
}

function afterView(it) {
  const r = it.result;
  const cls = { Removed: 'removed', 'Potential metadata remains': 'remains', 'Not verified': 'remains', 'Kept (not selected)': 'kept-sel' };
  const out = [];
  if (r.rows.length) {
    out.push(h('table', { class: 'report' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Hidden information'), h('th', {}, 'Before'), h('th', {}, 'After'))),
      h('tbody', {}, r.rows.map((row) => h('tr', {}, h('td', {}, row.label), h('td', { class: row.before === 'Found' ? 'found' : '' }, row.before), h('td', { class: cls[row.after] || '' }, row.after))))));
  }
  const keptSel = r.rows.some((row) => row.after === 'Kept (not selected)');
  if (r.status === 'clean') out.push(h('p', { class: 'msg ok' }, !r.rows.length ? 'Checked the new file: no hidden metadata.'
    : keptSel ? 'Checked the new file: all metadata is gone. Items marked “Kept (not selected)” are still in the document — tick them above and clean again to remove them.'
    : 'Checked the new file: everything listed above is gone.'));
  if (r.status === 'remains') out.push(h('p', { class: 'msg bad' }, 'Potential metadata remains in the new file. Check the technical details before sharing.'));
  for (const w of r.warnings) out.push(h('p', { class: 'msg warn' }, 'Not verified: ', w));
  out.push(keptNote(r.kept));
  for (const n of r.notes) out.push(h('p', { class: 'fine' }, n));
  out.push(techDetails([['Found in original', r.before.details], ['Still in new file', r.after?.details || []]]));
  out.push(h('div', { class: 'card-actions' },
    h('button', { class: 'btn primary small', onclick: () => share([it]) }, 'Save / Share'),
    h('button', { class: 'btn small', onclick: () => download(it.blob, it.outName) }, 'Download')));
  out.push(h('p', { class: 'fine' }, `New file: ${it.outName} (${size(it.blob.size)}). Your original was not changed.`));
  return out.filter(Boolean);
}

const keptNote = (kept) => kept?.length ? h('p', { class: 'fine' }, `Kept on purpose: ${kept.join(', ')}. These contain no personal information.`) : null;

function techDetails(sections) {
  return h('details', { class: 'tech' }, h('summary', {}, 'Technical details'),
    sections.map(([title, rows]) => [h('h4', {}, title),
      rows.length ? h('dl', {}, rows.map(([cat, k, v]) => [h('dt', {}, `${CATEGORIES[cat] ? CATEGORIES[cat].split(' ')[0] : cat} · ${k}`), h('dd', {}, v || '—')])) : h('p', { class: 'fine' }, 'None')]));
}

function refresh() {
  const any = items.length > 0, cleaned = items.some((it) => it.blob);
  $('actions').hidden = $('clear').hidden = !any;
  $('options').hidden = !any;
  $('pdf-options').hidden = !items.some((it) => it.type === 'pdf' || /\.pdf$/i.test(it.file.name));
  $('clean').disabled = !items.some((it) => it.report && !it.error);
  $('save-all').disabled = $('zip').disabled = !cleaned;
}

// ---------- wiring ----------
$('file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('clean').addEventListener('click', cleanAll);
$('save-all').addEventListener('click', () => share(items.filter((it) => it.blob)));
$('zip').addEventListener('click', downloadZip);
$('clear').addEventListener('click', clearAll);
for (const id of ['opt-annotations', 'opt-attachments', 'opt-scripts', 'opt-generic']) {
  $(id).addEventListener('change', () => { if (items.some((it) => it.result)) status('Options changed — tap “Remove Metadata” again to apply them.'); });
}
const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js');
}
