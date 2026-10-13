import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntime, classifyOrigin, validateRoots } from './cloud-check.mjs';

test('cloud checks require a usable modern Node runtime', () => {
  assert.equal(validateRuntime('22.22.1'), true);
  assert.equal(validateRuntime('24.19.0'), true);
  assert.equal(validateRuntime('20.19.0'), false);
  assert.equal(validateRuntime('not-a-version'), false);
});

test('cloud workflow recognizes public identity without guessing provider proxy origin formats', () => {
  for (const origin of ['https://github.com/Schadenfroyd/Tokenelo.git', 'git@github.com:Schadenfroyd/Tokenelo.git']) {
    assert.equal(classifyOrigin(origin), 'public');
  }
  for (const origin of ['https://github.com/Schadenfroyd/OtherProject.git', 'git@github.com:Schadenfroyd/OtherProject.git']) {
    assert.equal(classifyOrigin(origin), 'other-github');
  }
  assert.equal(classifyOrigin('http://example.org/scoped-git-transport'), 'opaque');
  assert.equal(classifyOrigin('https://github.com.example.org/Schadenfroyd/Tokenelo.git'), 'opaque');
  assert.equal(classifyOrigin(''), 'missing');
});

test('cloud workflow rejects historical roots outside the current public lineage', () => {
  const current = 'f7fa1e89f79bdc3bdd7df9e13195c5c7b5bce6a6';
  assert.equal(validateRoots(`${current}\n`), true);
  assert.equal(validateRoots(''), false);
  assert.equal(validateRoots('0000000000000000000000000000000000000000'), false);
  assert.equal(validateRoots(`${current}\n0000000000000000000000000000000000000000`), false);
});
