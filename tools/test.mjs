#!/usr/bin/env node
// Unit + integration tests. Run: `npm test`. Requires devDependencies (jsdom, jszip).
// The GitHub API is simulated in memory (FakeGitHub) so the full publish → deploy flow is exercised.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const mod = (p) => import(pathToFileURL(join(root, 'assets/js', p)).href);

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  ok   ${name}`); }
  catch (e) { results.push([name, false, e]); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); }
}

// ---------------------------------------------------------------------------
// Fake GitHub (in-memory Git Data API subset)
// ---------------------------------------------------------------------------
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
class FakeGitHub {
  constructor({ owner = 'MVALabVision', repo = 'ConceptsMVA', branch = 'main', files = {}, permissions = { push: true, pull: true } } = {}) {
    this.owner = owner; this.repo = repo; this.branch = branch; this.permissions = permissions;
    this.blobs = new Map(); this.trees = new Map(); this.commits = new Map();
    this.calls = [];
    this.runs = [];
    this.moveRefOnce = false;
    const entries = {};
    for (const [path, content] of Object.entries(files)) {
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
      const sha = this.putBlob(bytes);
      entries[path] = { mode: '100644', type: 'blob', sha };
    }
    const treeSha = this.putTree(entries);
    this.head = this.putCommit('initial', treeSha, []);
  }
  putBlob(bytes) { const sha = sha1('blob' + bytes.length + bytes.toString('binary')); this.blobs.set(sha, Buffer.from(bytes)); return sha; }
  putTree(entries) { const sha = sha1('tree' + JSON.stringify(Object.entries(entries).sort())); this.trees.set(sha, entries); return sha; }
  putCommit(message, tree, parents) { const sha = sha1('commit' + message + tree + parents.join() + this.commits.size); this.commits.set(sha, { sha, message, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })) }); return sha; }
  flat(treeSha) { return { ...(this.trees.get(treeSha) || {}) }; }
  fileAt(treeSha, path) { const e = this.flat(treeSha)[path]; return e ? this.blobs.get(e.sha) : null; }
  get fetch() {
    return async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const u = new URL(url);
      const auth = init.headers && init.headers.Authorization;
      this.calls.push(`${method} ${u.pathname}${u.search}`);
      const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
      const body = init.body ? JSON.parse(init.body) : null;
      const rp = `/repos/${this.owner}/${this.repo}`;
      if (!auth && !u.pathname.startsWith(`${rp}/compare/`) && u.pathname !== rp) return json(401, { message: 'Requires authentication' });
      if (auth && auth !== 'Bearer good-token') return json(401, { message: 'Bad credentials' });
      if (u.pathname === '/user') return json(200, { login: 'tester', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' });
      if (u.pathname === rp) return json(200, { full_name: `${this.owner}/${this.repo}`, default_branch: this.branch, permissions: this.permissions });
      if (u.pathname === `${rp}/git/ref/heads/${this.branch}`) return json(200, { ref: `refs/heads/${this.branch}`, object: { type: 'commit', sha: this.head } });
      let m;
      if ((m = u.pathname.match(new RegExp(`^${rp}/git/commits/([0-9a-f]+)$`))) && method === 'GET') { const c = this.commits.get(m[1]); return c ? json(200, c) : json(404, { message: 'Not Found' }); }
      if ((m = u.pathname.match(new RegExp(`^${rp}/contents/(.+)$`))) && method === 'GET') {
        const path = decodeURIComponent(m[1]);
        const ref = u.searchParams.get('ref');
        const treeSha = ref && this.commits.get(ref) ? this.commits.get(ref).tree.sha : this.commits.get(this.head).tree.sha;
        const flat = this.flat(treeSha);
        if (flat[path]) return json(200, { type: 'file', path, sha: flat[path].sha, content: this.blobs.get(flat[path].sha).toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64' });
        const dir = Object.keys(flat).filter((p) => p.startsWith(path + '/'));
        if (dir.length) return json(200, dir.map((p) => ({ type: 'file', path: p })));
        return json(404, { message: 'Not Found' });
      }
      if (u.pathname === `${rp}/git/blobs` && method === 'POST') { const bytes = Buffer.from(body.content, 'base64'); return json(201, { sha: this.putBlob(bytes) }); }
      if (u.pathname === `${rp}/git/trees` && method === 'POST') {
        const base = body.base_tree ? this.flat(body.base_tree) : {};
        for (const e of body.tree) {
          if (e.sha === null) { delete base[e.path]; continue; }
          if (e.type === 'tree') {
            for (const p of Object.keys(base)) if (p.startsWith(e.path + '/')) delete base[p];
            const sub = this.flat(e.sha);
            if (!this.trees.has(e.sha)) return json(422, { message: `Tree SHA ${e.sha} not found` });
            for (const [p, v] of Object.entries(sub)) base[`${e.path}/${p}`] = v;
          } else {
            if (!this.blobs.has(e.sha)) return json(422, { message: `Blob SHA ${e.sha} not found` });
            base[e.path] = { mode: e.mode, type: 'blob', sha: e.sha };
          }
        }
        return json(201, { sha: this.putTree(base) });
      }
      if ((m = u.pathname.match(new RegExp(`^${rp}/git/trees/([0-9a-f]+)$`))) && method === 'GET') {
        const flat = this.flat(m[1]);
        return json(200, { sha: m[1], truncated: false, tree: Object.entries(flat).map(([path, v]) => ({ path, mode: v.mode, type: 'blob', sha: v.sha })) });
      }
      if (u.pathname === `${rp}/git/commits` && method === 'POST') { if (!this.trees.has(body.tree)) return json(422, { message: 'tree not found' }); return json(201, { sha: this.putCommit(body.message, body.tree, body.parents) }); }
      if (u.pathname === `${rp}/git/refs/heads/${this.branch}` && method === 'PATCH') {
        if (this.moveRefOnce) { this.moveRefOnce = false; this.head = this.putCommit('someone else', this.commits.get(this.head).tree.sha, [this.head]); }
        const c = this.commits.get(body.sha);
        if (!c || c.parents[0].sha !== this.head) return json(422, { message: 'Update is not a fast forward' });
        this.head = body.sha;
        return json(200, { object: { sha: this.head } });
      }
      if (u.pathname === `${rp}/actions/runs` && method === 'GET') { const sha = u.searchParams.get('head_sha'); return json(200, { total_count: 0, workflow_runs: this.runs.filter((r) => r.head_sha === sha) }); }
      if ((m = u.pathname.match(new RegExp(`^${rp}/compare/([0-9a-f]+)\\.\\.\\.([0-9a-f]+)$`)))) {
        let cur = m[2]; let ahead = 0;
        while (cur && cur !== m[1]) { const c = this.commits.get(cur); cur = c && c.parents[0] ? c.parents[0].sha : null; ahead++; }
        return json(200, { status: cur === m[1] ? (ahead ? 'ahead' : 'identical') : 'diverged' });
      }
      return json(404, { message: `Unhandled ${method} ${u.pathname}` });
    };
  }
}

const sampleHtml = readFileSync(join(root, 'concepts/tram-pas-hfs-vina/index.html'), 'utf8');
const baseIndex = readFileSync(join(root, 'data/concepts.json'), 'utf8');

console.log('\nslug.js');
{
  const { slugify, isValidSlug, uniqueSlug } = await mod('slug.js');
  await test('slugify Vietnamese and punctuation', () => {
    assert.equal(slugify('Trạm PAS HFS VINA'), 'tram-pas-hfs-vina');
    assert.equal(slugify('SHINYEI Drop Test Vision'), 'shinyei-drop-test-vision');
    assert.equal(slugify('  Đường dây — Băng tải (v2)!  '), 'duong-day-bang-tai-v2');
    assert.equal(slugify(''), '');
    assert.equal(slugify('a'.repeat(100)).length, 64);
  });
  await test('isValidSlug / uniqueSlug', () => {
    assert.ok(isValidSlug('abc-123'));
    assert.ok(!isValidSlug('-abc'));
    assert.ok(!isValidSlug('Abc'));
    assert.ok(!isValidSlug('a..b'));
    assert.equal(uniqueSlug('x', ['x', 'x-2']), 'x-3');
    assert.equal(uniqueSlug('y', ['x']), 'y');
  });
}

console.log('\npackage.js');
{
  const pkg = await mod('package.js');
  const limits = { maxPackageBytes: 1e7, maxFileBytes: 5e6, maxUnzippedBytes: 2e7, maxFiles: 50 };
  await test('inspectHtml classifies references of the sample concept', () => {
    const info = pkg.inspectHtml(sampleHtml);
    assert.equal(info.title, 'Trạm PAS HFS VINA');
    assert.ok(info.looksHtml);
    assert.ok(info.external.some((u) => u.includes('three@0.147.0/build/three.min.js')));
    assert.deepEqual(info.relative, []);
    assert.deepEqual(info.insecure, []);
  });
  await test('inspectHtml flags relative / insecure / file refs', () => {
    const info = pkg.inspectHtml('<html><script src="js/app.js"></script><img src="http://x.com/a.png"><link href="file:///C:/x.css"><a href="#top">t</a><div style="background:url(\'img/bg.png\')"></div><script type="module">import * as T from "./lib/three.js";</script></html>');
    assert.deepEqual(info.relative.sort(), ['./lib/three.js', 'img/bg.png', 'js/app.js']);
    assert.deepEqual(info.insecure, ['http://x.com/a.png']);
    assert.deepEqual(info.localFile, ['file:///C:/x.css']);
  });
  await test('normalizeZipPath rejects traversal and absolute paths', () => {
    assert.ok(pkg.normalizeZipPath('../etc/passwd').error);
    assert.ok(pkg.normalizeZipPath('/abs').error);
    assert.ok(pkg.normalizeZipPath('C:\\win').error);
    assert.ok(pkg.normalizeZipPath('a/./b').error);
    assert.ok(pkg.normalizeZipPath('.git/config').error);
    assert.deepEqual(pkg.normalizeZipPath('assets\\x.png'), { path: 'assets/x.png', hadBackslash: true });
  });
  await test('inspectZip unwraps root folder, skips junk, picks entry, checks refs', async () => {
    const zip = new JSZip();
    zip.file('concept/index.html', '<html><script src="js/app.js"></script><img src="Assets/logo.png"><img src="missing.png"></html>');
    zip.file('concept/js/app.js', 'console.log(1)');
    zip.file('concept/assets/logo.png', new Uint8Array([1, 2, 3]));
    zip.file('__MACOSX/concept/._index.html', 'junk');
    zip.file('concept/.DS_Store', 'junk');
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const res = await pkg.inspectZip(buf, limits, JSZip);
    assert.equal(res.strippedRoot, 'concept');
    assert.deepEqual(res.files.map((f) => f.path), ['assets/logo.png', 'index.html', 'js/app.js']);
    assert.equal(res.entry, 'index.html');
    assert.equal(res.skipped, 2);
    const analysis = pkg.analyzePackage(res, 'index.html');
    const keys = analysis.warnings.map((w) => w.key);
    assert.ok(keys.includes('pkg.relativeMissing'), 'missing.png should be reported');
    assert.ok(keys.includes('pkg.caseMismatch'), 'Assets/logo.png should be a case mismatch');
    const missing = analysis.warnings.find((w) => w.key === 'pkg.relativeMissing').vars.list;
    assert.ok(missing.includes('missing.png') && !missing.includes('js/app.js'));
  });
  await test('inspectZip rejects traversal entries and oversize content', async () => {
    // JSZip itself strips "../" and leading "/" on load (zip-slip fix in 3.8+); our own check adds .git and drive letters.
    const bad = new JSZip();
    bad.file('ok.html', '<html></html>');
    bad.file('.git/config', 'x');
    await assert.rejects(pkg.inspectZip(await bad.generateAsync({ type: 'uint8array' }), limits, JSZip), (e) => e.code === 'pkg.unsafePath');
    const slip = new JSZip();
    slip.file('ok.html', '<html></html>');
    slip.file('../evil.txt', 'x');
    const slipRes = await pkg.inspectZip(await slip.generateAsync({ type: 'uint8array' }), limits, JSZip);
    assert.ok(slipRes.files.every((f) => !f.path.includes('..')), 'no traversal path survives');
    const big = new JSZip();
    big.file('index.html', '<html></html>');
    big.file('big.bin', new Uint8Array(6e6));
    await assert.rejects(pkg.inspectZip(await big.generateAsync({ type: 'uint8array' }), limits, JSZip), (e) => e.code === 'pkg.unzippedTooBig' || e.code === 'pkg.tooBig');
    const many = new JSZip();
    for (let i = 0; i < 60; i++) many.file(`f${i}.txt`, 'x');
    await assert.rejects(pkg.inspectZip(await many.generateAsync({ type: 'uint8array' }), limits, JSZip), (e) => e.code === 'pkg.tooMany');
  });
  await test('inspectZip with no html reports an error warning', async () => {
    const z = new JSZip();
    z.file('a.txt', 'x');
    const res = await pkg.inspectZip(await z.generateAsync({ type: 'uint8array' }), limits, JSZip);
    assert.equal(res.entry, null);
    assert.ok(res.warnings.some((w) => w.key === 'pkg.noHtml' && w.level === 'error'));
  });
  await test('inspectHtmlBytes stores as index.html', () => {
    const res = pkg.inspectHtmlBytes(new TextEncoder().encode(sampleHtml), limits);
    assert.equal(res.kind, 'html');
    assert.equal(res.files[0].path, 'index.html');
    assert.equal(res.title, 'Trạm PAS HFS VINA');
  });
}

console.log('\ngithub.js');
{
  const gh = await mod('github.js');
  const makeClient = (fake, token = 'good-token') => new gh.GitHubClient({ token, owner: 'MVALabVision', repo: 'ConceptsMVA', branch: 'main', fetchImpl: fake.fetch });
  const htmlPkg = { kind: 'html', files: [{ path: 'index.html', bytes: new TextEncoder().encode('<html><title>New</title></html>') }], entry: 'index.html', totalBytes: 30 };

  await test('whoAmI / getRepo / bad token', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex } });
    const c = makeClient(fake);
    assert.equal((await c.whoAmI()).login, 'tester');
    assert.equal((await c.getRepo()).permissions.push, true);
    await assert.rejects(makeClient(fake, 'bad').whoAmI(), (e) => e instanceof gh.GitHubError && e.status === 401);
  });

  await test('publishConcept creates folder + index in one commit', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex, 'concepts/tram-pas-hfs-vina/index.html': sampleHtml } });
    const c = makeClient(fake);
    const stages = [];
    const res = await gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'new-concept', name: 'New Concept', project: 'P', description: 'd', status: 'published' }, mode: 'create', thumbnail: new Uint8Array([255, 216, 255]) }, (p) => stages.push(p.stage));
    assert.ok(res.commitSha);
    assert.equal(fake.head, res.commitSha);
    const tree = fake.commits.get(fake.head).tree.sha;
    assert.ok(fake.fileAt(tree, 'concepts/new-concept/index.html'));
    assert.ok(fake.fileAt(tree, 'data/thumbs/new-concept.jpg'));
    assert.ok(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/index.html'), 'existing concept untouched');
    const index = JSON.parse(fake.fileAt(tree, 'data/concepts.json').toString('utf8'));
    assert.equal(index.concepts.length, 2);
    const nc = index.concepts.find((x) => x.slug === 'new-concept');
    assert.equal(nc.version, 1);
    assert.equal(nc.thumbnail, 'data/thumbs/new-concept.jpg');
    assert.equal(nc.entry, 'index.html');
    assert.ok(stages.includes('upload') && stages.includes('commit'));
    assert.equal(fake.commits.get(fake.head).message, 'concept: publish "New Concept" (new-concept)');
  });

  await test('publishConcept refuses duplicate slug and orphan folder', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex, 'concepts/orphan/index.html': '<html></html>' } });
    const c = makeClient(fake);
    await assert.rejects(gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'tram-pas-hfs-vina', name: 'x' }, mode: 'create' }), (e) => e.code === 'SLUG_TAKEN');
    await assert.rejects(gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'orphan', name: 'x' }, mode: 'create' }), (e) => e.code === 'SLUG_TAKEN');
    await assert.rejects(gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'nope', name: 'x' }, mode: 'replace' }), (e) => e.code === 'NOT_FOUND');
  });

  await test('replace swaps the whole folder, bumps version, keeps slug', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex, 'concepts/tram-pas-hfs-vina/index.html': sampleHtml, 'concepts/tram-pas-hfs-vina/old.js': 'old' } });
    const c = makeClient(fake);
    const zipPkg = { kind: 'zip', files: [{ path: 'index.html', bytes: new TextEncoder().encode('<html>v2</html>') }, { path: 'assets/a.bin', bytes: new Uint8Array([9]) }], entry: 'index.html', totalBytes: 20 };
    const res = await gh.publishConcept(c, { pkg: zipPkg, meta: { slug: 'tram-pas-hfs-vina', name: 'Trạm PAS HFS VINA v2', project: 'HFS VINA', description: '', status: 'published' }, mode: 'replace' });
    const tree = fake.commits.get(res.commitSha).tree.sha;
    assert.equal(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/index.html').toString(), '<html>v2</html>');
    assert.ok(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/assets/a.bin'));
    assert.equal(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/old.js'), null, 'old file removed');
    const index = JSON.parse(fake.fileAt(tree, 'data/concepts.json').toString('utf8'));
    const cpt = index.concepts.find((x) => x.slug === 'tram-pas-hfs-vina');
    assert.equal(cpt.version, JSON.parse(baseIndex).concepts[0].version + 1);
    assert.equal(cpt.name, 'Trạm PAS HFS VINA v2');
    assert.equal(cpt.source, 'zip');
    assert.equal(index.concepts.length, 1);
  });

  await test('concurrent update: non-fast-forward is retried', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex } });
    fake.moveRefOnce = true;
    const c = makeClient(fake);
    const stages = [];
    const res = await gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'retry-me', name: 'Retry' }, mode: 'create' }, (p) => stages.push(p.stage));
    assert.ok(stages.includes('retry'));
    assert.equal(fake.head, res.commitSha);
    assert.equal(fake.commits.get(res.commitSha).parents[0].sha, fake.commits.get(fake.head).parents[0].sha);
  });

  await test('updateConceptMeta changes index only; deleteConcept removes folder + thumb + entry', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex, 'concepts/tram-pas-hfs-vina/index.html': sampleHtml, 'concepts/tram-pas-hfs-vina/a/b.txt': 'x', 'data/thumbs/tram-pas-hfs-vina.jpg': 'jpg' } });
    const c = makeClient(fake);
    const up = await gh.updateConceptMeta(c, 'tram-pas-hfs-vina', { description: 'new desc', status: 'archived' }, null);
    let tree = fake.commits.get(up.commitSha).tree.sha;
    let index = JSON.parse(fake.fileAt(tree, 'data/concepts.json').toString('utf8'));
    assert.equal(index.concepts[0].description, 'new desc');
    assert.equal(index.concepts[0].status, 'archived');
    assert.equal(index.concepts[0].name, 'Trạm PAS HFS VINA');
    assert.ok(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/index.html'));

    const del = await gh.deleteConcept(c, 'tram-pas-hfs-vina');
    tree = fake.commits.get(del.commitSha).tree.sha;
    assert.equal(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/index.html'), null);
    assert.equal(fake.fileAt(tree, 'concepts/tram-pas-hfs-vina/a/b.txt'), null);
    assert.equal(fake.fileAt(tree, 'data/thumbs/tram-pas-hfs-vina.jpg'), null);
    index = JSON.parse(fake.fileAt(tree, 'data/concepts.json').toString('utf8'));
    assert.equal(index.concepts.length, 0);
    assert.equal(del.removedFiles, 3);
    await assert.rejects(gh.deleteConcept(c, 'tram-pas-hfs-vina'), (e) => e.code === 'NOT_FOUND');
  });

  await test('waitForDeploy: success via build.json, failure via Actions, timeout', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex } });
    const c = makeClient(fake);
    let buildCommit = 'old';
    const siteFetch = async (url) => {
      if (String(url).includes('data/build.json')) return new Response(JSON.stringify({ commit: buildCommit, builtAt: new Date().toISOString() }), { status: 200 });
      return fake.fetch(url);
    };
    setTimeout(() => { buildCommit = 'abc'; }, 30);
    const r1 = await gh.waitForDeploy({ client: c, commitSha: 'abc', siteBase: 'https://x/', timeoutMs: 2000, intervalMs: 10, fetchImpl: siteFetch });
    assert.equal(r1.status, 'success');

    fake.runs.push({ head_sha: 'def', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/run/1', run_number: 1 });
    buildCommit = 'old';
    const r2 = await gh.waitForDeploy({ client: c, commitSha: 'def', siteBase: 'https://x/', timeoutMs: 2000, intervalMs: 10, fetchImpl: siteFetch });
    assert.equal(r2.status, 'failed');
    assert.equal(r2.runUrl, 'https://github.com/run/1');

    const r3 = await gh.waitForDeploy({ client: c, commitSha: 'zzz', siteBase: 'https://x/', timeoutMs: 60, intervalMs: 10, fetchImpl: siteFetch });
    assert.equal(r3.status, 'timeout');
  });

  await test('waitForDeploy: superseded commit counts as deployed (compare ahead)', async () => {
    const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex } });
    const c = makeClient(fake);
    const first = await gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'one', name: 'One' }, mode: 'create' });
    const second = await gh.publishConcept(c, { pkg: htmlPkg, meta: { slug: 'two', name: 'Two' }, mode: 'create' });
    const siteFetch = async (url) => String(url).includes('data/build.json')
      ? new Response(JSON.stringify({ commit: second.commitSha, builtAt: new Date().toISOString() }), { status: 200 })
      : fake.fetch(url);
    const r = await gh.waitForDeploy({ client: c, commitSha: first.commitSha, siteBase: 'https://x/', timeoutMs: 500, intervalMs: 10, fetchImpl: siteFetch });
    assert.equal(r.status, 'success');
    assert.equal(r.superseded, true);
  });
}

console.log('\napp.js (jsdom end-to-end with simulated GitHub + Pages)');
{
  const fake = new FakeGitHub({ files: { 'data/concepts.json': baseIndex, 'concepts/tram-pas-hfs-vina/index.html': sampleHtml } });
  let buildCommit = fake.head;
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://mvalabvision.github.io/ConceptsMVA/', pretendToBeVisual: true });
  const { window } = dom;
  // Minimal <dialog> support if jsdom lacks it.
  if (!window.HTMLDialogElement.prototype.showModal || !('open' in window.HTMLDialogElement.prototype)) {
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  }
  const siteFiles = () => fake.flat(fake.commits.get(buildCommit).tree.sha);
  window.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith('https://api.github.com/')) return fake.fetch(s, init);
    if (s.includes('/data/build.json')) return new Response(JSON.stringify({ commit: buildCommit, builtAt: new Date().toISOString() }), { status: 200 });
    const m = s.match(/^https:\/\/mvalabvision\.github\.io\/ConceptsMVA\/([^?]+)/);
    if (m) {
      const path = m[1].endsWith('/') ? m[1] + 'index.html' : m[1];
      const f = siteFiles()[path];
      return f ? new Response(fake.blobs.get(f.sha), { status: 200 }) : new Response('nf', { status: 404 });
    }
    return new Response('nf', { status: 404 });
  };
  window.Response = Response;
  const defineGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'Event', 'URLSearchParams']) {
    if (window[k] !== undefined) defineGlobal(k, window[k]);
  }
  defineGlobal('fetch', window.fetch);
  defineGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  const matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  defineGlobal('matchMedia', matchMedia);
  window.matchMedia = matchMedia;
  const { $, $$ } = await mod('util.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(20); } throw new Error('timeout waiting'); };

  await mod('app.js');

  await test('public library renders the deployed concept with correct link', async () => {
    await until(() => $$('.card').length === 1);
    const card = $('.card');
    assert.equal(card.querySelector('.card-title').textContent, 'Trạm PAS HFS VINA');
    const view = card.querySelector('a.btn-primary');
    assert.equal(view.href, 'https://mvalabvision.github.io/ConceptsMVA/concepts/tram-pas-hfs-vina/');
    assert.equal(view.target, '_blank');
    assert.ok(view.rel.includes('noopener'));
    assert.ok(!card.querySelector('.card-admin'), 'no admin controls when signed out');
    assert.ok($('#btn-upload').hidden);
  });

  await test('search filters cards', async () => {
    const search = $('#search');
    search.value = 'nothing-matches';
    search.dispatchEvent(new window.Event('input'));
    assert.equal($$('.card').length, 0);
    assert.ok(!$('#list-state').hidden);
    search.value = 'hfs';
    search.dispatchEvent(new window.Event('input'));
    assert.equal($$('.card').length, 1);
    search.value = '';
    search.dispatchEvent(new window.Event('input'));
  });

  await test('language toggle switches strings', async () => {
    $('#btn-lang').click();
    assert.equal($('h1').textContent, 'Thư viện Concept 3D');
    assert.equal($('.card .btn-primary span').textContent, 'Xem Concept');
    $('#btn-lang').click();
    assert.equal($('h1').textContent, '3D Concept Library');
  });

  await test('sign-in rejects bad token and accepts good token', async () => {
    $('#btn-signin').click();
    assert.ok($('#dlg-auth').open);
    $('#f-token').value = 'bad';
    $('#form-auth').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('#auth-error').hidden);
    assert.match($('#auth-error').textContent, /rejected|401/i);
    $('#f-token').value = 'good-token';
    $('#form-auth').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('#user-chip').hidden);
    assert.equal($('#user-login').textContent, 'tester');
    assert.equal(window.sessionStorage.getItem('mva.token'), 'good-token');
    assert.equal(window.localStorage.getItem('mva.token'), null, 'not remembered unless asked');
    await until(() => $$('.card-admin').length === 1);
    assert.ok(!$('#btn-upload').hidden);
    assert.ok($('#banner').hidden, 'site is up to date, no deploy banner');
  });

  await test('upload flow: inspect HTML, auto slug, publish, wait for deploy, show link', async () => {
    $('#btn-upload').click();
    assert.ok($('#dlg-upload').open);
    const file = new File([new TextEncoder().encode('<!doctype html><html><head><title>SHINYEI Drop Test Vision</title><script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script></head><body><canvas></canvas></body></html>')], 'drop-test.html', { type: 'text/html' });
    await window.__mva.handleFile(file);
    await until(() => !$('#pkg-panel').hidden && $('#pkg-summary').textContent.includes('Standalone'));
    assert.equal($('#f-name').value, 'SHINYEI Drop Test Vision');
    assert.equal($('#f-slug').value, 'shinyei-drop-test-vision');
    assert.ok($('#f-url').textContent.endsWith('/concepts/shinyei-drop-test-vision/'));
    await until(() => $('#f-slug-status').textContent.includes('Available'));
    assert.ok($$('#pkg-warnings li').some((li) => li.textContent.includes('external')), 'CDN notice shown');
    $('#f-project').value = 'SHINYEI';
    $('#f-desc').value = 'Drop test with vision inspection';
    // Simulate deployment completing shortly after the commit lands.
    const headBefore = fake.head;
    const deployWatcher = setInterval(() => { if (fake.head !== headBefore && buildCommit !== fake.head) buildCommit = fake.head; }, 30);
    $('#form-upload').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => $('#dlg-progress').open);
    await until(() => !$('#result').hidden, 15000);
    clearInterval(deployWatcher);
    assert.equal($('#result-title').textContent, 'Published successfully', $('#result-error').textContent);
    assert.equal($('#result-url').textContent, 'https://mvalabvision.github.io/ConceptsMVA/concepts/shinyei-drop-test-vision/');
    assert.equal($('#btn-result-open').href, 'https://mvalabvision.github.io/ConceptsMVA/concepts/shinyei-drop-test-vision/');
    assert.ok(!$('#result-verify').hidden, 'link verified against simulated site');
    const tree = fake.commits.get(fake.head).tree.sha;
    assert.ok(fake.fileAt(tree, 'concepts/shinyei-drop-test-vision/index.html'));
    const index = JSON.parse(fake.fileAt(tree, 'data/concepts.json').toString('utf8'));
    assert.equal(index.concepts.find((c) => c.slug === 'shinyei-drop-test-vision').project, 'SHINYEI');
    $('#btn-result-close').click();
    await until(() => $$('.card').length === 2);
  });

  await test('slug collision is detected locally and remotely', async () => {
    $('#btn-upload').click();
    $('#f-name').value = 'Trạm PAS HFS VINA';
    $('#f-name').dispatchEvent(new window.Event('input'));
    assert.equal($('#f-slug').value, 'tram-pas-hfs-vina');
    assert.ok($('#f-slug-status').textContent.includes('Already in use'));
    assert.ok(!$('#f-name-dup').hidden);
    $('#f-slug').value = 'fresh-slug';
    $('#f-slug').dispatchEvent(new window.Event('input'));
    await until(() => $('#f-slug-status').textContent.includes('Available'));
    $('#f-name').value = 'Collide';
    $('#f-name').dispatchEvent(new window.Event('input'));
    assert.equal($('#f-slug').value, 'fresh-slug', 'manual slug is kept after name edits');
    $('#dlg-upload').close();
  });

  await test('edit details commits metadata; delete requires typed slug', async () => {
    const card = $$('.card').find((c) => c.dataset.slug === 'shinyei-drop-test-vision');
    card.querySelectorAll('.card-admin .btn')[0].click();
    assert.ok($('#dlg-edit').open);
    $('#e-desc').value = 'Updated description';
    $('#e-status').value = 'archived';
    const headBefore = fake.head;
    const deployWatcher = setInterval(() => { if (fake.head !== headBefore) buildCommit = fake.head; }, 30);
    $('#form-edit').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('#result').hidden, 15000);
    clearInterval(deployWatcher);
    assert.equal($('#result-title').textContent, 'Details saved');
    let index = JSON.parse(fake.fileAt(fake.commits.get(fake.head).tree.sha, 'data/concepts.json').toString('utf8'));
    assert.equal(index.concepts.find((c) => c.slug === 'shinyei-drop-test-vision').status, 'archived');
    $('#btn-result-close').click();
    await until(() => $$('.card').find((c) => c.dataset.slug === 'shinyei-drop-test-vision' && c.classList.contains('card-archived')));

    const card2 = $$('.card').find((c) => c.dataset.slug === 'shinyei-drop-test-vision');
    card2.querySelectorAll('.card-admin .btn')[2].click();
    assert.ok($('#dlg-delete').open);
    assert.ok($('#btn-submit-delete').disabled);
    $('#d-confirm').value = 'wrong';
    $('#d-confirm').dispatchEvent(new window.Event('input'));
    assert.ok($('#btn-submit-delete').disabled);
    $('#d-confirm').value = 'shinyei-drop-test-vision';
    $('#d-confirm').dispatchEvent(new window.Event('input'));
    assert.ok(!$('#btn-submit-delete').disabled);
    const head2 = fake.head;
    const watcher2 = setInterval(() => { if (fake.head !== head2) buildCommit = fake.head; }, 30);
    $('#form-delete').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('#result').hidden, 15000);
    clearInterval(watcher2);
    assert.equal($('#result-title').textContent, 'Concept deleted');
    index = JSON.parse(fake.fileAt(fake.commits.get(fake.head).tree.sha, 'data/concepts.json').toString('utf8'));
    assert.ok(!index.concepts.some((c) => c.slug === 'shinyei-drop-test-vision'));
    assert.equal(fake.fileAt(fake.commits.get(fake.head).tree.sha, 'concepts/shinyei-drop-test-vision/index.html'), null);
    $('#btn-result-close').click();
    await until(() => $$('.card').length === 1);
  });

  await test('deploy failure is reported, not hidden', async () => {
    $('#btn-upload').click();
    const file = new File([new TextEncoder().encode('<html><title>Fail Case</title></html>')], 'f.html', { type: 'text/html' });
    await window.__mva.handleFile(file);
    await until(() => !$('#pkg-panel').hidden);
    await until(() => $('#f-slug-status').textContent.includes('Available'));
    const headBefore = fake.head;
    const watcher = setInterval(() => { if (fake.head !== headBefore && !fake.runs.length) fake.runs.push({ head_sha: fake.head, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/run/9', run_number: 9 }); }, 30);
    $('#form-upload').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => !$('#result').hidden, 15000);
    clearInterval(watcher);
    assert.equal($('#result-title').textContent, 'Deployment failed');
    assert.ok($$('#result-links a').some((a) => a.href === 'https://github.com/run/9'));
    $('#btn-result-close').click();
    fake.runs.length = 0;
  });

  await test('sign out clears token and admin UI', async () => {
    $('#btn-signout').click();
    await until(() => $('#user-chip').hidden);
    assert.equal(window.sessionStorage.getItem('mva.token'), null);
    await until(() => $$('.card').length >= 1);
    assert.equal($$('.card-admin').length, 0);
  });
  dom.window.close();
}

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
process.exit(failed.length ? 1 : 0);
