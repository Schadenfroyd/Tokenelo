import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
const root = resolve('.');
const paths = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (extname(path) === '.md') paths.push(path);
  }
}
walk(root);
let failures = 0;
for (const path of paths) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(path), decodeURIComponent(target));
    if (!resolved.startsWith(root + '/') && !resolved.startsWith(root + '\\')) {
      console.error(`Link escapes repository: ${relative(root, path)} -> ${target}`); failures++; continue;
    }
    try { readFileSync(resolved); } catch { console.error(`Missing link: ${relative(root, path)} -> ${target}`); failures++; }
  }
}
if (failures) process.exit(1);
console.log(`Checked local links in ${paths.length} Markdown files.`);
