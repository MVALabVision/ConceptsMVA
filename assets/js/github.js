// GitHub REST client + publish/replace/delete operations built on the Git Data API.
// Every change is a single atomic commit on the configured branch (fast-forward only).
// No DOM access — testable in Node with a mocked fetch.

import { bytesToBase64, base64ToUtf8, utf8Encode, sleep } from './util.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status = 0, url = '', data = null, code = null, rateLimitReset = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.url = url;
    this.data = data;
    this.code = code;
    this.rateLimitReset = rateLimitReset;
  }
}

export class GitHubClient {
  constructor({ token, owner, repo, branch, fetchImpl }) {
    this.token = token || null;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  get repoPath() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  async request(method, path, body) {
    const url = path.startsWith('http') ? path : API + path;
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new GitHubError(`Network error: ${e && e.message ? e.message : e}`, { url, code: 'NETWORK' });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      const message = (data && typeof data === 'object' && data.message) || `HTTP ${res.status}`;
      throw new GitHubError(message, {
        status: res.status,
        url,
        data,
        code: res.status === 403 && remaining === '0' ? 'RATE_LIMIT' : null,
        rateLimitReset: remaining === '0' && reset ? Number(reset) * 1000 : null,
      });
    }
    return data;
  }

  whoAmI() {
    return this.request('GET', '/user');
  }

  getRepo() {
    return this.request('GET', this.repoPath);
  }

  // Verify what the token can really do on this repository. Fine-grained tokens expose no
  // scope list, so the only reliable check is to try: read the branch ref, then create a tiny
  // blob. The blob is content-addressed (repeated probes add nothing) and unreferenced, so it
  // never appears in the repository and is garbage-collected by GitHub.
  async probeAccess() {
    try {
      await this.request('GET', `${this.repoPath}/git/ref/heads/${this.branch}`);
    } catch (e) {
      if (e.status === 409) throw new GitHubError(e.message, { status: 409, code: 'EMPTY_REPO', data: e.data });
      if (e.status === 403 || e.status === 404 || e.status === 401) throw new GitHubError(e.message, { status: e.status, code: 'NO_REPO_ACCESS', data: e.data });
      throw e;
    }
    try {
      await this.request('POST', `${this.repoPath}/git/blobs`, { content: 'mva-concept-studio access probe\n', encoding: 'utf-8' });
    } catch (e) {
      if (e.status === 403 || e.status === 404 || e.status === 401) throw new GitHubError(e.message, { status: e.status, code: 'NO_WRITE', data: e.data });
      throw e;
    }
    return true;
  }

  async getHead() {
    let ref;
    try {
      ref = await this.request('GET', `${this.repoPath}/git/ref/heads/${this.branch}`);
    } catch (e) {
      if (e.status === 409 || e.status === 404) throw new GitHubError('Repository has no commits on this branch', { status: e.status, code: 'EMPTY_REPO' });
      throw e;
    }
    const commit = await this.request('GET', `${this.repoPath}/git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, tree: commit.tree.sha };
  }

  // Returns { text, sha } or null when the file does not exist.
  async readTextFile(path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const data = await this.request('GET', `${this.repoPath}/contents/${encodePath(path)}${q}`);
      if (!data || data.type !== 'file') return null;
      return { text: base64ToUtf8(data.content || ''), sha: data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async pathExists(path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      await this.request('GET', `${this.repoPath}/contents/${encodePath(path)}${q}`);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  async createBlob(bytes) {
    const data = await this.request('POST', `${this.repoPath}/git/blobs`, {
      content: bytesToBase64(bytes),
      encoding: 'base64',
    });
    return data.sha;
  }

  async createTree(tree, baseTree) {
    const body = { tree };
    if (baseTree) body.base_tree = baseTree;
    return this.request('POST', `${this.repoPath}/git/trees`, body);
  }

  createCommit(message, tree, parents) {
    return this.request('POST', `${this.repoPath}/git/commits`, { message, tree, parents });
  }

  updateRef(sha, force = false) {
    return this.request('PATCH', `${this.repoPath}/git/refs/heads/${this.branch}`, { sha, force });
  }

  getTreeRecursive(treeSha) {
    return this.request('GET', `${this.repoPath}/git/trees/${treeSha}?recursive=1`);
  }

  listRunsForSha(sha) {
    return this.request('GET', `${this.repoPath}/actions/runs?head_sha=${sha}&per_page=10`);
  }

  compare(base, head) {
    return this.request('GET', `${this.repoPath}/compare/${base}...${head}`);
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export const INDEX_PATH = 'data/concepts.json';

export function emptyIndex() {
  return { version: 1, updatedAt: null, concepts: [] };
}

export async function loadIndexFromRepo(client, ref) {
  const file = await client.readTextFile(INDEX_PATH, ref);
  if (!file) return emptyIndex();
  try {
    const parsed = JSON.parse(file.text);
    if (!parsed || !Array.isArray(parsed.concepts)) return emptyIndex();
    return parsed;
  } catch {
    throw new GitHubError(`${INDEX_PATH} is not valid JSON`, { code: 'BAD_INDEX' });
  }
}

export function serializeIndex(index) {
  const sorted = [...index.concepts].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const out = { version: 1, updatedAt: new Date().toISOString(), concepts: sorted };
  return JSON.stringify(out, null, 2) + '\n';
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function thumbPath(slug) {
  return `data/thumbs/${slug}.jpg`;
}

function cleanMeta(meta) {
  return {
    name: String(meta.name || '').trim(),
    project: String(meta.project || '').trim(),
    description: String(meta.description || '').trim(),
    status: meta.status === 'archived' ? 'archived' : 'published',
  };
}

// Commit a set of tree entries on top of HEAD, retrying on concurrent updates.
async function commitWithRetry(client, buildEntries, message, onProgress, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const head = await client.getHead();
    const index = await loadIndexFromRepo(client, head.sha);
    const built = await buildEntries({ head, index, attempt });
    const tree = await client.createTree(built.entries, head.tree);
    onProgress({ stage: 'commit' });
    const commit = await client.createCommit(built.message || message, tree.sha, [head.sha]);
    try {
      await client.updateRef(commit.sha, false);
    } catch (e) {
      if (e.status === 422 && attempt < attempts) {
        onProgress({ stage: 'retry', attempt });
        await sleep(800 * attempt);
        continue;
      }
      throw e;
    }
    return { commitSha: commit.sha, ...built.result };
  }
  throw new GitHubError('Could not update the branch after several attempts', { code: 'CONFLICT' });
}

// Publish (mode 'create') or replace (mode 'replace') a concept package.
// pkg: { kind, files: [{path, bytes}], entry, totalBytes }
// meta: { slug, name, project, description, status }
// thumbnail: Uint8Array | null  (JPEG)
export async function publishConcept(client, { pkg, meta, mode, thumbnail }, onProgress = () => {}) {
  const slug = meta.slug;
  if (!pkg || !pkg.files || !pkg.files.length) throw new GitHubError('Package is empty', { code: 'EMPTY_PACKAGE' });
  if (!pkg.files.some((f) => f.path === pkg.entry)) throw new GitHubError('Entry file is not in the package', { code: 'NO_ENTRY' });

  onProgress({ stage: 'validate' });
  const head0 = await client.getHead();
  const index0 = await loadIndexFromRepo(client, head0.sha);
  const existing0 = index0.concepts.find((c) => c.slug === slug);
  if (mode === 'create') {
    if (existing0) throw new GitHubError(`Slug "${slug}" already exists`, { status: 409, code: 'SLUG_TAKEN' });
    if (await client.pathExists(`concepts/${slug}`, head0.sha)) throw new GitHubError(`Folder concepts/${slug} already exists`, { status: 409, code: 'SLUG_TAKEN' });
  } else if (!existing0) {
    throw new GitHubError(`Concept "${slug}" not found`, { status: 404, code: 'NOT_FOUND' });
  }

  // Upload blobs once; they are content-addressed and reusable across retries.
  const total = pkg.files.length;
  let uploaded = 0;
  onProgress({ stage: 'upload', current: 0, total });
  const blobs = await mapLimit(pkg.files, 4, async (file) => {
    const sha = await client.createBlob(file.bytes);
    uploaded++;
    onProgress({ stage: 'upload', current: uploaded, total, path: file.path });
    return { path: file.path, mode: '100644', type: 'blob', sha };
  });
  onProgress({ stage: 'tree' });
  const subtree = await client.createTree(blobs);
  const thumbSha = thumbnail ? await client.createBlob(thumbnail) : null;

  const built = await commitWithRetry(client, async ({ index }) => {
    const existing = index.concepts.find((c) => c.slug === slug);
    if (mode === 'create' && existing) throw new GitHubError(`Slug "${slug}" already exists`, { status: 409, code: 'SLUG_TAKEN' });
    if (mode === 'replace' && !existing) throw new GitHubError(`Concept "${slug}" not found`, { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const clean = cleanMeta(meta);
    const concept = existing
      ? { ...existing, ...clean, entry: pkg.entry, source: pkg.kind, files: total, bytes: pkg.totalBytes, version: (existing.version || 1) + 1, updatedAt: now }
      : { slug, ...clean, entry: pkg.entry, source: pkg.kind, files: total, bytes: pkg.totalBytes, version: 1, createdAt: now, updatedAt: now, thumbnail: null };
    const entries = [{ path: `concepts/${slug}`, mode: '040000', type: 'tree', sha: subtree.sha }];
    if (thumbSha) {
      concept.thumbnail = thumbPath(slug);
      entries.push({ path: concept.thumbnail, mode: '100644', type: 'blob', sha: thumbSha });
    }
    const others = index.concepts.filter((c) => c.slug !== slug);
    const newIndex = { ...index, concepts: [...others, concept] };
    const indexSha = await client.createBlob(utf8Encode(serializeIndex(newIndex)));
    entries.push({ path: INDEX_PATH, mode: '100644', type: 'blob', sha: indexSha });
    const message = mode === 'create'
      ? `concept: publish "${concept.name}" (${slug})`
      : `concept: replace "${concept.name}" (${slug}) v${concept.version}`;
    return { entries, message, result: { concept, index: newIndex } };
  }, '', onProgress);

  return built;
}

// Update metadata (name, project, description, status) and optionally the thumbnail.
export async function updateConceptMeta(client, slug, patch, thumbnail, onProgress = () => {}) {
  const thumbSha = thumbnail ? await client.createBlob(thumbnail) : null;
  return commitWithRetry(client, async ({ index }) => {
    const existing = index.concepts.find((c) => c.slug === slug);
    if (!existing) throw new GitHubError(`Concept "${slug}" not found`, { status: 404, code: 'NOT_FOUND' });
    const clean = cleanMeta({ ...existing, ...patch });
    const concept = { ...existing, ...clean, updatedAt: new Date().toISOString() };
    const entries = [];
    if (thumbSha) {
      concept.thumbnail = thumbPath(slug);
      entries.push({ path: concept.thumbnail, mode: '100644', type: 'blob', sha: thumbSha });
    }
    const others = index.concepts.filter((c) => c.slug !== slug);
    const newIndex = { ...index, concepts: [...others, concept] };
    const indexSha = await client.createBlob(utf8Encode(serializeIndex(newIndex)));
    entries.push({ path: INDEX_PATH, mode: '100644', type: 'blob', sha: indexSha });
    return { entries, message: `concept: update details "${concept.name}" (${slug})`, result: { concept, index: newIndex } };
  }, '', onProgress);
}

// Delete a concept folder, its thumbnail, and its index entry.
export async function deleteConcept(client, slug, onProgress = () => {}) {
  return commitWithRetry(client, async ({ head, index }) => {
    const existing = index.concepts.find((c) => c.slug === slug);
    const listing = await client.getTreeRecursive(head.tree);
    if (listing.truncated) throw new GitHubError('Repository tree listing is truncated', { code: 'TRUNCATED' });
    const prefix = `concepts/${slug}/`;
    const entries = listing.tree
      .filter((e) => e.type === 'blob' && e.path.startsWith(prefix))
      .map((e) => ({ path: e.path, mode: e.mode || '100644', type: 'blob', sha: null }));
    const thumb = thumbPath(slug);
    if (listing.tree.some((e) => e.type === 'blob' && e.path === thumb)) {
      entries.push({ path: thumb, mode: '100644', type: 'blob', sha: null });
    }
    if (!existing && !entries.length) throw new GitHubError(`Concept "${slug}" not found`, { status: 404, code: 'NOT_FOUND' });
    const newIndex = { ...index, concepts: index.concepts.filter((c) => c.slug !== slug) };
    const indexSha = await client.createBlob(utf8Encode(serializeIndex(newIndex)));
    entries.push({ path: INDEX_PATH, mode: '100644', type: 'blob', sha: indexSha });
    const name = existing ? existing.name : slug;
    return { entries, message: `concept: delete "${name}" (${slug})`, result: { index: newIndex, removedFiles: entries.length - 1 } };
  }, '', onProgress);
}

// Fetch the deployed build marker ({commit, builtAt}) or null.
export async function fetchDeployedBuild(siteBase, fetchImpl) {
  const f = fetchImpl || ((...args) => globalThis.fetch(...args));
  try {
    const res = await f(`${siteBase}data/build.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Poll until the commit is live on GitHub Pages, the workflow fails, or the timeout elapses.
// Resolves { status: 'success' | 'failed' | 'timeout', runUrl, run, build }.
export async function waitForDeploy({ client, commitSha, siteBase, timeoutMs = 480000, intervalMs = 5000, onProgress = () => {}, fetchImpl, now = () => Date.now() }) {
  const start = now();
  let actionsOk = Boolean(client && client.token);
  let runUrl = null;
  let run = null;
  while (now() - start < timeoutMs) {
    const build = await fetchDeployedBuild(siteBase, fetchImpl);
    if (build && build.commit) {
      if (build.commit === commitSha) return { status: 'success', runUrl, run, build };
      if (client) {
        try {
          const cmp = await client.compare(commitSha, build.commit);
          if (cmp && (cmp.status === 'ahead' || cmp.status === 'identical')) return { status: 'success', runUrl, run, build, superseded: true };
        } catch { /* ignore */ }
      }
    }
    if (actionsOk) {
      try {
        const runs = await client.listRunsForSha(commitSha);
        run = runs && runs.workflow_runs && runs.workflow_runs[0] ? runs.workflow_runs[0] : null;
        if (run) {
          runUrl = run.html_url;
          onProgress({ stage: 'deploy', run });
          if (run.status === 'completed' && run.conclusion && run.conclusion !== 'success') {
            return { status: 'failed', runUrl, run, build };
          }
        } else {
          onProgress({ stage: 'deploy', run: null });
        }
      } catch (e) {
        if (e.status === 403 || e.status === 404) actionsOk = false;
      }
    } else {
      onProgress({ stage: 'deploy', run: null });
    }
    await sleep(intervalMs);
  }
  return { status: 'timeout', runUrl, run };
}
