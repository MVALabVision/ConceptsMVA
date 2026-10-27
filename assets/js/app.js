// MVA Lab — Concept Studio: UI wiring.
// Public visitors read data/concepts.json from the deployed site.
// Administrators sign in with a GitHub token kept in the browser and publish through the GitHub API.

import { CONFIG } from './config.js';
import { t, setLang, getLang, detectLang, applyI18n } from './i18n.js';
import { slugify, isValidSlug, uniqueSlug } from './slug.js';
import { inspectHtmlBytes, inspectZip, analyzePackage, PackageError } from './package.js';
import {
  GitHubClient, GitHubError, publishConcept, updateConceptMeta, deleteConcept,
  waitForDeploy, loadIndexFromRepo, fetchDeployedBuild,
} from './github.js';
import {
  $, $$, el, clear, toast, copyText, fmtDate, fmtDateTime, fmtBytes, debounce,
  siteBase, conceptUrl, repoUrl, makeThumbnail, hashHue, initials, utf8Decode,
} from './util.js';

const TOKEN_KEY = 'mva.token';
const THEME_KEY = 'mva.theme';

const state = {
  concepts: [],
  source: 'site',
  client: null,
  user: null,
  build: null,
  headSha: null,
  loading: false,
  loadError: null,
  busy: false,
  filters: { q: '', project: '', status: 'all', sort: 'updated' },
  form: null,
  edit: null,
  del: null,
  buildPoll: null,
};

// ---------------------------------------------------------------------------
// Token storage (browser only)
// ---------------------------------------------------------------------------
function loadStoredToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}
function storeToken(token, remember) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Errors → human text
// ---------------------------------------------------------------------------
function formatError(e) {
  if (e instanceof PackageError) {
    const vars = { ...e.vars };
    if (typeof vars.size === 'number') vars.size = fmtBytes(vars.size);
    if (typeof vars.limit === 'number') vars.limit = fmtBytes(vars.limit);
    return t(e.code, vars);
  }
  if (e instanceof GitHubError) {
    if (e.code === 'RATE_LIMIT') return t('err.rateLimit', { time: e.rateLimitReset ? fmtDateTime(new Date(e.rateLimitReset).toISOString(), getLang()) : '…' });
    if (e.code === 'NETWORK') return t('err.network');
    if (e.code === 'SLUG_TAKEN') return t('err.slugTaken', { slug: state.form ? state.form.slug : '' });
    if (e.code === 'NOT_FOUND') return t('err.notFound', { slug: (state.form && state.form.slug) || (state.edit && state.edit.slug) || (state.del && state.del.slug) || '' });
    if (e.code === 'TRUNCATED') return t('err.truncated');
    if (e.code === 'EMPTY_REPO') return t('err.emptyRepo');
    if (e.status === 401) return t('auth.invalid', { status: e.status });
    return t('err.generic', { msg: `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}` });
  }
  return t('err.generic', { msg: e && e.message ? e.message : String(e) });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
}
function toggleTheme() {
  const root = document.documentElement;
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const current = root.dataset.theme || (prefersDark ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------------
function openDialog(dlg) {
  if (!dlg.open) dlg.showModal();
}
function closeDialog(dlg) {
  if (dlg.open) dlg.close();
}
function wireDialogs() {
  for (const dlg of $$('dialog')) {
    for (const btn of $$('[data-close]', dlg)) btn.addEventListener('click', () => closeDialog(dlg));
    dlg.addEventListener('click', (e) => {
      // Click on the backdrop closes (except the progress dialog while busy).
      if (e.target === dlg && !(dlg.id === 'dlg-progress' && state.busy)) closeDialog(dlg);
    });
    dlg.addEventListener('cancel', (e) => {
      if (dlg.id === 'dlg-progress' && state.busy) e.preventDefault();
    });
  }
  $('#dlg-preview').addEventListener('close', () => clear($('#preview-host')));
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadConcepts() {
  state.loading = true;
  state.loadError = null;
  renderList();
  try {
    if (state.client) {
      const head = await state.client.getHead();
      state.headSha = head.sha;
      const index = await loadIndexFromRepo(state.client, head.sha);
      state.concepts = index.concepts;
      state.source = 'repo';
    } else {
      const res = await fetch(`${siteBase()}data/concepts.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.status === 404) {
        state.concepts = [];
      } else {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.concepts = Array.isArray(data.concepts) ? data.concepts : [];
      }
      state.source = 'site';
    }
    state.build = await fetchDeployedBuild(siteBase());
  } catch (e) {
    state.loadError = e;
  } finally {
    state.loading = false;
  }
  renderAll();
  scheduleBuildPoll();
}

function scheduleBuildPoll() {
  clearTimeout(state.buildPoll);
  if (!state.client || !state.headSha) return;
  if (state.build && state.build.commit === state.headSha) return;
  state.buildPoll = setTimeout(async () => {
    state.build = await fetchDeployedBuild(siteBase());
    renderBanner();
    renderList();
    scheduleBuildPoll();
  }, 15000);
}

function isPending(c) {
  if (state.source !== 'repo') return false;
  if (!state.build || !state.build.builtAt) return true;
  return String(c.updatedAt || '') > String(state.build.builtAt);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderAuth();
  renderBanner();
  renderToolbar();
  renderList();
  $('#repo-link').href = repoUrl();
}

function renderAuth() {
  const signedIn = Boolean(state.client);
  $('#btn-signin').hidden = signedIn;
  $('#user-chip').hidden = !signedIn;
  $('#btn-upload').hidden = !signedIn;
  $('#filter-status').hidden = !signedIn;
  if (signedIn && state.user) {
    $('#user-login').textContent = state.user.login || '';
    const avatar = $('#user-avatar');
    if (state.user.avatar_url) {
      avatar.src = `${state.user.avatar_url}${state.user.avatar_url.includes('?') ? '&' : '?'}s=52`;
      avatar.hidden = false;
    } else avatar.hidden = true;
  }
}

function renderBanner() {
  const banner = $('#banner');
  clear(banner);
  if (!state.client) { banner.hidden = true; return; }
  const deploying = state.headSha && (!state.build || state.build.commit !== state.headSha);
  if (!deploying) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.className = 'banner banner-info';
  banner.append(
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, t('banner.deploying')),
    el('a', { href: repoUrl('/actions'), target: '_blank', rel: 'noopener noreferrer', class: 'banner-link' }, t('banner.viewRun'), ' ↗'),
  );
}

function renderToolbar() {
  const projects = [...new Set(state.concepts.map((c) => (c.project || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = $('#filter-project');
  const prev = state.filters.project;
  clear(sel);
  sel.append(el('option', { value: '' }, t('filter.allProjects')));
  for (const p of projects) sel.append(el('option', { value: p }, p));
  sel.value = projects.includes(prev) ? prev : '';
  state.filters.project = sel.value;

  const status = $('#filter-status');
  clear(status);
  for (const v of ['all', 'published', 'archived']) status.append(el('option', { value: v }, t(`filter.status.${v}`)));
  status.value = state.filters.status;

  const sort = $('#sort');
  clear(sort);
  sort.append(el('option', { value: 'updated' }, t('sort.updated')), el('option', { value: 'name' }, t('sort.name')));
  sort.value = state.filters.sort;

  const dl = $('#project-list');
  clear(dl);
  for (const p of projects) dl.append(el('option', { value: p }));
}

function visibleConcepts() {
  const q = state.filters.q.trim().toLowerCase();
  const admin = Boolean(state.client);
  let list = state.concepts.filter((c) => {
    if (!admin && c.status === 'archived') return false;
    if (admin && state.filters.status !== 'all' && (c.status || 'published') !== state.filters.status) return false;
    if (state.filters.project && (c.project || '').trim() !== state.filters.project) return false;
    if (q) {
      const hay = `${c.name || ''} ${c.project || ''} ${c.description || ''} ${c.slug || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (state.filters.sort === 'name') list = list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else list = list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return list;
}

function renderList() {
  const grid = $('#grid');
  const stateBox = $('#list-state');
  clear(grid);
  clear(stateBox);
  stateBox.hidden = true;
  if (state.loading && !state.concepts.length) {
    stateBox.hidden = false;
    stateBox.append(el('span', { class: 'spinner' }), el('p', {}, t('list.loading')));
    $('#count').textContent = '';
    return;
  }
  if (state.loadError && !state.concepts.length) {
    stateBox.hidden = false;
    stateBox.append(el('p', { class: 'form-error' }, `${t('list.loadError')} ${formatError(state.loadError)}`));
    $('#count').textContent = '';
    return;
  }
  const list = visibleConcepts();
  const total = state.concepts.filter((c) => state.client || c.status !== 'archived').length;
  $('#count').textContent = total === 1 ? t('hero.count1') : t('hero.count', { n: total });
  if (!list.length) {
    stateBox.hidden = false;
    const none = !total;
    stateBox.append(
      el('h3', {}, t(none ? 'list.empty.title' : 'list.noMatch.title')),
      el('p', { class: 'muted' }, t(none ? 'list.empty.body' : 'list.noMatch.body')),
    );
    return;
  }
  for (const c of list) grid.append(renderCard(c));
}

function placeholderThumb(c) {
  const hue = hashHue(c.slug || c.name || '');
  const node = el('div', { class: 'thumb-placeholder' }, el('span', { class: 'thumb-initials' }, initials(c.name)));
  node.style.background = `linear-gradient(135deg, hsl(${hue} 55% 38%), hsl(${(hue + 40) % 360} 60% 24%))`;
  return node;
}

function renderCard(c) {
  const url = conceptUrl(c);
  const admin = Boolean(state.client);
  const pending = isPending(c);
  const lang = getLang();

  const thumb = el('div', { class: 'card-thumb' });
  if (c.thumbnail) {
    const img = el('img', { alt: '', loading: 'lazy', src: `${siteBase()}${c.thumbnail}?v=${c.version || 1}` });
    img.addEventListener('error', () => { img.remove(); thumb.prepend(placeholderThumb(c)); });
    thumb.append(img);
  } else {
    thumb.append(placeholderThumb(c));
  }
  const statusKey = pending ? 'pending' : (c.status === 'archived' ? 'archived' : 'published');
  thumb.append(el('span', { class: `badge badge-${statusKey}` }, t(`status.${statusKey}`)));

  const meta = el('div', { class: 'card-meta' },
    el('span', { class: 'chip' }, c.project ? c.project : t('card.noProject')),
    el('span', { class: 'muted' }, t('card.updated', { date: fmtDate(c.updatedAt, lang) })),
    el('span', { class: 'muted mono' }, t('card.version', { n: c.version || 1 })),
  );

  const actions = el('div', { class: 'card-actions' },
    el('a', { class: 'btn btn-primary btn-sm', href: url, target: '_blank', rel: 'noopener noreferrer' },
      svgIcon('eye'), el('span', {}, t('card.view'))),
    el('button', { class: 'btn btn-outline btn-sm', type: 'button', on: { click: () => copyLink(url) } },
      svgIcon('copy'), el('span', {}, t('card.copy'))),
  );

  const card = el('article', { class: `card${c.status === 'archived' ? ' card-archived' : ''}`, dataset: { slug: c.slug } },
    thumb,
    el('div', { class: 'card-body' },
      el('h3', { class: 'card-title' }, c.name || c.slug),
      meta,
      el('p', { class: 'card-desc' }, c.description ? c.description : t('card.noDescription')),
      el('p', { class: 'card-url mono', title: url }, url.replace(/^https?:\/\//, '')),
    ),
    actions,
  );

  if (admin) {
    card.append(el('div', { class: 'card-admin' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => openEditDialog(c) } }, svgIcon('edit'), el('span', {}, t('card.edit'))),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', on: { click: () => openUploadDialog('replace', c) } }, svgIcon('refresh'), el('span', {}, t('card.replace'))),
      el('button', { class: 'btn btn-ghost btn-sm btn-danger-text', type: 'button', on: { click: () => openDeleteDialog(c) } }, svgIcon('trash'), el('span', {}, t('card.delete'))),
    ));
  }
  return card;
}

const ICONS = {
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  copy: 'M9 9h11v11H9z M5 15V5a1 1 0 0 1 1-1h10',
  edit: 'M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16z M13 7l4 4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 11v6 M14 11v6',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  warn: 'M12 4 2.5 20h19L12 4z M12 10v4 M12 17v.5',
  info: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z M12 11v6 M12 7.5v.5',
  err: 'M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19z M9 9l6 6 M15 9l-6 6',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
};
function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

async function copyLink(url) {
  const ok = await copyText(url);
  toast(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'ok' : 'err');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function signIn(token, remember) {
  const client = new GitHubClient({ token, owner: CONFIG.owner, repo: CONFIG.repo, branch: CONFIG.branch });
  const user = await client.whoAmI();
  const repo = await client.getRepo();
  if (!repo || !repo.permissions || !repo.permissions.push) {
    throw new GitHubError(t('auth.noPush', { owner: CONFIG.owner, repo: CONFIG.repo }), { code: 'NO_PUSH', status: 403 });
  }
  if (remember !== null) storeToken(token, remember);
  state.client = client;
  state.user = user;
  await loadConcepts();
}

function signOut() {
  clearToken();
  state.client = null;
  state.user = null;
  state.headSha = null;
  state.source = 'site';
  clearTimeout(state.buildPoll);
  loadConcepts();
}

function openAuthDialog() {
  const dlg = $('#dlg-auth');
  $('#f-token').value = '';
  $('#f-remember').checked = false;
  $('#auth-error').hidden = true;
  $('#auth-step2').textContent = t('auth.step2', { owner: CONFIG.owner, repo: CONFIG.repo });
  const params = new URLSearchParams({
    name: `${CONFIG.repo} Concept Studio`,
    description: `Publish concepts to ${CONFIG.owner}/${CONFIG.repo}`,
    target_name: CONFIG.owner,
    contents: 'write',
    actions: 'read',
  });
  $('#auth-github-link').href = `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
  openDialog(dlg);
  $('#f-token').focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const token = $('#f-token').value.trim();
  const remember = $('#f-remember').checked;
  const err = $('#auth-error');
  err.hidden = true;
  if (!token) { err.textContent = t('form.required'); err.hidden = false; return; }
  const btn = $('#btn-auth-submit');
  btn.disabled = true;
  btn.textContent = t('auth.checking');
  try {
    await signIn(token, remember);
    closeDialog($('#dlg-auth'));
    toast(t('auth.signedInAs', { login: state.user.login }), 'ok');
  } catch (ex) {
    err.textContent = ex instanceof GitHubError && ex.code === 'NO_PUSH' ? ex.message : formatError(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = t('auth.submit');
  }
}

// ---------------------------------------------------------------------------
// Upload / Replace
// ---------------------------------------------------------------------------
function openUploadDialog(mode, concept = null) {
  state.form = {
    mode, concept, pkg: null, entry: null, thumb: null, slugManual: mode === 'replace', slug: concept ? concept.slug : '', slugOk: null, fileName: '',
  };
  const dlg = $('#dlg-upload');
  $('#upload-title').textContent = mode === 'replace' ? t('replace.title', { name: concept.name }) : t('upload.title');
  $('#btn-submit-upload').textContent = mode === 'replace' ? t('form.replace') : t('form.publish');
  $('#f-name').value = concept ? concept.name || '' : '';
  $('#f-project').value = concept ? concept.project || '' : '';
  $('#f-desc').value = concept ? concept.description || '' : '';
  $('#f-status').value = concept ? concept.status || 'published' : 'published';
  $('#f-file').value = '';
  $('#f-file-name').textContent = '';
  $('#f-thumb').value = '';
  const tp = $('#f-thumb-preview');
  tp.hidden = true; tp.removeAttribute('src');
  $('#pkg-panel').hidden = true;
  $('#form-error').hidden = true;
  $('#f-name-dup').hidden = true;
  const slugInput = $('#f-slug');
  slugInput.value = concept ? concept.slug : '';
  slugInput.disabled = mode === 'replace';
  $('#f-slug-hint').textContent = mode === 'replace' ? t('form.slug.locked') : t('form.slug.hint');
  $('#f-slug-status').hidden = true;
  $('#slug-prefix').textContent = `${siteBase().replace(/^https?:\/\//, '')}concepts/`;
  updateUrlPreview();
  openDialog(dlg);
  $('#f-name').focus();
}

function currentEntry() {
  return state.form && state.form.entry ? state.form.entry : 'index.html';
}

function updateUrlPreview() {
  const slug = $('#f-slug').value.trim();
  const entry = currentEntry();
  const path = slug ? `concepts/${slug}/${entry === 'index.html' ? '' : entry}` : 'concepts/…/';
  $('#f-url').textContent = siteBase() + path;
}

function onNameInput() {
  const name = $('#f-name').value;
  const f = state.form;
  if (!f.slugManual) {
    $('#f-slug').value = slugify(name);
    onSlugInput(false);
  }
  const dup = state.concepts.find((c) => c.name && c.name.trim().toLowerCase() === name.trim().toLowerCase() && (!f.concept || c.slug !== f.concept.slug));
  const dupBox = $('#f-name-dup');
  if (dup && f.mode === 'create') { dupBox.textContent = t('form.nameDup', { slug: dup.slug }); dupBox.hidden = false; } else dupBox.hidden = true;
}

const checkSlugRemote = debounce(async (slug) => {
  const f = state.form;
  if (!f || f.mode !== 'create' || !state.client) return;
  try {
    const exists = await state.client.pathExists(`concepts/${slug}`, CONFIG.branch);
    if (!state.form || $('#f-slug').value.trim() !== slug) return;
    setSlugStatus(exists ? 'taken' : 'available', slug);
  } catch { /* leave the local verdict */ }
}, 450);

function setSlugStatus(status, slug) {
  const box = $('#f-slug-status');
  const f = state.form;
  f.slugOk = status === 'available';
  box.hidden = false;
  box.className = `hint ${status === 'available' ? 'ok' : status === 'checking' ? '' : 'warn'}`;
  if (status === 'available') box.textContent = `✓ ${t('form.slug.available')}`;
  else if (status === 'checking') box.textContent = t('form.slug.checking');
  else if (status === 'invalid') box.textContent = `✕ ${t('form.slug.invalid')}`;
  else box.textContent = `✕ ${t('form.slug.taken', { suggest: uniqueSlug(slug, [...state.concepts.map((c) => c.slug), slug]) })}`;
}

function onSlugInput(manual = true) {
  const f = state.form;
  if (manual) f.slugManual = true;
  const slug = $('#f-slug').value.trim().toLowerCase();
  f.slug = slug;
  updateUrlPreview();
  if (f.mode === 'replace') return;
  if (!slug) { $('#f-slug-status').hidden = true; f.slugOk = null; return; }
  if (!isValidSlug(slug)) { setSlugStatus('invalid', slug); return; }
  if (state.concepts.some((c) => c.slug === slug)) { setSlugStatus('taken', slug); return; }
  setSlugStatus('checking', slug);
  f.slugOk = true; // provisional (local check passed); remote check may flip it
  checkSlugRemote(slug);
}

async function handleFile(file) {
  const f = state.form;
  if (!f || !file) return;
  f.pkg = null;
  f.entry = null;
  f.fileName = file.name;
  $('#f-file-name').textContent = `${file.name} · ${fmtBytes(file.size)}`;
  $('#form-error').hidden = true;
  const panel = $('#pkg-panel');
  panel.hidden = true;
  if (file.size > CONFIG.limits.maxPackageBytes) {
    showFormError(t('pkg.tooBig', { size: fmtBytes(file.size), limit: fmtBytes(CONFIG.limits.maxPackageBytes) }));
    return;
  }
  const isZip = /\.zip$/i.test(file.name) || /zip/i.test(file.type || '');
  const isHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
  if (!isZip && !isHtml) { showFormError(t('pkg.badType')); return; }
  panel.hidden = false;
  panel.classList.add('busy');
  clear($('#pkg-warnings'));
  $('#pkg-summary').textContent = t('list.loading');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pkg;
    if (isZip) {
      if (!window.JSZip) throw new PackageError('err.noJsZip');
      pkg = await inspectZip(bytes, CONFIG.limits, window.JSZip);
    } else {
      pkg = inspectHtmlBytes(bytes, CONFIG.limits);
    }
    f.pkg = pkg;
    f.entry = pkg.entry;
    const nameInput = $('#f-name');
    if (!nameInput.value.trim() && pkg.title) { nameInput.value = pkg.title; onNameInput(); }
    renderPackagePanel();
  } catch (e) {
    panel.hidden = true;
    showFormError(formatError(e));
  } finally {
    panel.classList.remove('busy');
  }
}

function renderPackagePanel() {
  const f = state.form;
  const pkg = f.pkg;
  const panel = $('#pkg-panel');
  panel.hidden = false;
  const summary = $('#pkg-summary');
  summary.textContent = pkg.kind === 'zip'
    ? t('pkg.summary.zip', { n: pkg.files.length, size: fmtBytes(pkg.totalBytes) })
    : t('pkg.summary.html', { size: fmtBytes(pkg.totalBytes) });

  const entryRow = $('#pkg-entry-row');
  const entrySel = $('#f-entry');
  clear(entrySel);
  if (pkg.kind === 'zip' && pkg.htmlFiles.length) {
    for (const h of pkg.htmlFiles) entrySel.append(el('option', { value: h }, h));
    entrySel.value = f.entry || pkg.htmlFiles[0];
    entryRow.hidden = false;
  } else {
    entryRow.hidden = true;
  }
  const change = $('#f-entry-change');
  if (f.mode === 'replace' && f.concept && (f.concept.entry || 'index.html') !== (f.entry || 'index.html')) {
    change.textContent = t('form.entryChange', { from: f.concept.entry || 'index.html', to: f.entry || 'index.html' });
    change.hidden = false;
  } else change.hidden = true;

  const analysis = analyzePackage(pkg, f.entry);
  const titleBox = $('#pkg-title');
  if (analysis.title) { titleBox.textContent = t('pkg.title', { title: analysis.title }); titleBox.hidden = false; } else titleBox.hidden = true;

  const ul = $('#pkg-warnings');
  clear(ul);
  for (const w of analysis.warnings) {
    const level = w.level || 'warn';
    ul.append(el('li', { class: `warn-${level}` }, svgIcon(level === 'error' ? 'err' : level === 'info' ? 'info' : 'warn'), el('span', {}, t(w.key, w.vars || {}))));
  }

  const files = $('#pkg-files');
  clear(files);
  for (const file of pkg.files.slice(0, 400)) {
    files.append(el('li', { class: file.path === f.entry ? 'is-entry' : '' }, el('span', {}, file.path), el('span', { class: 'muted' }, fmtBytes(file.bytes.length))));
  }
  if (pkg.files.length > 400) files.append(el('li', { class: 'muted' }, `… +${pkg.files.length - 400}`));
  $('#pkg-files-wrap').open = pkg.kind === 'zip' && pkg.files.length <= 12;
  $('#btn-preview').hidden = !f.entry;
  updateUrlPreview();
}

function showFormError(msg) {
  const box = $('#form-error');
  box.textContent = msg;
  box.hidden = false;
}

async function onThumbChange(input, previewImg, target) {
  const file = input.files && input.files[0];
  target.thumb = null;
  previewImg.hidden = true;
  if (!file) return;
  if (file.size > CONFIG.limits.maxThumbBytes) { toast(t('pkg.tooBig', { size: fmtBytes(file.size), limit: fmtBytes(CONFIG.limits.maxThumbBytes) }), 'err'); input.value = ''; return; }
  try {
    const bytes = await makeThumbnail(file);
    target.thumb = bytes;
    previewImg.src = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    previewImg.hidden = false;
  } catch (e) {
    toast(formatError(e), 'err');
    input.value = '';
  }
}

function openPreview() {
  const f = state.form;
  if (!f || !f.pkg || !f.entry) return;
  const entryFile = f.pkg.files.find((x) => x.path === f.entry);
  if (!entryFile) return;
  const html = utf8Decode(entryFile.bytes);
  const host = $('#preview-host');
  clear(host);
  const frame = el('iframe', {
    class: 'preview-frame',
    sandbox: 'allow-scripts allow-pointer-lock',
    allow: 'fullscreen',
    title: 'Concept preview',
    src: `preview.html?x=${Date.now()}`,
  });
  const onMessage = (ev) => {
    if (ev.source !== frame.contentWindow || !ev.data || !ev.data.ready) return;
    frame.contentWindow.postMessage({ html }, '*');
    window.removeEventListener('message', onMessage);
  };
  window.addEventListener('message', onMessage);
  host.append(frame);
  openDialog($('#dlg-preview'));
}

async function submitUpload(e) {
  e.preventDefault();
  const f = state.form;
  if (!f) return;
  $('#form-error').hidden = true;
  const name = $('#f-name').value.trim();
  const slug = $('#f-slug').value.trim().toLowerCase();
  if (!name) { showFormError(t('form.required')); $('#f-name').focus(); return; }
  if (!f.pkg) { showFormError(t('form.fileRequired')); return; }
  if (!f.entry) { showFormError(t('pkg.noHtml')); return; }
  if (!isValidSlug(slug)) { showFormError(t('form.slug.invalid')); $('#f-slug').focus(); return; }
  if (f.mode === 'create' && state.concepts.some((c) => c.slug === slug)) { showFormError(t('err.slugTaken', { slug })); return; }
  f.slug = slug;
  const meta = { slug, name, project: $('#f-project').value, description: $('#f-desc').value, status: $('#f-status').value };
  const pkg = { ...f.pkg, entry: f.entry };
  closeDialog($('#dlg-upload'));
  await runPublish({
    title: t('progress.title'),
    steps: ['validate', 'upload', 'commit', 'deploy', 'verify'],
    action: (onProgress) => publishConcept(state.client, { pkg, meta, mode: f.mode, thumbnail: f.thumb }, onProgress),
    successKey: 'success',
    urlOf: (res) => conceptUrl(res.concept),
  });
}

// ---------------------------------------------------------------------------
// Edit details
// ---------------------------------------------------------------------------
function openEditDialog(c) {
  state.edit = { slug: c.slug, concept: c, thumb: null };
  $('#edit-title').textContent = t('edit.title', { name: c.name });
  $('#e-name').value = c.name || '';
  $('#e-project').value = c.project || '';
  $('#e-desc').value = c.description || '';
  $('#e-status').value = c.status || 'published';
  $('#e-thumb').value = '';
  const tp = $('#e-thumb-preview');
  if (c.thumbnail) { tp.src = `${siteBase()}${c.thumbnail}?v=${c.version || 1}`; tp.hidden = false; } else { tp.hidden = true; tp.removeAttribute('src'); }
  $('#e-url').textContent = conceptUrl(c);
  $('#edit-error').hidden = true;
  openDialog($('#dlg-edit'));
  $('#e-name').focus();
}

async function submitEdit(e) {
  e.preventDefault();
  const ed = state.edit;
  if (!ed) return;
  const name = $('#e-name').value.trim();
  if (!name) { const box = $('#edit-error'); box.textContent = t('form.required'); box.hidden = false; return; }
  const patch = { name, project: $('#e-project').value, description: $('#e-desc').value, status: $('#e-status').value };
  closeDialog($('#dlg-edit'));
  await runPublish({
    title: t('progress.title'),
    steps: ['commit', 'deploy'],
    action: (onProgress) => updateConceptMeta(state.client, ed.slug, patch, ed.thumb, onProgress),
    successKey: 'updated',
    urlOf: (res) => conceptUrl(res.concept),
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
function openDeleteDialog(c) {
  state.del = { slug: c.slug, concept: c };
  $('#delete-body').textContent = t('delete.body', { name: c.name, url: conceptUrl(c) });
  $('#d-confirm').value = '';
  $('#btn-submit-delete').disabled = true;
  $('#delete-error').hidden = true;
  openDialog($('#dlg-delete'));
  $('#d-confirm').focus();
}

async function submitDelete(e) {
  e.preventDefault();
  const d = state.del;
  if (!d || $('#d-confirm').value.trim() !== d.slug) return;
  closeDialog($('#dlg-delete'));
  await runPublish({
    title: t('progress.title'),
    steps: ['commit', 'deploy'],
    action: (onProgress) => deleteConcept(state.client, d.slug, onProgress),
    successKey: 'deleted',
    urlOf: () => null,
  });
}

// ---------------------------------------------------------------------------
// Progress + result
// ---------------------------------------------------------------------------
const STEP_KEYS = { validate: 'progress.validate', upload: 'progress.upload', tree: 'progress.tree', commit: 'progress.commit', deploy: 'progress.deploy', verify: 'progress.verify' };

function setupProgress(title, steps) {
  const dlg = $('#dlg-progress');
  $('#progress-title').textContent = title;
  const ol = $('#progress-steps');
  clear(ol);
  for (const s of steps) ol.append(el('li', { dataset: { step: s }, class: 'step' }, el('span', { class: 'step-dot' }), el('span', { class: 'step-label' }, t(STEP_KEYS[s]))));
  $('#progress-detail').textContent = '';
  $('#result').hidden = true;
  $('#btn-progress-close').hidden = true;
  $('#btn-result-close').hidden = true;
  openDialog(dlg);
  return {
    set(step, status, detail) {
      const cur = step === '__done__' ? steps.length : steps.indexOf(step);
      for (const li of $$('#progress-steps li')) {
        const idx = steps.indexOf(li.dataset.step);
        li.className = `step ${idx < cur ? 'done' : idx === cur ? status : ''}`;
      }
      if (detail !== undefined) $('#progress-detail').textContent = detail;
    },
    label(step, text) {
      const li = $(`#progress-steps li[data-step="${step}"] .step-label`);
      if (li) li.textContent = text;
    },
  };
}

function showResult({ kind, titleKey, bodyKey, url, verified, commitSha, runUrl, error }) {
  const res = $('#result');
  res.hidden = false;
  $('#result-icon').className = `result-icon result-${kind}`;
  clear($('#result-icon')).append(svgIcon(kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err'));
  $('#result-title').textContent = t(titleKey);
  $('#result-body').textContent = t(bodyKey);
  const urlBox = $('#result-url-box');
  if (url) {
    urlBox.hidden = false;
    $('#result-url').textContent = url;
    $('#btn-result-open').href = url;
    $('#btn-result-copy').onclick = () => copyLink(url);
  } else urlBox.hidden = true;
  const ver = $('#result-verify');
  if (verified === true) { ver.textContent = '✓ ' + t('progress.verify'); ver.className = 'hint ok'; ver.hidden = false; } else ver.hidden = true;
  const errBox = $('#result-error');
  if (error) { errBox.textContent = error; errBox.hidden = false; } else errBox.hidden = true;
  const links = $('#result-links');
  clear(links);
  if (commitSha) links.append(el('a', { href: repoUrl(`/commit/${commitSha}`), target: '_blank', rel: 'noopener noreferrer' }, t('result.viewCommit'), ' ↗'));
  if (runUrl) links.append(el('a', { href: runUrl, target: '_blank', rel: 'noopener noreferrer' }, t('result.viewRun'), ' ↗'));
  else if (commitSha) links.append(el('a', { href: repoUrl('/actions'), target: '_blank', rel: 'noopener noreferrer' }, t('result.actions'), ' ↗'));
  $('#btn-progress-close').hidden = false;
  $('#btn-result-close').hidden = false;
  $('#progress-title').textContent = t(titleKey);
}

async function verifyUrl(url) {
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return null;
  }
}

async function runPublish({ title, steps, action, successKey, urlOf }) {
  state.busy = true;
  const beforeUnload = (ev) => { ev.preventDefault(); ev.returnValue = ''; };
  window.addEventListener('beforeunload', beforeUnload);
  const ui = setupProgress(title, steps);
  let result = null;
  try {
    ui.set(steps[0], 'active');
    result = await action((p) => {
      if (p.stage === 'validate') ui.set('validate', 'active');
      else if (p.stage === 'upload') { ui.set('upload', 'active'); ui.label('upload', t('progress.uploadN', { i: p.current, n: p.total })); }
      else if (p.stage === 'tree') ui.set('upload', 'active', t('progress.tree'));
      else if (p.stage === 'commit') ui.set('commit', 'active', '');
      else if (p.stage === 'retry') ui.set('commit', 'active', t('progress.retry'));
    });
  } catch (e) {
    ui.set(steps[0], 'error');
    showResult({ kind: 'err', titleKey: 'result.commitFailed', bodyKey: 'result.commitFailedBody', error: formatError(e) });
    state.busy = false;
    window.removeEventListener('beforeunload', beforeUnload);
    return;
  }
  const commitSha = result.commitSha;
  const url = urlOf(result);
  // Refresh the list from the repository in the background.
  loadConcepts();
  ui.set('deploy', 'active', t('progress.waiting'));
  const dep = await waitForDeploy({
    client: state.client,
    commitSha,
    siteBase: siteBase(),
    timeoutMs: CONFIG.deploy.timeoutMs,
    intervalMs: CONFIG.deploy.intervalMs,
    onProgress: (p) => {
      if (p.stage === 'deploy' && p.run) ui.set('deploy', 'active', t('progress.run', { n: p.run.run_number, status: p.run.status === 'completed' ? p.run.conclusion : p.run.status }));
    },
  });
  window.removeEventListener('beforeunload', beforeUnload);
  state.busy = false;
  if (dep.status === 'success') {
    let verified = null;
    if (url && steps.includes('verify')) { ui.set('verify', 'active'); verified = await verifyUrl(url); }
    ui.set('__done__', 'done');
    showResult({ kind: 'ok', titleKey: `result.${successKey}`, bodyKey: `result.${successKey}Body`, url, verified, commitSha, runUrl: dep.runUrl });
  } else if (dep.status === 'failed') {
    ui.set('deploy', 'error');
    showResult({ kind: 'err', titleKey: 'result.deployFailed', bodyKey: 'result.deployFailedBody', url, commitSha, runUrl: dep.runUrl });
  } else {
    ui.set('deploy', 'active');
    showResult({ kind: 'warn', titleKey: 'result.timeout', bodyKey: 'result.timeoutBody', url, commitSha, runUrl: dep.runUrl });
  }
  loadConcepts();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  wireDialogs();
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-lang').addEventListener('click', () => { setLang(getLang() === 'vi' ? 'en' : 'vi'); renderAll(); });
  $('#btn-help').addEventListener('click', () => {
    const help = $('#help');
    help.hidden = !help.hidden;
    $('#btn-help').setAttribute('aria-expanded', String(!help.hidden));
    if (!help.hidden) help.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#btn-signin').addEventListener('click', openAuthDialog);
  $('#btn-signout').addEventListener('click', signOut);
  $('#form-auth').addEventListener('submit', submitAuth);
  $('#btn-upload').addEventListener('click', () => openUploadDialog('create'));

  $('#search').addEventListener('input', (e) => { state.filters.q = e.target.value; renderList(); });
  $('#filter-project').addEventListener('change', (e) => { state.filters.project = e.target.value; renderList(); });
  $('#filter-status').addEventListener('change', (e) => { state.filters.status = e.target.value; renderList(); });
  $('#sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; renderList(); });

  // Upload form
  $('#form-upload').addEventListener('submit', submitUpload);
  $('#f-name').addEventListener('input', onNameInput);
  $('#f-slug').addEventListener('input', () => onSlugInput(true));
  $('#f-file').addEventListener('change', (e) => handleFile(e.target.files && e.target.files[0]));
  $('#f-entry').addEventListener('change', (e) => { state.form.entry = e.target.value; renderPackagePanel(); });
  $('#f-thumb').addEventListener('change', (e) => onThumbChange(e.target, $('#f-thumb-preview'), state.form));
  $('#btn-preview').addEventListener('click', openPreview);
  const dz = $('#dropzone');
  for (const evt of ['dragenter', 'dragover']) dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('drag'); });
  for (const evt of ['dragleave', 'drop']) dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('drag'); });
  dz.addEventListener('drop', (e) => { const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (file) handleFile(file); });

  // Edit form
  $('#form-edit').addEventListener('submit', submitEdit);
  $('#e-thumb').addEventListener('change', (e) => onThumbChange(e.target, $('#e-thumb-preview'), state.edit));

  // Delete form
  $('#form-delete').addEventListener('submit', submitDelete);
  $('#d-confirm').addEventListener('input', (e) => { $('#btn-submit-delete').disabled = !state.del || e.target.value.trim() !== state.del.slug; });
}

async function init() {
  initTheme();
  setLang(detectLang());
  applyI18n();
  wire();
  renderAll();
  const token = loadStoredToken();
  if (token) {
    try {
      await signIn(token, null);
      return;
    } catch {
      clearToken();
    }
  }
  await loadConcepts();
}

init();

// Exposed for tests / debugging only (no secrets).
window.__mva = { state, loadConcepts, renderAll, handleFile };
