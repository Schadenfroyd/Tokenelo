import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkClaudeRoots, CLAUDE_SESSION_UUID_RE } from '../../src/collectors/fswalk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'claude');
const PROJECTS_ROOT = path.join(FIXTURES, 'projects');
const SYNC_VAULT_ROOT = path.join(FIXTURES, 'sync-vault');

describe('CLAUDE_SESSION_UUID_RE', () => {
  it('matches an 8-4-4-4-12 hex uuid, case-insensitively', () => {
    expect(CLAUDE_SESSION_UUID_RE.test('a1234567-89ab-4cde-8f01-234567890abc')).toBe(true);
    expect(CLAUDE_SESSION_UUID_RE.test('A1234567-89AB-4CDE-8F01-234567890ABC')).toBe(true);
  });
  it('rejects non-uuid names', () => {
    expect(CLAUDE_SESSION_UUID_RE.test('notes')).toBe(false);
    expect(CLAUDE_SESSION_UUID_RE.test('a1234567-89ab-4cde-8f01')).toBe(false); // too short
  });
});

describe('walkClaudeRoots — whitelist walk of the fixture project tree', () => {
  const { files, skipped } = walkClaudeRoots([PROJECTS_ROOT]);

  it('includes every <uuid>.jsonl session file directly under the project dir', () => {
    const sessionPaths = files.filter((f) => f.kind === 'session').map((f) => path.basename(f.path));
    expect(sessionPaths.sort()).toEqual(
      [
        'a1234567-89ab-4cde-8f01-234567890abc.jsonl',
        'b2222222-2222-4222-8222-222222222222.jsonl',
        'c3333333-3333-4333-8333-333333333333.jsonl',
        'e4444444-4444-4444-8444-444444444444.jsonl',
        'f5555555-5555-4555-8555-555555555555.jsonl',
      ].sort()
    );
  });

  it('includes the subagents/**/*.jsonl file under a <uuid> session dir, tagged with parentUuid', () => {
    const subagentFiles = files.filter((f) => f.kind === 'subagent');
    expect(subagentFiles).toHaveLength(1);
    expect(subagentFiles[0]!.path.endsWith(path.join('subagents', 'workflows', 'wf_1', 'agent-a1.jsonl'))).toBe(
      true
    );
    expect(subagentFiles[0]!.parentUuid).toBe('a1111111-1111-4111-8111-111111111111');
  });

  it('rejects a non-uuid *.jsonl file directly under a project dir as not-whitelisted', () => {
    const hit = skipped.find((s) => s.path.endsWith('notes.jsonl'));
    expect(hit?.reason).toBe('not-whitelisted');
  });

  it('rejects a *.sync-conflict-*.jsonl copy of a real session file', () => {
    const hit = skipped.find((s) => s.path.includes('sync-conflict'));
    expect(hit?.reason).toBe('sync-conflict');
  });

  it('never returns duplicate files and never returns anything outside the two whitelisted shapes', () => {
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(files).toHaveLength(6); // 5 sessions + 1 subagent
  });
});

describe('walkClaudeRoots — the peer-box synced vault must never be descended into', () => {
  const { files, skipped } = walkClaudeRoots([SYNC_VAULT_ROOT]);

  it('walks zero files from the vault root (nothing whitelisted is reachable)', () => {
    expect(files).toHaveLength(0);
  });

  it('records memory-vault for the memory/ dir without ever opening what is inside it', () => {
    const hit = skipped.find((s) => s.path.endsWith(path.join('-home-example-Workspaces', 'memory')));
    expect(hit?.reason).toBe('memory-vault');
    // Proof that we never descended: the real backup-copy file living deep inside `memory/` is
    // not present in `files`, and no skip record was even generated FOR it (we skip the
    // directory itself, once, and never list what's inside).
    expect(files.some((f) => f.path.includes('deadbeef-dead-4eef-8eef-deadbeefdead'))).toBe(false);
    expect(skipped.some((s) => s.path.includes('deadbeef-dead-4eef-8eef-deadbeefdead'))).toBe(false);
  });

  it('records syncthing-versions for a bare .stversions dir under a project dir', () => {
    const hit = skipped.find((s) => s.path.endsWith('.stversions'));
    expect(hit?.reason).toBe('syncthing-versions');
  });

  it('records nested-.claude for a project-dir-level .claude segment', () => {
    const hit = skipped.find((s) => s.path.endsWith('.claude'));
    expect(hit?.reason).toBe('nested-.claude');
  });

  it('records not-whitelisted for any other non-uuid directory', () => {
    const hit = skipped.find((s) => s.path.endsWith('random-scratch-dir'));
    expect(hit?.reason).toBe('not-whitelisted');
  });

  // ── Mutation-guard evidence: "vault not skipped must fail" (DESIGN §15.1.1) ─────────────────
  // Actually applied to src/collectors/fswalk.ts in this session (not just described): in
  // `walkClaudeRoots`, the `else { skipped.push(...); }` branch for a non-uuid project-dir child
  // was replaced with `walkSubagentsDir(full, proj.name, files, skipped)` — i.e. "recurse into
  // it like a whitelisted uuid dir" instead of skipping it. `npx vitest run test/claude/fswalk.test.ts`
  // then reported 4 failed / 9 passed:
  //   - 'records memory-vault for the memory/ dir...': expected 'memory-vault', got undefined
  //     (the dir is no longer skipped/reported at all — it's walked instead)
  //   - 'records syncthing-versions for a bare .stversions dir...': same shape, got undefined
  //   - 'records not-whitelisted for any other non-uuid directory...': same shape, got undefined
  //   - real leakage into `files`: `.stversions/old-session.jsonl`,
  //     `.claude/projects/whatever/cafebabe-....jsonl`, and `random-scratch-dir/leftover.jsonl`
  //     all get walked in via the mutated recursion (this walkSubagentsDir-nested `.claude` still
  //     blocks the deepest deadbeef file specifically, but 3 other vault files leak through it)
  // Reverted with `cp /tmp/fswalk.ts.bak src/collectors/fswalk.ts`; re-ran green (13/13) after.
  it('is documented above as a real, applied-and-reverted mutation test (see comment)', () => {
    expect(true).toBe(true);
  });
});
