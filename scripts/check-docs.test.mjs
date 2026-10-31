import test from 'node:test';
import assert from 'node:assert/strict';
import { anchors, validate } from './check-docs.mjs';

test('navigation accepts files, anchors, HTML images, and duplicate headings', () => {
  const files = new Map([
    ['README.md', '# Welcome\n[Guide](docs/guide.md#read-the-number-1)\n<img src="assets/banner.svg" alt="Brand">'],
    ['docs/guide.md', '# Guide\n## Read the number\n## Read the number\n[Home](../README.md#welcome)'],
    ['assets/banner.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Brand</title></svg>'],
  ]);
  assert.deepEqual(validate(files, false), []);
});
test('missing file and stale anchor both fail', () => {
  const failures = validate(new Map([['README.md', '# Home\n[Missing](absent.md)\n[Stale](#old-heading)']]), false);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /Missing link/); assert.match(failures[1], /Missing anchor/);
});
test('encoded traversal, disk links, and unsafe schemes fail', () => {
  const failures = validate(new Map([['README.md', '[Escape](%2e%2e/private.md)\n[Disk](file:///private.md)\n[Script](javascript:alert)']]), false);
  assert.equal(failures.length, 3); assert.match(failures[0], /escapes/);
});
test('public inventory accepts the released source tree and still requires its license files', () => {
  const failures = validate(new Map([['src/product.ts', 'export {};']]));
  assert.ok(!failures.some(x => x.includes('Outside current public inventory: src/product.ts')));
  assert.ok(failures.some(x => x.includes('Required public file missing: README.md')));
  for (const name of ['LICENSE', 'NOTICE', 'package.json', 'package-lock.json']) {
    assert.ok(failures.some(x => x.includes(`Required source file missing: ${name}`)), name);
  }
});
test('public inventory rejects files outside the documentation and source scopes', () => {
  const names = ['evidence/run.json', 'internal/notes.md', 'PRIVATE-NOTES.md', '.github/workflows/deploy-private.yml'];
  const failures = validate(new Map(names.map(name => [name, 'x'])));
  for (const name of names) assert.ok(failures.some(x => x.includes(`Outside current public inventory: ${name}`)), name);
});
test('private markers are still rejected inside the source scope', () => {
  const failures = validate(new Map([['docs/third-party/NOTES.md', 'Host: 100.64.0.1'], ['docs/architecture.md', 'See C:\\work\\notes']]), false);
  assert.equal(failures.length, 2);
});
test('links inside fenced blocks are literal text, links outside still fail', () => {
  const fenced = '# Notices\n```text\ncomplied with [Notices](#nowhere), you can keep\n```\n';
  assert.deepEqual(validate(new Map([['docs/third-party/NOTICES.md', fenced]]), false), []);
  assert.equal(validate(new Map([['README.md', fenced + '[Gone](missing.md)']]), false).length, 1);
});
test('private marker, executable SVG, and privileged PR trigger fail', () => {
  const files = new Map([
    ['README.md', 'Host: 10.0.0.1'],
    ['assets/banner.svg', '<svg><script>alert(1)</script></svg>'],
    ['.github/workflows/docs.yml', 'on: pull_request_target'],
  ]);
  assert.equal(validate(files, false).length, 3);
});
test('malformed encoding fails and fenced sample headings are ignored', () => {
  assert.equal(validate(new Map([['README.md', '[Bad](%zz)']]), false).length, 1);
  assert.deepEqual([...anchors('# Real\n```md\n# Sample\n```\n## Next')], ['real', 'next']);
});

test('website accepts base-root and relative assets, local anchors, and approved destinations', () => {
  const files = new Map([
    ['site/index.html', '<link rel="canonical" href="https://tokenelo.eloai.co/"><link rel="stylesheet" href="./site.css"><link rel="icon" href="/favicon.svg"><script src="/site.js"></script><main id="main"></main><a href="#main">Top</a><a href="https://github.com/Schadenfroyd/Tokenelo">GitHub</a><a href="https://eloai.co">Elo AI</a>'],
    ['site/site.css', 'body { color: navy; }'],
    ['site/site.js', 'void 0;'],
    ['site/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ]);
  assert.deepEqual(validate(files, false), []);
});

test('website private paths and restricted promotion markers fail', () => {
  const marker = 'cryptocurrency';
  const farm = 'f' + 'arm';
  const files = new Map([['site/index.html', '<p>C:\\private\\example ' + farm + ' ' + marker + '</p>']]);
  const failures = validate(files, false);
  assert.ok(failures.some(x => x.includes('Private marker in public content: site/index.html')));
  assert.ok(failures.some(x => x.includes('Farm detail in public website content: site/index.html')));
  assert.ok(failures.some(x => x.includes('Local path in public website content: site/index.html')));
  assert.ok(failures.some(x => x.includes('Restricted internal or patent promotion marker in website content: site/index.html')));
});

test('website missing local assets and anchors fail', () => {
  const files = new Map([['site/index.html', '<link rel="stylesheet" href="./missing.css"><main id="main"><a href="#absent">Open</a></main>']]);
  const failures = validate(files, false);
  assert.ok(failures.some(x => x.includes('Missing website asset or page: site/index.html -> ./missing.css')));
  assert.ok(failures.some(x => x.includes('Missing website anchor: site/index.html -> #absent')));
});

test('website rejects unsafe scripts, images, fonts, links, and network calls', () => {
  const files = new Map([
    ['site/index.html', '<script src="https://cdn.example.test/app.js"></script><img src="https://cdn.example.test/pixel.png"><a href="javascript:alert(1)">bad</a><a href="https://other.example.test/">outside</a>'],
    ['site/site.css', '@font-face { src: url(https://fonts.example.test/font.woff2); }'],
    ['site/site.js', 'fetch("/collect");'],
  ]);
  const failures = validate(files, false);
  assert.ok(failures.some(x => x.includes('Remote runtime resource in website HTML')));
  assert.ok(failures.some(x => x.includes('Unsafe URL scheme in website HTML')));
  assert.ok(failures.some(x => x.includes('Unapproved website outbound link')));
  assert.ok(failures.some(x => x.includes('Remote or active CSS reference')));
  assert.ok(failures.some(x => x.includes('Network access is not allowed')));
});
