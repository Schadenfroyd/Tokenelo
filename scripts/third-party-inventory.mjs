#!/usr/bin/env node
// Third-party inventory, candidate notices and CycloneDX SBOM generator. No dependencies.
//
//   node scripts/third-party-inventory.mjs --write [--online]   regenerate docs/third-party/*
//   node scripts/third-party-inventory.mjs --check              offline: verify the committed files
//
// Sources, in priority order, for each package in package-lock.json:
//   1. the installed copy under node_modules (license field + license/notice files),
//   2. the previously committed inventory.json (so a platform that cannot install another
//      platform's optional binaries does not lose their data),
//   3. with --online, the npm registry's metadata document for that exact name@version.
// Output is deterministic: no timestamps, sorted by lockfile path, LF line endings.
//
// This describes the DEVELOPMENT dependency tree. What a release ships is a separate question
// (see docs/third-party/README.md). It is an engineering inventory, not legal advice or a
// license grant.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'third-party');
const files = {
  inventory: path.join(outDir, 'inventory.json'),
  sbom: path.join(outDir, 'sbom.cdx.json'),
  markdown: path.join(outDir, 'INVENTORY.md'),
  notices: path.join(outDir, 'THIRD-PARTY-NOTICES.md'),
};
const GENERATOR_VERSION = 1;
const MAX_EMBEDDED_TEXT_BYTES = 64 * 1024;
const LICENSE_FILE = /^(licen[cs]e|copying|unlicense|notice|third[-_ ]?party[-_ ]?notice)/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const normalizeText = (bytes) => bytes.toString('utf8').replace(/\r\n?/g, '\n').replace(/^﻿/, '').trimEnd() + '\n';

// ── license classification ──────────────────────────────────────────────────
const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0',
  'Unlicense', 'CC0-1.0', 'Python-2.0', 'Zlib', 'CC-BY-4.0',
]);
const WEAK_COPYLEFT = /^(MPL-|LGPL-|EPL-|CDDL-|CPL-|EUPL-|OSL-)/;
const STRONG_COPYLEFT = /^(GPL-|AGPL-|SSPL-|CC-BY-SA-|CC-BY-NC)/;
const RANK = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];

function classifyId(id) {
  const bare = id.replace(/\+$/, '');
  if (PERMISSIVE.has(bare)) return 0;
  if (WEAK_COPYLEFT.test(bare)) return 1;
  if (STRONG_COPYLEFT.test(bare)) return 2;
  return 3;
}

/** Evaluate an SPDX expression: OR lets the licensee pick the least restrictive, AND takes the most. */
export function classifyExpression(expression) {
  if (!expression) return { ids: [], rank: 3, class: 'unknown' };
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+-]+/g) ?? [];
  const ids = [];
  let at = 0;
  const parseOr = () => {
    let rank = parseAnd();
    while (tokens[at] === 'OR') { at++; rank = Math.min(rank, parseAnd()); }
    return rank;
  };
  const parseAnd = () => {
    let rank = parseAtom();
    while (tokens[at] === 'AND') { at++; rank = Math.max(rank, parseAtom()); }
    return rank;
  };
  const parseAtom = () => {
    const token = tokens[at++];
    if (token === '(') { const rank = parseOr(); at++; return rank; }
    if (token === undefined) return 3;
    ids.push(token);
    let rank = classifyId(token);
    if (tokens[at] === 'WITH') { at += 2; rank = Math.max(rank, 1); }
    return rank;
  };
  const rank = parseOr();
  return { ids: [...new Set(ids)].sort(), rank, class: RANK[rank] };
}

// ── gathering ───────────────────────────────────────────────────────────────
const nameFromPath = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

function readLicenseField(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return `(${pkg.licenses.map((l) => l.type ?? l).join(' OR ')})`;
  return null;
}
const repoUrl = (pkg) => (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null);

function readInstalled(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const licenseFiles = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => {
      const bytes = readFileSync(path.join(dir, f));
      return { file: f, bytes: bytes.length, sha256: sha256(bytes), textSha256: sha256(normalizeText(bytes)) };
    });
  return { license: readLicenseField(pkg), homepage: pkg.homepage ?? null, repository: repoUrl(pkg), licenseFiles };
}

async function readRegistry(name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.ok) {
        const pkg = await response.json();
        return { license: readLicenseField(pkg), homepage: pkg.homepage ?? null, repository: repoUrl(pkg), licenseFiles: [] };
      }
    } catch { /* retry */ }
  }
  return null;
}

function loadPrevious() {
  if (!existsSync(files.inventory)) return new Map();
  const previous = JSON.parse(readFileSync(files.inventory, 'utf8'));
  return new Map(previous.packages.map((p) => [`${p.path}@${p.version}`, p]));
}

async function gather({ online }) {
  const lockBytes = readFileSync(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const previous = loadPrevious();
  const entries = Object.entries(lock.packages).filter(([key]) => key !== '').sort(([a], [b]) => (a < b ? -1 : 1));
  const packages = [];
  const pending = [];
  for (const [key, entry] of entries) {
    const name = nameFromPath(key);
    const old = previous.get(`${key}@${entry.version}`);
    const installed = readInstalled(path.join(root, key));
    const fresh = installed ?? null;
    packages.push({
      name, version: entry.version, path: key,
      resolved: entry.resolved ?? null, integrity: entry.integrity ?? null,
      dev: Boolean(entry.dev), optional: Boolean(entry.optional), peer: Boolean(entry.peer),
      os: entry.os ?? null, cpu: entry.cpu ?? null,
      license: fresh?.license ?? old?.license ?? null,
      licenseSource: fresh?.license ? 'installed-package' : old?.license ? old.licenseSource : 'unresolved',
      homepage: fresh?.homepage ?? old?.homepage ?? null,
      repository: fresh?.repository ?? old?.repository ?? null,
      licenseFiles: fresh && fresh.licenseFiles.length ? fresh.licenseFiles : old?.licenseFiles ?? [],
      dependsOn: Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies }).sort(),
    });
    if (!packages.at(-1).license) pending.push(packages.at(-1));
  }
  if (online && pending.length) {
    const queue = [...pending];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const meta = await readRegistry(item.name, item.version);
        if (meta?.license) Object.assign(item, { license: meta.license, licenseSource: 'npm-registry-metadata', homepage: item.homepage ?? meta.homepage, repository: item.repository ?? meta.repository });
      }
    }));
  }
  for (const p of packages) Object.assign(p, { licenseClass: classifyExpression(p.license).class });
  return { lockBytes, lock, rootPkg, packages };
}

// ── resolution of dependency edges the way Node does (nearest node_modules up the tree) ─────────
function resolveDependency(fromKey, depName, byPath) {
  for (let base = fromKey; ; base = base.slice(0, base.lastIndexOf('node_modules/') - 1)) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${depName}`.replace(/^\//, '');
    if (byPath.has(candidate)) return candidate;
    if (!base.includes('node_modules/')) break;
  }
  return byPath.has(`node_modules/${depName}`) ? `node_modules/${depName}` : null;
}

// ── builders ────────────────────────────────────────────────────────────────
const purl = (p) => `pkg:npm/${p.name.startsWith('@') ? `%40${p.name.slice(1)}` : p.name}@${p.version}`;

function buildInventory(data) {
  const { lockBytes, lock, rootPkg, packages } = data;
  const byClass = {};
  for (const p of packages) byClass[p.licenseClass] = (byClass[p.licenseClass] ?? 0) + 1;
  const byLicense = {};
  for (const p of packages) byLicense[p.license ?? '(unresolved)'] = (byLicense[p.license ?? '(unresolved)'] ?? 0) + 1;
  return {
    schema: 1,
    generator: { script: 'scripts/third-party-inventory.mjs', version: GENERATOR_VERSION },
    scope: 'Development dependency tree from package-lock.json. Says nothing by itself about what a release ships.',
    project: {
      name: rootPkg.name, version: rootPkg.version,
      license: rootPkg.license ?? null,
      note: 'No project license has been granted; Apache-2.0 is a plan gated by counsel clearance.',
      declaredRuntimeDependencies: Object.keys(rootPkg.dependencies ?? {}).sort(),
      declaredDevDependencies: Object.keys(rootPkg.devDependencies ?? {}).sort(),
    },
    lockfile: { path: 'package-lock.json', sha256: sha256(lockBytes), lockfileVersion: lock.lockfileVersion, packageCount: packages.length },
    summary: { byClass: sortObject(byClass), byLicense: sortObject(byLicense) },
    packages,
  };
}
const sortObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

function buildSbom(inventory) {
  const { packages, project, lockfile } = inventory;
  const byPath = new Map(packages.map((p) => [p.path, p]));
  const uuidSeed = lockfile.sha256;
  const serial = `urn:uuid:${uuidSeed.slice(0, 8)}-${uuidSeed.slice(8, 12)}-5${uuidSeed.slice(13, 16)}-a${uuidSeed.slice(17, 20)}-${uuidSeed.slice(20, 32)}`;
  const rootRef = `pkg:npm/${project.name}@${project.version}`;
  const hashOf = (integrity) => {
    const m = /(?:^|\s)sha512-([A-Za-z0-9+/=]+)/.exec(integrity ?? '');
    return m ? [{ alg: 'SHA-512', content: Buffer.from(m[1], 'base64').toString('hex') }] : undefined;
  };
  const components = packages.map((p) => {
    const refs = [{ type: 'distribution', url: p.resolved }];
    if (p.homepage) refs.push({ type: 'website', url: p.homepage });
    if (p.repository) refs.push({ type: 'vcs', url: p.repository });
    const properties = [{ name: 'cdx:npm:package:path', value: p.path }];
    if (p.dev) properties.push({ name: 'cdx:npm:package:development', value: 'true' });
    if (p.optional) properties.push({ name: 'cdx:npm:package:optional', value: 'true' });
    if (p.os) properties.push({ name: 'tokenelo:os', value: p.os.join(',') });
    if (p.cpu) properties.push({ name: 'tokenelo:cpu', value: p.cpu.join(',') });
    return stripUndefined({
      type: 'library', 'bom-ref': `${purl(p)}#${p.path}`, name: p.name, version: p.version, scope: 'optional',
      hashes: hashOf(p.integrity), licenses: p.license ? [{ expression: p.license }] : undefined,
      purl: purl(p), externalReferences: refs, properties,
    });
  });
  const refOf = (p) => `${purl(p)}#${p.path}`;
  const dependencies = [
    { ref: rootRef, dependsOn: project.declaredDevDependencies.map((n) => byPath.get(`node_modules/${n}`)).filter(Boolean).map(refOf).sort() },
    ...packages.map((p) => ({
      ref: refOf(p),
      dependsOn: [...new Set(p.dependsOn.map((n) => resolveDependency(p.path, n, byPath)).filter(Boolean).map((k) => refOf(byPath.get(k))))].sort(),
    })),
  ];
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: serial, version: 1,
    metadata: {
      tools: { components: [{ type: 'application', name: 'third-party-inventory.mjs', version: String(GENERATOR_VERSION) }] },
      component: { type: 'application', 'bom-ref': rootRef, name: project.name, version: project.version },
      properties: [
        { name: 'tokenelo:lockfile-sha256', value: lockfile.sha256 },
        { name: 'tokenelo:scope', value: 'Development dependency tree only; see docs/third-party/README.md for what a release ships.' },
      ],
    },
    components, dependencies,
  };
}
const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

function buildMarkdown(inventory) {
  const { packages, summary, lockfile, project } = inventory;
  const lines = [];
  lines.push('# Third-party dependency inventory', '');
  lines.push('> Generated by `scripts/third-party-inventory.mjs`; do not edit by hand. Analysis and open questions are in [README.md](README.md).', '');
  lines.push(`- Project: \`${project.name}@${project.version}\` — project license: **${project.license ?? 'none granted (counsel-gated)'}**`);
  lines.push(`- Lockfile: \`${lockfile.path}\` (lockfileVersion ${lockfile.lockfileVersion}), sha256 \`${lockfile.sha256}\``);
  lines.push(`- Packages: **${lockfile.packageCount}**; declared runtime dependencies: **${project.declaredRuntimeDependencies.length}**; declared dev dependencies: ${project.declaredDevDependencies.map((n) => `\`${n}\``).join(', ')}`, '');
  lines.push('## License classes', '', '| Class | Packages |', '| --- | ---: |');
  for (const [k, v] of Object.entries(summary.byClass)) lines.push(`| ${k} | ${v} |`);
  lines.push('', '## Licenses', '', '| SPDX expression | Packages |', '| --- | ---: |');
  for (const [k, v] of Object.entries(summary.byLicense)) lines.push(`| ${cell(k)} | ${v} |`);
  const watch = packages.filter((p) => p.licenseClass !== 'permissive');
  lines.push('', '## Not plainly permissive', '');
  if (!watch.length) lines.push('None.');
  else { lines.push('| Package | Version | License | Class | Dev | Optional |', '| --- | --- | --- | --- | --- | --- |'); for (const p of watch) lines.push(`| ${cell(p.name)} | ${p.version} | ${cell(p.license)} | ${p.licenseClass} | ${p.dev ? 'yes' : 'no'} | ${p.optional ? 'yes' : 'no'} |`); }
  const dupes = Object.entries(packages.reduce((m, p) => ((m[p.name] ??= []).push(p), m), {})).filter(([, v]) => v.length > 1);
  lines.push('', '## Same package at more than one version', '');
  if (!dupes.length) lines.push('None.'); else for (const [n, v] of dupes) lines.push(`- \`${n}\`: ${v.map((p) => `${p.version} (\`${p.path}\`)`).join(', ')}`);
  lines.push('', '## All packages', '', '| Package | Version | License | Class | Dev | Optional | Platform | License data from | License files |', '| --- | --- | --- | --- | --- | --- | --- | --- | ---: |');
  for (const p of packages) {
    const platform = p.os || p.cpu ? `${(p.os ?? ['any']).join(',')}/${(p.cpu ?? ['any']).join(',')}` : 'any';
    lines.push(`| ${cell(p.name)} | ${p.version} | ${cell(p.license ?? '(unresolved)')} | ${p.licenseClass} | ${p.dev ? 'yes' : 'no'} | ${p.optional ? 'yes' : 'no'} | ${platform} | ${p.licenseSource} | ${p.licenseFiles.length} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildNotices(inventory, readText) {
  const groups = new Map();
  const missing = [];
  const oversized = [];
  for (const p of inventory.packages) {
    if (!p.licenseFiles.length) { missing.push(p); continue; }
    for (const f of p.licenseFiles) {
      if (f.bytes > MAX_EMBEDDED_TEXT_BYTES) { oversized.push({ p, f }); continue; }
      const group = groups.get(f.textSha256) ?? { textSha256: f.textSha256, users: [], file: f.file, rawSha256: f.sha256 };
      group.users.push(`${p.name}@${p.version}`);
      groups.set(f.textSha256, group);
    }
  }
  const lines = ['# Third-party notices (candidate)', ''];
  lines.push('> **Candidate only.** Generated by `scripts/third-party-inventory.mjs` from the *development* dependency tree. None of these packages is bundled into the compiled product today (see [README.md](README.md)), so this file is not a release notice and has not been reviewed by counsel. License texts are those found in each installed package; identical texts are shown once.', '');
  const sorted = [...groups.values()].sort((a, b) => (a.users[0] < b.users[0] ? -1 : a.users[0] > b.users[0] ? 1 : 0));
  for (const g of sorted) {
    const users = [...new Set(g.users)].sort();
    lines.push(`## ${users.join(', ')}`, '', `Source file \`${g.file}\` (normalized text sha256 \`${g.textSha256}\`).`, '', '```text', readText(g).trimEnd(), '```', '');
  }
  if (oversized.length) { lines.push('## Notice files too large to embed', ''); for (const { p, f } of oversized) lines.push(`- \`${p.name}@${p.version}\`: \`${f.file}\`, ${f.bytes} bytes, sha256 \`${f.sha256}\``); lines.push(''); }
  const noText = missing.map((p) => `${p.name}@${p.version}`);
  if (noText.length) {
    lines.push('## Packages whose license text was not collected', '', 'These are platform-specific binary packages that cannot be installed on the machine that generated this file. Their license is taken from the npm registry metadata field and matches the sibling packages of the same family that were collected; the texts were not read from the published tarballs.', '');
    for (const n of noText.sort()) lines.push(`- \`${n}\``);
    lines.push('');
  }
  return lines.join('\n');
}

// ── commands ────────────────────────────────────────────────────────────────
function resolveText(inventory) {
  const byHash = new Map();
  for (const p of inventory.packages) for (const f of p.licenseFiles) if (!byHash.has(f.textSha256)) byHash.set(f.textSha256, { dir: path.join(root, p.path), file: f.file });
  return (group) => {
    const source = byHash.get(group.textSha256);
    const full = source && path.join(source.dir, source.file);
    if (!full || !existsSync(full)) throw new Error(`License text for ${group.users[0]} is not available locally; run on a machine with node_modules installed.`);
    return normalizeText(readFileSync(full));
  };
}

async function write({ online }) {
  const data = await gather({ online });
  const inventory = buildInventory(data);
  const notices = buildNotices(inventory, resolveText(inventory));
  inventory.outputs = { noticesSha256: sha256(notices), sbomSha256: sha256(json(buildSbom(inventory))), markdownSha256: sha256(buildMarkdown(inventory)) };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(files.inventory, json(inventory));
  writeFileSync(files.sbom, json(buildSbom(inventory)));
  writeFileSync(files.markdown, buildMarkdown(inventory));
  writeFileSync(files.notices, notices);
  const unresolved = inventory.packages.filter((p) => !p.license).length;
  console.log(`Wrote ${inventory.packages.length} packages to docs/third-party (unresolved licenses: ${unresolved}).`);
  if (unresolved) console.log('Re-run with --online to fill license metadata from the npm registry.');
}

function check() {
  const failures = [];
  const warnings = [];
  for (const f of Object.values(files)) if (!existsSync(f)) failures.push(`Missing ${path.relative(root, f)}`);
  if (failures.length) return { failures, warnings };
  const committed = JSON.parse(readFileSync(files.inventory, 'utf8'));
  const lockBytes = readFileSync(path.join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (committed.schema !== 1) failures.push(`Unknown inventory schema ${committed.schema}`);
  if (committed.lockfile.sha256 !== sha256(lockBytes)) failures.push('package-lock.json changed since the inventory was generated; run with --write.');
  const locked = new Map(Object.entries(lock.packages).filter(([k]) => k).map(([k, e]) => [k, e]));
  const listed = new Map(committed.packages.map((p) => [p.path, p]));
  for (const [k, e] of locked) {
    const p = listed.get(k);
    if (!p) failures.push(`Not in inventory: ${k}`);
    else if (p.version !== e.version || p.integrity !== (e.integrity ?? null)) failures.push(`Version or integrity differs from the lockfile: ${k}`);
  }
  for (const k of listed.keys()) if (!locked.has(k)) failures.push(`In inventory but not in the lockfile: ${k}`);
  for (const p of committed.packages) {
    if (!p.license) failures.push(`No license resolved: ${p.name}@${p.version}`);
    else {
      const verdict = classifyExpression(p.license);
      if (verdict.class !== p.licenseClass) failures.push(`Stale license class for ${p.name}@${p.version}`);
      if (verdict.rank >= 2) failures.push(`Strong-copyleft or unknown license: ${p.name}@${p.version} (${p.license})`);
      if (verdict.rank === 1) warnings.push(`Weak copyleft: ${p.name}@${p.version} (${p.license}) — fine for development-only use; review before redistributing.`);
    }
    if (!p.resolved?.startsWith('https://registry.npmjs.org/')) failures.push(`Not resolved from the npm registry: ${p.name}@${p.version}`);
    if (!/^sha512-/.test(p.integrity ?? '')) failures.push(`No sha512 integrity: ${p.name}@${p.version}`);
  }
  const derivedSbom = json(buildSbom(committed));
  if (derivedSbom !== readFileSync(files.sbom, 'utf8')) failures.push('sbom.cdx.json does not match the inventory; run with --write.');
  if (buildMarkdown(committed) !== readFileSync(files.markdown, 'utf8')) failures.push('INVENTORY.md does not match the inventory; run with --write.');
  if (sha256(readFileSync(files.notices)) !== committed.outputs?.noticesSha256) failures.push('THIRD-PARTY-NOTICES.md does not match the inventory; run with --write.');
  return { failures, warnings, count: committed.packages.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--write')) await write({ online: args.has('--online') });
  else if (args.has('--check')) {
    const { failures, warnings, count } = check();
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (failures.length) { for (const f of failures) console.error(f); process.exitCode = 1; }
    else console.log(`Third-party inventory is consistent with package-lock.json (${count} packages).`);
  } else { console.error('Usage: node scripts/third-party-inventory.mjs --write [--online] | --check'); process.exitCode = 2; }
}
