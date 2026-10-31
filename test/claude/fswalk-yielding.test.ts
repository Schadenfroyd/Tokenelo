/**
 * The yielding Claude walk must find the same files, in the same order, with the same skip records and reasons, as the
 * synchronous walk. Expected values are written out here, not taken from the synchronous walker, so a shared mutation
 * cannot pass by agreeing with itself.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { walkClaudeRoots, walkClaudeRootsYielding, type WalkPacing } from '../../src/collectors/fswalk.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const AGENT_UUID = '33333333-3333-4333-8333-333333333333';

let tmp: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function touch(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
}

/** One root with a session file, a subagent tree, and every excluded shape the whitelist names. */
function buildTree(): { root: string; missing: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-walk-'));
  const root = path.join(tmp, 'projects');
  const proj = path.join(root, '-proj-a');
  touch(path.join(proj, `${SESSION_A}.jsonl`));
  touch(path.join(proj, `${SESSION_A}.sync-conflict-20260901.jsonl`));
  touch(path.join(proj, 'notes.jsonl'));
  touch(path.join(proj, 'readme.txt'));
  touch(path.join(proj, 'memory', 'vault.jsonl'));
  touch(path.join(proj, '.stversions', 'old.jsonl'));
  touch(path.join(proj, 'some-dir', 'x.jsonl'));
  touch(path.join(proj, SESSION_B, 'tool-results', 'z.jsonl'));
  touch(path.join(proj, SESSION_B, 'subagents', `agent-${AGENT_UUID}.jsonl`));
  touch(path.join(proj, SESSION_B, 'subagents', 'workflows', 'wf_1', 'agent-2.jsonl'));
  touch(path.join(proj, SESSION_B, 'subagents', 'Memory', 'deep.jsonl'));
  touch(path.join(proj, SESSION_B, 'subagents', '.ClAuDe', 'deeper.jsonl'));
  for (const excluded of ['.STversions', '.STfolder']) touch(path.join(proj, SESSION_B, 'subagents', excluded, 'case-alias.jsonl'));
  touch(path.join(proj, SESSION_B, 'subagents', 'agent-3.sync-conflict-1.jsonl'));
  touch(path.join(root, 'stray-at-root.jsonl')); // a file directly under the root is not a project
  for (let i = 0; i < 40; i++) touch(path.join(root, `-proj-bulk-${i}`, `${SESSION_A}.jsonl`));
  return { root, missing: path.join(tmp, 'does-not-exist') };
}

function noPause(): WalkPacing {
  return { due: () => false, yieldNow: async () => {} };
}

function pauseAlways(counter: { yields: number }): WalkPacing {
  return {
    due: () => true,
    yieldNow: async () => {
      counter.yields++;
    },
  };
}

describe('walkClaudeRootsYielding', () => {

  it.each(['sync', 'yielding'] as const)('does not follow a subagents symlink or junction into an outside vault (%s)', async (driver) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linked-subagents-'));
    const root = path.join(tmp, 'projects'), project = path.join(root, '-valid');
    touch(path.join(project, `${SESSION_A}.jsonl`));
    const target = path.join(tmp, 'outside-memory', '.claude', 'projects', '-vault');
    touch(path.join(target, 'agent-private.jsonl'));
    const link = path.join(project, SESSION_A, 'subagents');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const syncReads = vi.spyOn(fs, 'readdirSync'), asyncReads = vi.spyOn(fsp, 'readdir');
    const result = driver === 'sync' ? walkClaudeRoots([root]) : await walkClaudeRootsYielding([root], noPause());
    expect(result.files.map(f => path.relative(root, f.path).split(path.sep).join('/'))).toEqual([`-valid/${SESSION_A}.jsonl`]);
    expect(result.skipped).toEqual([{ path: link, reason: 'not-whitelisted' }]);
    for (const dir of [link, target]) {
      expect(syncReads.mock.calls.some(call => String(call[0]) === dir)).toBe(false);
      expect(asyncReads.mock.calls.some(call => String(call[0]) === dir)).toBe(false);
    }
  });


  it.each(['sync', 'yielding'] as const)('rejects excluded root-level project names before listing them and records root JSONL skips (%s)', async (driver) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-root-boundary-'));
    const root = path.join(tmp, 'projects');
    const forbidden = ['.ClAuDe', '.STversions', '.STfolder'];
    for (const name of [...forbidden, '-valid', 'memory']) touch(path.join(root, name, `${SESSION_A}.jsonl`));
    touch(path.join(root, 'stray-at-root.jsonl'));
    touch(path.join(root, `${SESSION_A}.sync-conflict-1.jsonl`));
    const syncReads = vi.spyOn(fs, 'readdirSync');
    const asyncReads = vi.spyOn(fsp, 'readdir');
    const result = driver === 'sync' ? walkClaudeRoots([root]) : await walkClaudeRootsYielding([root], noPause());
    // Expected paths are independent of both walkers. memory is legal as a project;
    // only the directory beneath a project is the forbidden memory-vault shape.
    expect(result.files.map(f => path.relative(root, f.path).split(path.sep).join('/')).sort()).toEqual([
      `-valid/${SESSION_A}.jsonl`, `memory/${SESSION_A}.jsonl`,
    ]);
    expect(result.skipped.map(s => ({ path: path.relative(root, s.path), reason: s.reason })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '.ClAuDe', reason: 'nested-.claude' },
      { path: '.STfolder', reason: 'syncthing-versions' },
      { path: '.STversions', reason: 'syncthing-versions' },
      { path: `${SESSION_A}.sync-conflict-1.jsonl`, reason: 'sync-conflict' },
      { path: 'stray-at-root.jsonl', reason: 'not-whitelisted' },
    ]);
    for (const excluded of forbidden) {
      const dir = path.join(root, excluded);
      expect(syncReads.mock.calls.some(call => String(call[0]) === dir)).toBe(false);
      expect(asyncReads.mock.calls.some(call => String(call[0]) === dir)).toBe(false);
    }
  });

  it('finds the expected files, in order, and the expected skip reasons', async () => {
    const { root, missing } = buildTree();
    const { files, skipped } = await walkClaudeRootsYielding([root, missing], noPause());

    // Directory read order depends on the filesystem, so compare sorted sets here; the order check is the next test.
    const relative = files.map((f) => path.relative(root, f.path).split(path.sep).join('/')).sort();
    const session = relative.filter((p) => !p.includes('/subagents/'));
    const subagent = relative.filter((p) => p.includes('/subagents/'));
    expect(session).toHaveLength(41);
    expect(session).toContain(`-proj-a/${SESSION_A}.jsonl`);
    expect(subagent).toEqual([
      `-proj-a/${SESSION_B}/subagents/agent-${AGENT_UUID}.jsonl`,
      `-proj-a/${SESSION_B}/subagents/workflows/wf_1/agent-2.jsonl`,
    ]);
    expect(files.filter((f) => f.kind === 'subagent').every((f) => f.parentUuid === SESSION_B)).toBe(true);
    expect(relative.some((p) => p.includes('stray-at-root') || p.includes('readme') || p.includes('tool-results'))).toBe(false);

    const reasons = skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(
      ['memory-vault', 'memory-vault', 'nested-.claude', 'not-whitelisted', 'not-whitelisted', 'not-whitelisted', 'sync-conflict', 'sync-conflict', 'syncthing-versions', 'syncthing-versions', 'syncthing-versions']
    );
  });

  it('gives the same files, order and skip records as the synchronous walk', async () => {
    const { root, missing } = buildTree();
    const sync = walkClaudeRoots([root, missing]);
    const yielding = await walkClaudeRootsYielding([root, missing], pauseAlways({ yields: 0 }));
    expect(yielding).toEqual(sync);
  });

  it('pauses between directory reads when pacing says so, and still returns the same result', async () => {
    const { root, missing } = buildTree();
    const counter = { yields: 0 };
    const paused = await walkClaudeRootsYielding([root, missing], pauseAlways(counter));
    // Directory reads: the root, 41 project directories, and the session/subagent directories below them.
    expect(counter.yields).toBeGreaterThanOrEqual(45);
    expect(paused).toEqual(walkClaudeRoots([root, missing]));
  });

  it('never pauses when pacing does not ask, so a mutant that pauses unconditionally is caught by the count above', async () => {
    const { root } = buildTree();
    const counter = { yields: 0 };
    await walkClaudeRootsYielding([root], { due: () => false, yieldNow: async () => { counter.yields++; } });
    expect(counter.yields).toBe(0);
  });

  // The captured M4 stack has no JS function names; these regressions guard this known synchronous discovery seam.
  it('never lists or stats a directory synchronously, and returns the same result as the synchronous walk', async () => {
    const { root, missing } = buildTree();
    const expected = walkClaudeRoots([root, missing]);
    const readdirSync = vi.spyOn(fs, 'readdirSync');
    const statSync = vi.spyOn(fs, 'statSync');
    const lstatSync = vi.spyOn(fs, 'lstatSync');
    const yielding = await walkClaudeRootsYielding([root, missing], noPause());
    // Only calls into this tree count; the test runner may touch other paths through the same module.
    const inTree = (calls: unknown[][]) => calls.filter((c) => String(c[0]).startsWith(tmp!));
    expect(inTree(readdirSync.mock.calls)).toEqual([]);
    expect(inTree(statSync.mock.calls)).toEqual([]);
    expect(inTree(lstatSync.mock.calls)).toEqual([]);
    expect(yielding).toEqual(expected);
  });

  it('lets other event-loop work run during the walk even when pacing never asks for a pause', async () => {
    const { root } = buildTree();
    let immediateRan = false;
    let ranBeforeWalkEnded = false;
    setImmediate(() => {
      immediateRan = true;
    });
    const walk = walkClaudeRootsYielding([root], noPause()).then((r) => {
      ranBeforeWalkEnded = immediateRan;
      return r;
    });
    await walk;
    // With synchronous reads and no pacing pause, the walk resolved in microtasks before any immediate could run.
    expect(ranBeforeWalkEnded).toBe(true);
  });

});
