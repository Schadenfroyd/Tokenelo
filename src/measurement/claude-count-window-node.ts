/** Unwired Node buffer-to-journal adapter. The caller supplies source identity, generation
 * and a known line-boundary offset; this module does not read files or verify those claims.
 * Complete JSONL lines only. Partial UTF8/JSON tails stay unconsumed for the caller to reread.
 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { captureClaudeCountSelection } from './claude-count-selection.js';
import { MAX_COUNT_JOURNAL_BATCH_LENGTH, MAX_COUNT_JOURNAL_BATCH_RECORDS } from './count-journal-node.js';

export const CLAUDE_COUNT_WINDOW_VERSION = 'tokenelo/claude-count-window@v0';
export const MAX_CLAUDE_COUNT_WINDOW_BYTES = 1_048_576;
export const MAX_CLAUDE_COUNT_WINDOW_JSON_LENGTH = 1_400_000;
type WindowRefusal = 'window-string-required' | 'window-json-too-large' | 'window-invalid'
  | 'window-bytes-too-large' | 'invalid-utf8' | 'line-invalid-json' | 'line-object-required'
  | 'assistant-message-required' | 'message-identity-required' | 'model-context-invalid'
  | 'usage-selection-refused' | 'component-refused' | 'journal-record-limit' | 'journal-batch-too-large';
export type ClaudeCountWindow = {
  kind: 'count-window'; contractVersion: typeof CLAUDE_COUNT_WINDOW_VERSION;
  sourceIdentity: 'caller-unverified'; generation: 'caller-unverified'; startBoundary: 'caller-unverified';
  completeBytes: number; nextOffset: number; heldTailBytes: number; completeLines: number;
  assistantUsageRows: number; components: number; journalBatch: string;
} | { kind: 'refused'; contractVersion: typeof CLAUDE_COUNT_WINDOW_VERSION; reason: WindowRefusal; lineOrdinal?: number };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function captureClaudeCountWindow(serialized: unknown): ClaudeCountWindow {
  const refuse = (reason: WindowRefusal, lineOrdinal?: number): ClaudeCountWindow => ({
    kind: 'refused', contractVersion: CLAUDE_COUNT_WINDOW_VERSION, reason,
    ...(lineOrdinal === undefined ? {} : { lineOrdinal }),
  });
  if (typeof serialized !== 'string') return refuse('window-string-required');
  if (serialized.length > MAX_CLAUDE_COUNT_WINDOW_JSON_LENGTH) return refuse('window-json-too-large');
  let input: unknown;
  try { input = JSON.parse(serialized); } catch { return refuse('window-invalid'); }
  const keys = ['sourceKey', 'epochSha', 'startOffset', 'resetEpoch', 'windowBase64'];
  if (!record(input) || Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input, k))
    || !key(input.sourceKey) || !key(input.epochSha) || typeof input.startOffset !== 'number'
    || !Number.isSafeInteger(input.startOffset) || input.startOffset < 0 || typeof input.resetEpoch !== 'boolean'
    || typeof input.windowBase64 !== 'string') return refuse('window-invalid');
  if (input.windowBase64.length > 4 * Math.ceil(MAX_CLAUDE_COUNT_WINDOW_BYTES / 3)) return refuse('window-bytes-too-large');
  const bytes = Buffer.from(input.windowBase64, 'base64');
  if (bytes.toString('base64') !== input.windowBase64) return refuse('window-invalid');
  if (bytes.length > MAX_CLAUDE_COUNT_WINDOW_BYTES) return refuse('window-bytes-too-large');
  const completeBytes = bytes.lastIndexOf(10) + 1;
  const nextOffset = input.startOffset + completeBytes;
  if (!Number.isSafeInteger(nextOffset)) return refuse('window-invalid');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, completeBytes)); }
  catch { return refuse('invalid-utf8'); }
  const records: { componentKey: string; contextSha: string; packet: string }[] = [];
  const lines = completeBytes === 0 ? [] : text.slice(0, -1).split('\n');
  let assistantUsageRows = 0;
  for (let lineOrdinal = 0; lineOrdinal < lines.length; lineOrdinal++) {
    const line = lines[lineOrdinal];
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { return refuse('line-invalid-json', lineOrdinal); }
    if (!record(row)) return refuse('line-object-required', lineOrdinal);
    if (row.type !== 'assistant') continue;
    if (!record(row.message)) return refuse('assistant-message-required', lineOrdinal);
    if (!Object.hasOwn(row.message, 'usage')) continue;
    const id = row.message.id;
    if (typeof id !== 'string' || id.length === 0) return refuse('message-identity-required', lineOrdinal);
    const model = row.message.model;
    if (model !== undefined && model !== null && typeof model !== 'string') return refuse('model-context-invalid', lineOrdinal);
    const selection = captureClaudeCountSelection(row.message.usage);
    if (selection.kind === 'rejected') return refuse('usage-selection-refused', lineOrdinal);
    if (records.length + selection.components.length > MAX_COUNT_JOURNAL_BATCH_RECORDS) return refuse('journal-record-limit', lineOrdinal);
    assistantUsageRows++;
    for (const component of selection.components) {
      if (component.envelope.kind === 'rejected') return refuse('component-refused', lineOrdinal);
      const ordinal = component.ordinal ?? 0;
      // A changed selection shape/model conflicts under the same numeric component identity.
      // Shape length is context, preserving unresolved withdrawals rather than known old totals.
      records.push({
        componentKey: sha(['claude', input.sourceKey, id, ordinal]),
        contextSha: sha(['claude', input.sourceKey, model ?? null, selection.selection, selection.components.length, ordinal]),
        packet: JSON.stringify(component.envelope),
      });
    }
  }
  const journalBatch = JSON.stringify({ sourceKey: input.sourceKey, epochSha: input.epochSha,
    offset: nextOffset, resetEpoch: input.resetEpoch, records });
  if (journalBatch.length > MAX_COUNT_JOURNAL_BATCH_LENGTH) return refuse('journal-batch-too-large');
  return { kind: 'count-window', contractVersion: CLAUDE_COUNT_WINDOW_VERSION,
    sourceIdentity: 'caller-unverified', generation: 'caller-unverified', startBoundary: 'caller-unverified',
    completeBytes, nextOffset, heldTailBytes: bytes.length - completeBytes, completeLines: lines.length,
    assistantUsageRows, components: records.length, journalBatch };
}
