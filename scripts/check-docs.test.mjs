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
test('public inventory rejects product source before cleared release', () => {
  const failures = validate(new Map([['src/product.ts', 'export {};']]));
  assert.ok(failures.some(x => x.includes('Outside current public inventory: src/product.ts')));
  assert.ok(failures.some(x => x.includes('Required public file missing: README.md')));
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
