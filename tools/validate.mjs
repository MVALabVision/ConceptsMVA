#!/usr/bin/env node
// Validates data/concepts.json against the concepts/ folder. Used by the deploy workflow
// and runnable locally: `node tools/validate.mjs`. Exits 1 on errors.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const errors = [];
const warnings = [];

const indexPath = join(root, 'data', 'concepts.json');
let index = { version: 1, concepts: [] };
if (!existsSync(indexPath)) {
  warnings.push('data/concepts.json not found — the library will be empty.');
} else {
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    errors.push(`data/concepts.json is not valid JSON: ${e.message}`);
  }
}
if (!index || !Array.isArray(index.concepts)) {
  errors.push('data/concepts.json must contain a "concepts" array.');
  index = { concepts: [] };
}

const seen = new Set();
for (const c of index.concepts) {
  const label = c && c.slug ? c.slug : JSON.stringify(c);
  if (!c || typeof c !== 'object') { errors.push(`Invalid concept entry: ${label}`); continue; }
  if (!SLUG_RE.test(String(c.slug || ''))) errors.push(`Invalid slug: ${label}`);
  if (seen.has(c.slug)) errors.push(`Duplicate slug: ${c.slug}`);
  seen.add(c.slug);
  if (!c.name || !String(c.name).trim()) errors.push(`Concept "${label}" has no name.`);
  if (c.status && !['published', 'archived'].includes(c.status)) errors.push(`Concept "${label}" has unknown status "${c.status}".`);
  const entry = String(c.entry || 'index.html');
  if (entry.startsWith('/') || entry.split('/').some((s) => s === '..' || s === '')) {
    errors.push(`Concept "${label}" has an unsafe entry path "${entry}".`);
  } else if (!existsSync(join(root, 'concepts', String(c.slug), entry))) {
    errors.push(`Missing entry file: concepts/${c.slug}/${entry}`);
  }
  if (c.thumbnail && !existsSync(join(root, String(c.thumbnail)))) warnings.push(`Thumbnail not found: ${c.thumbnail} (concept "${label}")`);
}

const conceptsDir = join(root, 'concepts');
if (existsSync(conceptsDir)) {
  for (const name of readdirSync(conceptsDir)) {
    const full = join(conceptsDir, name);
    if (!statSync(full).isDirectory()) continue;
    if (!seen.has(name)) warnings.push(`Folder concepts/${name}/ is not listed in data/concepts.json (deployed, but hidden from the library).`);
  }
}

for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${index.concepts.length} concept(s) in index, ${errors.length} error(s), ${warnings.length} warning(s).`);
process.exit(errors.length ? 1 : 0);
