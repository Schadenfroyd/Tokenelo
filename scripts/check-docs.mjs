import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const inventory = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', 'README.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  '.github/CODEOWNERS', '.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/data_discrepancy.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/docs.yml', '.github/workflows/pages.yml', 'assets/tokenelo-banner.svg',
  'docs/data-accuracy.md', 'docs/faq.md', 'docs/licensing.md', 'docs/maintaining.md',
  'docs/privacy.md', 'docs/product.md', 'docs/roadmap.md', 'docs/status.md', 'docs/website.md',
  'docs/trademarks.md', 'scripts/check-docs.mjs', 'scripts/check-docs.test.mjs',
  'CLAUDE.md', '.claude/cloud-setup.sh', '.claude/commands/verify-public.md',
  'docs/claude-cloud.md', 'scripts/cloud-check.mjs', 'scripts/cloud-check.test.mjs',
  'site-gateway/worker.mjs', 'site-gateway/worker.test.mjs', 'site-gateway/wrangler.jsonc',
  'site/favicon.svg', 'site/index.html', 'site/robots.txt', 'site/site.css',
  'site/site.js', 'site/sitemap.xml', 'site/social-card.svg',
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

const websiteHosts = new Set(['github.com', 'eloai.co', 'tokenelo.eloai.co']);

function htmlAttributes(source) {
  const attributes = new Map();
  const pattern = /\s([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    if (!attributes.has(key)) attributes.set(key, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function checkWebsiteLocalReference(from, raw, files, failures) {
  let target;
  try { target = decodeURIComponent(raw.trim()); }
  catch { failures.push('Invalid encoded website link: ' + from + ' -> ' + raw); return; }
  if (/\\/.test(target)) { failures.push('Unsafe website link: ' + from + ' -> ' + raw); return; }

  const hashAt = target.indexOf('#');
  const fragment = hashAt >= 0 ? target.slice(hashAt + 1) : '';
  const beforeFragment = hashAt >= 0 ? target.slice(0, hashAt) : target;
  const queryAt = beforeFragment.indexOf('?');
  const path = queryAt >= 0 ? beforeFragment.slice(0, queryAt) : beforeFragment;
  let destination = path
    ? (path.startsWith('/') ? posix.join('site', path.replace(/^\/+/, '')) : posix.join(posix.dirname(from), path))
    : from;
  if (path.endsWith('/') || destination === 'site') destination = posix.join(destination, 'index.html');
  destination = posix.normalize(destination);
  if (!destination.startsWith('site/')) {
    failures.push('Website link escapes site root: ' + from + ' -> ' + raw);
    return;
  }
  if (!files.has(destination)) {
    failures.push('Missing website asset or page: ' + from + ' -> ' + raw);
    return;
  }
  if (fragment && destination.endsWith('.html') && !anchors(files.get(destination)).has(fragment)) {
    failures.push('Missing website anchor: ' + from + ' -> ' + raw);
  }
}

function checkWebsiteHtml(name, text, files, failures) {
  const tags = text.matchAll(/<([a-z][a-z\d-]*)\b([^>]*)>/gi);
  for (const match of tags) {
    const tagName = match[1].toLowerCase();
    const attributes = htmlAttributes(match[2]);
    if (/\son[a-z]+\s*=/i.test(match[2])) failures.push('Inline event handler in website HTML: ' + name);

    const href = attributes.get('href');
    const src = attributes.get('src');
    for (const value of [href, src].filter(Boolean)) {
      if (/^\s*(?:javascript|vbscript|data):/i.test(value)) {
        failures.push('Unsafe URL scheme in website HTML: ' + name + ' -> ' + value);
        continue;
      }

      if (tagName === 'a' && value === href && /^https:\/\//i.test(value)) {
        let host = '';
        try { host = new URL(value).hostname.toLowerCase(); } catch { /* handled below */ }
        if (!websiteHosts.has(host)) failures.push('Unapproved website outbound link: ' + name + ' -> ' + value);
        continue;
      }
      if (tagName === 'a' && value === href && /^\/\//.test(value)) {
        failures.push('Protocol-relative website link: ' + name + ' -> ' + value);
        continue;
      }

      const canonical = tagName === 'link' && /\bcanonical\b/i.test(attributes.get('rel') ?? '');
      if (/^(?:https?:)?\/\//i.test(value)) {
        if (canonical && value.startsWith('https://')) {
          let host = '';
          try { host = new URL(value).hostname.toLowerCase(); } catch { /* handled below */ }
          if (host !== 'tokenelo.eloai.co') failures.push('Unapproved website canonical URL: ' + name + ' -> ' + value);
        } else {
          failures.push('Remote runtime resource in website HTML: ' + name + ' -> ' + value);
        }
        continue;
      }
      if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
        failures.push('Unsafe website URL scheme: ' + name + ' -> ' + value);
        continue;
      }
      checkWebsiteLocalReference(name, value, files, failures);
    }
    const srcset = attributes.get('srcset');
    if (srcset) {
      for (const candidate of srcset.split(',')) {
        const target = candidate.trim().split(/\s+/, 1)[0];
        if (/^(?:https?:)?\/\//i.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) {
          failures.push('Remote or active image in website HTML: ' + name + ' -> ' + target);
        } else if (target) {
          checkWebsiteLocalReference(name, target, files, failures);
        }
      }
    }
    for (const attribute of ['poster', 'action', 'formaction', 'xlink:href']) {
      const target = attributes.get(attribute);
      if (!target) continue;
      if (/^(?:https?:)?\/\//i.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) {
        failures.push('Remote or active reference in website HTML: ' + name + ' -> ' + target);
      } else {
        checkWebsiteLocalReference(name, target, files, failures);
      }
    }
    const inlineStyle = attributes.get('style');
    if (inlineStyle && /url\(\s*["']?(?:https?:|\/\/|data:|javascript:)/i.test(inlineStyle)) {
      failures.push('Remote or active inline style in website HTML: ' + name);
    }
  }
}

function checkWebsiteAssets(name, text, files, failures) {
  if (name.endsWith('.html')) {
    checkWebsiteHtml(name, text, files, failures);
    return;
  }
  if (name.endsWith('.css')) {
    if (/@import\b/i.test(text)) failures.push('CSS imports are not allowed in the public website: ' + name);
    for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      const target = match[2].trim();
      if (/^(?:https?:)?\/\//i.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target)) {
        failures.push('Remote or active CSS reference in the public website: ' + name + ' -> ' + target);
      } else if (target && !target.startsWith('#')) {
        checkWebsiteLocalReference(name, target, files, failures);
      }
    }
    return;
  }
  if (name.endsWith('.js') && /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon|import\s*\(|importScripts\s*\(|createElement\s*\(\s*['"]script['"]/i.test(text)) {
    failures.push('Network access is not allowed in public website JavaScript: ' + name);
  }
}

export function validate(files, checkInventory = true) {
  const failures = [];
  if (checkInventory) {
    for (const name of inventory) if (!files.has(name)) failures.push(`Required public file missing: ${name}`);
    for (const name of files.keys()) if (!inventory.has(name)) failures.push(`Outside current public inventory: ${name}`);
  }
  for (const [name, text] of files) {
    const websiteFile = /^site\/[^/]+\.(?:html|css|js|svg|txt|xml)$/.test(name);
    const gatewayFile = /^site-gateway\/[^/]+\.(?:mjs|jsonc)$/.test(name);
    if (!/\.(md|svg|yml)$/.test(name) && !websiteFile && !gatewayFile) continue;
    // These guardrails supplement secret scanning and release-scope review.
    if (websiteFile && /\b(?:cryptocurrency|crypto|patent)\b/i.test(text)) failures.push('Restricted internal or patent promotion marker in website content: ' + name);
    if (websiteFile && /\bfarm\b/i.test(text)) failures.push('Farm detail in public website content: ' + name);
    if (websiteFile && /\b[A-Z]:[\\/]|\/Users\/|\/home\/|\/mnt\/|\/Volumes\/|\/tmp\/|\/var\/tmp\//i.test(text)) failures.push('Local path in public website content: ' + name);
    if (websiteFile && name.endsWith('.svg') && /url\(\s*["']?(?:https?:|\/\/|data:|javascript:)/i.test(text)) failures.push('External or active SVG reference: ' + name);
    if (websiteFile) checkWebsiteAssets(name, text, files, failures);
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
