import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const lockPath = new URL('package-lock.json', root);
const outputPath = new URL('docs/THIRD_PARTY_NOTICES.md', root);

// package-lock@3 omits this package's license field, while its published
// tarball contains an MIT LICENSE file. Keep overrides narrow and versioned.
const LICENSE_OVERRIDES = new Map([
  ['webgl-constants@1.1.1', 'MIT'],
]);

function packageName(path) {
  const marker = 'node_modules/';
  const offset = path.lastIndexOf(marker);
  return offset === -1 ? null : path.slice(offset + marker.length);
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const inventory = new Map();

for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  const name = packageName(path);
  if (!name || metadata.link || typeof metadata.version !== 'string') continue;
  const identity = `${name}@${metadata.version}`;
  const license = metadata.license ?? LICENSE_OVERRIDES.get(identity) ?? 'UNKNOWN';
  const key = `${identity}\u0000${license}`;
  const existing = inventory.get(key) ?? {
    name,
    version: metadata.version,
    license,
    scopes: new Set(),
  };
  existing.scopes.add(metadata.optional ? 'optional' : metadata.dev ? 'development' : 'runtime');
  inventory.set(key, existing);
}

const rows = [...inventory.values()].sort((left, right) =>
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
);
const unknown = rows.filter((entry) => entry.license === 'UNKNOWN');
if (unknown.length > 0) {
  throw new Error(`Missing license metadata: ${unknown.map((entry) => `${entry.name}@${entry.version}`).join(', ')}`);
}

const body = [
  '# Third-Party Notices',
  '',
  '> Generated from `package-lock.json` by `npm run licenses:generate`. Do not edit manually.',
  '',
  'This inventory identifies the third-party npm packages present in the locked Lumora dependency graph. It is not a replacement for the license text shipped by each package. Release artifacts must retain any license or notice files required by those packages.',
  '',
  `Locked package identities: **${rows.length}**`,
  '',
  '| Package | Version | License | Scope |',
  '| --- | --- | --- | --- |',
  ...rows.map((entry) =>
    `| ${escapeCell(entry.name)} | ${escapeCell(entry.version)} | ${escapeCell(entry.license)} | ${[...entry.scopes].sort().join(', ')} |`,
  ),
  '',
  '## Release Check',
  '',
  '- Regenerate this file after every dependency or lockfile change.',
  '- Treat an `UNKNOWN` license as a release blocker; the generator exits non-zero when one is found.',
  '- Review reciprocal, source-offer, attribution, and notice obligations with the release owner before distribution.',
  '- Preserve package-level `LICENSE`, `NOTICE`, and attribution files in distributed source and binary bundles where required.',
  '',
].join('\n');

await writeFile(fileURLToPath(outputPath), body, 'utf8');
console.log(`Wrote ${fileURLToPath(outputPath)} (${rows.length} package identities).`);
