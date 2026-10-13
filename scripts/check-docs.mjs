import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const inventory = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', 'README.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  '.github/CODEOWNERS', '.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/data_discrepancy.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/docs.yml', 'assets/tokenelo-banner.svg',
  'docs/data-accuracy.md', 'docs/faq.md', 'docs/licensing.md', 'docs/maintaining.md',
  'docs/privacy.md', 'docs/product.md', 'docs/roadmap.md', 'docs/status.md',
  'docs/trademarks.md', 'scripts/check-docs.mjs', 'scripts/check-docs.test.mjs',
]);

export function anchors(text) {
  const ids = new Set(); const counts = new Map();
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].toLowerCase().replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0; counts.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

export function validate(files, checkInventory = true) {
  const failures = [];
  if (checkInventory) {
    for (const name of inventory) if (!files.has(name)) failures.push(`Required public file missing: ${name}`);
    for (const name of files.keys()) if (!inventory.has(name)) failures.push(`Outside current public inventory: ${name}`);
  }
  for (const [name, text] of files) {
    if (!/\.(md|svg|yml)$/.test(name)) continue;
    // These guardrails supplement secret scanning and release-scope review.
    if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|100\.64\.|10\.0\.0\.|\bC:[\\/]|\/Users\/|\/home\/elo\b|ryzen_ops|eloadmin|BridgeFirelight/i.test(text)) failures.push(`Private marker in public content: ${name}`);
    if (name.endsWith('.svg') && /<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)=["'](?:https?:|data:|javascript:|\/\/)/i.test(text)) failures.push(`Unsafe SVG content: ${name}`);
    if (name.endsWith('.yml') && /pull_request_target/.test(text)) failures.push(`Privileged PR trigger: ${name}`);
    if (!name.endsWith('.md')) continue;
    const targets = [
      ...Array.from(text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g), m => m[1]),
      ...Array.from(text.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g), m => m[1]),
    ];
    for (const raw of targets) {
      let target;
      try { target = decodeURIComponent(raw.replace(/^<|>$/g, '')); }
      catch { failures.push(`Invalid encoded link: ${name} -> ${raw}`); continue; }
      if (/^(https:|mailto:)/i.test(target)) continue;
      if (/^[a-z][a-z\d+.-]*:|^\/|\\/i.test(target)) { failures.push(`Unsafe local link: ${name} -> ${raw}`); continue; }
      const [path, fragment] = target.split('#');
      const destination = path ? posix.normalize(posix.join(posix.dirname(name), path)) : name;
      if (destination === '..' || destination.startsWith('../')) { failures.push(`Link escapes repository: ${name} -> ${raw}`); continue; }
      if (!files.has(destination)) { failures.push(`Missing link: ${name} -> ${raw}`); continue; }
      if (fragment && destination.endsWith('.md') && !anchors(files.get(destination)).has(fragment)) failures.push(`Missing anchor: ${name} -> ${raw}`);
    }
  }
  return failures;
}

export function readRepository(root) {
  const files = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Public symlink is not allowed: ${relative(root, path)}`);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
    }
  }
  walk(root); return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = readRepository(resolve('.')); const errors = validate(files);
  if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
  else console.log(`Checked public inventory, local links, anchors, and content guardrails in ${files.size} files.`);
}
