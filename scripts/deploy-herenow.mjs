#!/usr/bin/env node
/**
 * Publishes ./dist to here.now (https://here.now/docs) in three calls: create, upload, finalize.
 *
 * - With HERENOW_API_KEY set, the site is permanent and owned by that account.
 *   Without it, the site is anonymous and expires after 24 hours (fine for smoke tests).
 * - With HERENOW_SLUG set, the existing site is updated in place, so its URL stays the same.
 *
 * Usage: npm run build && node scripts/deploy-herenow.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const DIST = 'dist';
const API = 'https://here.now/api/v1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

function headers() {
  const h = { 'X-HereNow-Client': 'claude-code/deploy-script', 'content-type': 'application/json' };
  if (process.env.HERENOW_API_KEY) h.Authorization = `Bearer ${process.env.HERENOW_API_KEY}`;
  return h;
}

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: headers(), body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const paths = await listFiles(DIST);
const files = await Promise.all(
  paths.map(async (p) => ({
    path: relative(DIST, p).split('\\').join('/'),
    size: (await stat(p)).size,
    contentType: TYPES[extname(p)] ?? 'application/octet-stream',
    local: p,
  })),
);
const manifest = { files: files.map(({ path, size, contentType }) => ({ path, size, contentType })) };

const slug = process.env.HERENOW_SLUG;
const created = slug ? await call('PUT', `${API}/publish/${slug}`, manifest) : await call('POST', `${API}/publish`, manifest);
const upload = created.upload;
for (const u of upload.uploads) {
  const file = files.find((f) => f.path === u.path);
  if (!file) throw new Error(`Upload slot for unknown file ${u.path}`);
  const res = await fetch(u.url, {
    method: u.method ?? 'PUT',
    headers: u.headers ?? { 'Content-Type': file.contentType },
    body: await readFile(file.local),
  });
  if (!res.ok) throw new Error(`Upload of ${u.path} failed: ${res.status}`);
}
const finalized = await call('POST', `${API}/publish/${created.slug}/finalize`, { versionId: upload.versionId });
console.log(JSON.stringify({ siteUrl: finalized.siteUrl, slug: created.slug, claimUrl: created.claimUrl ?? finalized.claimUrl, warnings: finalized.warnings }, null, 2));
