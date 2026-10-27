// Intake and validation of concept packages (standalone HTML or ZIP).
// Pure logic — no DOM — so it can be unit-tested in Node.

const JUNK_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._[^/]*$)/i;
const SKIP_SCHEMES = /^(data|blob|about|mailto|tel|javascript|sms|ws|wss):/i;

function stripQuery(url) {
  return url.replace(/[?#].*$/, '');
}

// Extract candidate resource references from HTML text.
export function extractRefs(html) {
  const refs = [];
  const seen = new Set();
  const push = (raw, kind) => {
    const url = String(raw || '').trim();
    if (!url || url.includes('{{') || url.includes('${') || url.startsWith('#')) return;
    const key = `${kind}:${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ url, kind });
  };
  // Strip HTML comments to reduce noise.
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  const attrRe = /\b(src|href|poster|data-src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = attrRe.exec(text))) {
    const attr = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (attr === 'srcset') {
      for (const part of value.split(',')) push(part.trim().split(/\s+/)[0], 'srcset');
    } else {
      push(value, attr === 'href' ? 'href' : 'src');
    }
  }
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;
  while ((m = urlRe.exec(text))) push(m[1] ?? m[2] ?? m[3], 'css-url');
  const importRe = /\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']/g;
  while ((m = importRe.exec(text))) push(m[1], 'import');
  const dynImportRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynImportRe.exec(text))) push(m[1], 'import');
  return refs;
}

export function classifyRef(url) {
  const u = url.trim();
  if (SKIP_SCHEMES.test(u)) return 'skip';
  if (/^https:\/\//i.test(u) || /^\/\//.test(u)) return 'external';
  if (/^http:\/\//i.test(u)) return 'insecure';
  if (/^file:/i.test(u)) return 'localFile';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return 'skip'; // other schemes
  if (u.startsWith('/')) return 'absolute'; // site-absolute path: will not resolve inside concepts/<slug>/
  return 'relative';
}

// Inspect a standalone HTML document.
export function inspectHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const looksHtml = /<\s*(!doctype\s+html|html|head|body|script|canvas|div|main)\b/i.test(html);
  const hasBase = /<base\b[^>]*href/i.test(html);
  const refs = extractRefs(html);
  const buckets = { external: [], insecure: [], localFile: [], relative: [], absolute: [] };
  for (const r of refs) {
    const cls = classifyRef(r.url);
    if (cls === 'skip') continue;
    const clean = cls === 'relative' || cls === 'absolute' ? stripQuery(r.url) : r.url;
    if (!clean) continue;
    if (!buckets[cls].includes(clean)) buckets[cls].push(clean);
  }
  return { title, looksHtml, hasBase, ...buckets };
}

// Resolve a relative reference against the directory of `fromPath` inside a package.
export function resolveRelative(fromPath, ref) {
  const baseParts = fromPath.split('/').slice(0, -1);
  const parts = [...baseParts];
  for (const seg of ref.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function decodeRef(ref) {
  try { return decodeURIComponent(ref); } catch { return ref; }
}

// Cross-check relative references in the entry HTML (and CSS files) against package contents.
export function checkPackageRefs(files, entry, decoder = new TextDecoder('utf-8')) {
  const paths = new Set(files.map((f) => f.path));
  const lowerMap = new Map(files.map((f) => [f.path.toLowerCase(), f.path]));
  const missing = [];
  const caseMismatch = [];
  const scan = (fromPath, text, isCss) => {
    const refs = isCss
      ? extractRefs(text).filter((r) => r.kind === 'css-url')
      : extractRefs(text);
    for (const r of refs) {
      if (classifyRef(r.url) !== 'relative') continue;
      if (r.url.endsWith('/')) continue; // directory reference, not a file
      const target = resolveRelative(fromPath, decodeRef(stripQuery(r.url)));
      if (!target || paths.has(target)) continue;
      const actual = lowerMap.get(target.toLowerCase());
      if (actual) caseMismatch.push(`${target} → ${actual}`);
      else missing.push(target);
    }
  };
  const entryFile = files.find((f) => f.path === entry);
  if (entryFile) scan(entry, decoder.decode(entryFile.bytes), false);
  for (const f of files) {
    if (/\.css$/i.test(f.path) && f.bytes.length < 2 * 1024 * 1024) scan(f.path, decoder.decode(f.bytes), true);
  }
  return { missing: [...new Set(missing)], caseMismatch: [...new Set(caseMismatch)] };
}

// Validate and normalise a ZIP entry path. Returns { path, hadBackslash } or { error, path }.
export function normalizeZipPath(name) {
  let p = String(name);
  let hadBackslash = false;
  if (p.includes('\\')) { hadBackslash = true; p = p.replace(/\\/g, '/'); }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return { error: 'unsafe', path: name };
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return { error: 'unsafe', path: name };
  const segs = p.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '' || s.toLowerCase() === '.git')) return { error: 'unsafe', path: name };
  return { path: p, hadBackslash };
}

function isSymlink(zipObj) {
  const perm = zipObj.unixPermissions;
  if (typeof perm !== 'number') return false;
  return (perm & 0o170000) === 0o120000;
}

// Read a zip entry with a hard byte limit (aborts the stream if exceeded).
export function readEntryLimited(zipObj, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    let stream;
    try {
      stream = zipObj.internalStream('uint8array');
    } catch {
      zipObj.async('uint8array').then((bytes) => (bytes.length > maxBytes ? reject(new Error('LIMIT')) : resolve(bytes)), reject);
      return;
    }
    stream.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        try { stream.pause(); } catch { /* ignore */ }
        reject(new Error('LIMIT'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
    stream.on('end', () => {
      if (done) return;
      done = true;
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      resolve(out);
    });
    stream.resume();
  });
}

export class PackageError extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.name = 'PackageError';
    this.code = code;
    this.vars = vars;
  }
}

// Inspect a ZIP (ArrayBuffer/Uint8Array). `JSZipImpl` is the JSZip constructor.
export async function inspectZip(buffer, limits, JSZipImpl) {
  let zip;
  try {
    zip = await JSZipImpl.loadAsync(buffer);
  } catch (e) {
    throw new PackageError('pkg.badZip', { msg: e && e.message ? e.message : String(e) });
  }
  const warnings = [];
  const entries = [];
  let skipped = 0;
  let hadBackslash = false;
  for (const name of Object.keys(zip.files)) {
    const obj = zip.files[name];
    if (obj.dir) continue;
    if (JUNK_RE.test(name.replace(/\\/g, '/'))) { skipped++; continue; }
    const norm = normalizeZipPath(name);
    if (norm.error) throw new PackageError('pkg.unsafePath', { path: name });
    if (isSymlink(obj)) throw new PackageError('pkg.symlink', { path: name });
    hadBackslash = hadBackslash || norm.hadBackslash;
    const declared = obj._data && typeof obj._data.uncompressedSize === 'number' ? obj._data.uncompressedSize : null;
    entries.push({ path: norm.path, obj, declared });
  }
  if (entries.length > limits.maxFiles) throw new PackageError('pkg.tooMany', { n: entries.length, limit: limits.maxFiles });

  // Unwrap a single common top-level folder (concept/index.html -> index.html).
  let strippedRoot = null;
  const roots = new Set(entries.map((e) => e.path.split('/')[0]));
  if (entries.length && roots.size === 1 && entries.every((e) => e.path.includes('/'))) {
    strippedRoot = [...roots][0];
    for (const e of entries) e.path = e.path.slice(strippedRoot.length + 1);
  }
  // Duplicate paths after normalisation would be ambiguous.
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.path)) throw new PackageError('pkg.unsafePath', { path: e.path });
    seen.add(e.path);
  }
  // Pre-check declared sizes.
  const declaredTotal = entries.reduce((s, e) => s + (e.declared || 0), 0);
  if (declaredTotal > limits.maxUnzippedBytes) throw new PackageError('pkg.unzippedTooBig', { limit: limits.maxUnzippedBytes });

  const files = [];
  let total = 0;
  for (const e of entries) {
    let bytes;
    try {
      bytes = await readEntryLimited(e.obj, limits.maxFileBytes);
    } catch (err) {
      if (err && err.message === 'LIMIT') throw new PackageError('pkg.tooBig', { size: e.path, limit: limits.maxFileBytes });
      throw new PackageError('pkg.badZip', { msg: err && err.message ? err.message : String(err) });
    }
    total += bytes.length;
    if (total > limits.maxUnzippedBytes) throw new PackageError('pkg.unzippedTooBig', { limit: limits.maxUnzippedBytes });
    files.push({ path: e.path, bytes });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const depth = (p) => p.split('/').length;
  const htmlFiles = files
    .filter((f) => /\.html?$/i.test(f.path))
    .map((f) => f.path)
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const entry = htmlFiles.includes('index.html') ? 'index.html' : htmlFiles[0] || null;

  if (strippedRoot) warnings.push({ key: 'pkg.stripped', level: 'info', vars: { root: strippedRoot } });
  if (skipped) warnings.push({ key: 'pkg.skipped', level: 'info', vars: { n: skipped } });
  if (hadBackslash) warnings.push({ key: 'pkg.backslash', level: 'info' });
  if (!entry) warnings.push({ key: 'pkg.noHtml', level: 'error' });

  return { kind: 'zip', files, entry, htmlFiles, totalBytes: total, strippedRoot, skipped, warnings };
}

// Inspect a standalone HTML file (Uint8Array). Always stored as index.html.
export function inspectHtmlBytes(bytes, limits) {
  if (bytes.length > limits.maxPackageBytes) throw new PackageError('pkg.tooBig', { size: bytes.length, limit: limits.maxPackageBytes });
  const text = new TextDecoder('utf-8').decode(bytes);
  const info = inspectHtml(text);
  const warnings = [];
  if (!info.looksHtml) warnings.push({ key: 'pkg.notHtml', level: 'warn' });
  return {
    kind: 'html',
    files: [{ path: 'index.html', bytes }],
    entry: 'index.html',
    htmlFiles: ['index.html'],
    totalBytes: bytes.length,
    title: info.title,
    info,
    warnings,
  };
}

// Build the warnings list for a package + chosen entry (after entry selection).
export function analyzePackage(pkg, entry) {
  const warnings = [...(pkg.warnings || [])];
  const entryFile = pkg.files.find((f) => f.path === entry);
  if (!entryFile) return { warnings, title: pkg.title || '', info: null };
  const info = pkg.info && pkg.kind === 'html' ? pkg.info : inspectHtml(new TextDecoder('utf-8').decode(entryFile.bytes));
  if (info.external.length) warnings.push({ key: 'pkg.external', level: 'info', vars: { n: info.external.length } });
  if (info.insecure.length) warnings.push({ key: 'pkg.insecure', level: 'warn', vars: { list: info.insecure.slice(0, 5).join(', ') } });
  if (info.localFile.length) warnings.push({ key: 'pkg.localFile', level: 'warn', vars: { list: info.localFile.slice(0, 5).join(', ') } });
  const refs = checkPackageRefs(pkg.files, entry);
  const missing = [...refs.missing, ...info.absolute];
  if (missing.length) warnings.push({ key: 'pkg.relativeMissing', level: 'warn', vars: { list: missing.slice(0, 8).join(', ') + (missing.length > 8 ? ` (+${missing.length - 8})` : '') } });
  if (refs.caseMismatch.length) warnings.push({ key: 'pkg.caseMismatch', level: 'warn', vars: { list: refs.caseMismatch.slice(0, 5).join(', ') } });
  return { warnings, title: info.title, info };
}
