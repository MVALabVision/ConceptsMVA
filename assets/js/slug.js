// Slug helpers. Vietnamese-aware: "Trạm PAS HFS VINA" -> "tram-pas-hfs-vina".
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function slugify(input, maxLen = 64) {
  let s = String(input || '')
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/g, '');
  return s;
}

export function isValidSlug(slug) {
  return SLUG_RE.test(String(slug || ''));
}

// Returns `base`, or `base-2`, `base-3`, ... until one is not in `taken`.
export function uniqueSlug(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
