/**
 * Security regression tests for ollama-serverlog.ts's LOAD_MODEL_RE / TEMPLATE_SELECTION_RE
 * (adversarial audit, 2026-09-26). The original regexes used an unbounded, greedy `.*` between
 * `time=(\S+)` and `msg="..."`, which let the regex skip PAST a line's own real `msg=` field and
 * match a LATER, attacker-controlled occurrence of the literal text `msg="template selection"
 * model=X` if it appeared anywhere later in the line — e.g. embedded inside an unrelated
 * `prompt="..."` field's value that got echoed into a `msg="completion request"` log line. This
 * is a log-injection / model-mis-attribution bug: a crafted prompt could make the collector adopt
 * an attacker-chosen model name. The same unbounded `.*` was also a performance risk on a very
 * long single line.
 *
 * These tests: (a) prove a 200KB adversarial line is rejected in well under 50ms and never
 * produces a fake template match, (b) prove the injection payload embedded inside an unrelated
 * field is rejected rather than misparsed as a real template-selection line, and (c) prove the
 * real documented log lines from the file's own header comment still parse identically to before.
 */
import { describe, it, expect } from 'vitest';
import { parseLine } from '../../src/collectors/ollama-serverlog.js';

describe('parseLine — log-injection hardening (LOAD_MODEL_RE / TEMPLATE_SELECTION_RE)', () => {
  it('rejects a 200KB adversarial single line in well under 50ms, without producing a fake template match', () => {
    // >200,000 chars; the repeated payload is the exact injection literal the audit flagged.
    const line =
      'time=2026-09-26T00:00:00.000-06:00 level=DEBUG msg="completion request" prompt="' +
      'msg="template selection" model='.repeat(6500) +
      '"';
    expect(line.length).toBeGreaterThan(200_000);

    const t0 = performance.now();
    const result = parseLine(line);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(50);
    expect(result).toBeNull();
  });

  it('rejects an injected msg="template selection" model=EVIL payload embedded inside an unrelated field (real msg field is something else)', () => {
    const line =
      'time=2026-09-26T00:00:00.000-06:00 level=DEBUG source=x.go:1 msg="completion request" prompt="a msg=\\"template selection\\" model=EVIL-MODEL rest"';
    const result = parseLine(line);
    expect(result).toBeNull();
    // Extra belt-and-suspenders: whatever comes back, it must never be a template match on the
    // attacker-controlled model name.
    expect(result).not.toEqual(
      expect.objectContaining({ kind: 'template', model: 'EVIL-MODEL' })
    );
  });

  it('rejects an equivalent injected msg="loading model via llama-server" payload embedded inside an unrelated field', () => {
    const line =
      'time=2026-09-26T00:00:00.000-06:00 level=DEBUG source=x.go:1 msg="completion request" prompt="a msg=\\"loading model via llama-server\\" model=/evil/blobs/sha256-deadbeef rest"';
    const result = parseLine(line);
    expect(result).toBeNull();
    expect(result).not.toEqual(expect.objectContaining({ kind: 'load', blobSha: 'deadbeef' }));
  });

  it('still parses the real "loading model via llama-server" line from the file header comment identically to before (model name/blob sha unchanged)', () => {
    // Verified real log line, copied from ollama-serverlog.ts's own header comment.
    const line =
      'time=2026-09-26T15:39:42.982-06:00 level=INFO source=llama_server.go:1046 msg="loading model via llama-server" model=/Users/example/.ollama/models/blobs/sha256-dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da';
    expect(parseLine(line)).toEqual({
      kind: 'load',
      ts: Date.parse('2026-09-26T15:39:42.982-06:00'),
      blobSha: 'dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da',
    });
  });

  it('still parses the real "template selection" line from the file header comment identically to before (canonicalized model name unchanged)', () => {
    // Verified real log line, copied from ollama-serverlog.ts's own header comment.
    const line =
      'time=2026-09-26T15:40:14.898-06:00 level=INFO source=images.go:374 msg="template selection" model=registry.ollama.ai/library/gemma4:26b selected=renderer_parser';
    expect(parseLine(line)).toEqual({
      kind: 'template',
      ts: Date.parse('2026-09-26T15:40:14.898-06:00'),
      model: 'gemma4:26b',
    });
  });

  it('rejects any line over 4096 chars before running the marker regexes at all, even a benign-looking long line', () => {
    const longButBenign =
      'time=2026-09-26T00:00:00.000-06:00 level=INFO source=images.go:374 msg="template selection" model=' +
      'x'.repeat(5000) +
      ' selected=y';
    expect(longButBenign.length).toBeGreaterThan(4096);
    expect(parseLine(longButBenign)).toBeNull();
  });
});
