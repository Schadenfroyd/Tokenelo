import { describe, expect, it } from 'vitest';
import type { UsageEvent } from '../../src/core/types.js';
import { eventsToCsv } from '../../src/cli/csv.js';

const event: UsageEvent = {
  id: 'synthetic-event', host: 'example-host', source: 'codex', ts: 1000, tsSource: 'record',
  sessionId: 'synthetic-session', isSubagent: false, model: 'example-model', provider: 'openai',
  components: [{ model: 'example-model', tokens: {
    inputFresh: 12, cacheWrite5m: 3, cacheWrite1h: 7, cacheRead: 40, output: 10, reasoning: 4,
  } }],
  tokens: { inputFresh: 12, cacheWrite5m: 3, cacheWrite1h: 7, cacheRead: 40, output: 10, reasoning: 4 },
  flags: [], apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: 'example-v1',
  reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: 'example-definition',
};

// Independent RFC-style record parser, including quoted multiline cells.
function parse(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(value); value = ''; }
    else if (!quoted && c === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  return rows;
}
function exported(value: UsageEvent): Record<string, string> {
  const [headers, values] = parse(eventsToCsv([value]));
  expect(values!.length).toBe(headers!.length);
  return Object.fromEntries(headers!.map((key, i) => [key, values![i]!]));
}

describe('recorded token CSV export', () => {
  it('preserves price status and price provenance, including unavailable provenance', () => {
    const recorded = exported(event);
    expect(recorded.priceStatus).toBe('UNPRICED');
    expect(recorded.priceVersion).toBe('example-v1');

    const unavailable = exported({ ...event, priceVersion: '', eacsDefSha256: '' });
    expect(unavailable.priceStatus).toBe('UNPRICED');
    expect(unavailable.priceVersion).toBe('');
  });

  it('does not export the reserved valuation columns that stored events keep', () => {
    const [headers] = parse(eventsToCsv([event]));
    for (const dropped of ['ucu', 'ucuRateStatus', 'eacsDefSha256', 'rateKey', 'rateResolvedSha256', 'selectionState', 'runtimeState']) {
      expect(headers).not.toContain(dropped);
    }
    expect(headers).toContain('ucuCountQuality');
    expect(headers!.slice(0, 10)).toEqual(['id', 'host', 'source', 'ts', 'sessionId', 'model', 'provider', 'apiEquivUsd', 'priceStatus', 'priceVersion']);
  });

  it('preserves all recorded components and leaves unavailable price and optional counters blank', () => {
    const row = exported(event);
    expect([row.inputFresh, row.cacheWrite5m, row.cacheWrite1h, row.cacheRead, row.output, row.reasoning])
      .toEqual(['12', '3', '7', '40', '10', '4']);
    expect(row.apiEquivUsd).toBe('');
    expect(row.cacheWriteUnassigned).toBe(''); expect(row.cacheWriteAssumed1h).toBe('');
    expect(row.countQuality).toBe('unrecorded'); expect(row.ucuCountQuality).toBe('unrecorded');
    expect(row.costBasis).toBe('api-equivalent-not-billed'); expect(row.exportSchemaVersion).toBe('3');
    expect(row.fieldEvidence).toBe('');
    expect(JSON.parse(row.components!)).toEqual(event.components);
    expect(event.tokens.countQuality).toBeUndefined();
  });
  it('retains known zero, assumed subsets and distinct count qualifications without folding reasoning into output', () => {
    const row = exported({ ...event, apiEquivUsd: 0, tokens: { ...event.tokens,
      cacheWriteUnassigned: 0, cacheWriteAssumed1h: 5, countQuality: 'incomplete', ucuCountQuality: 'complete' } });
    expect(row.apiEquivUsd).toBe('0'); expect(row.cacheWriteUnassigned).toBe('0');
    expect(row.cacheWriteAssumed1h).toBe('5'); expect(row.cacheWrite1h).toBe('7');
    expect(row.countQuality).toBe('incomplete'); expect(row.ucuCountQuality).toBe('complete');
    expect(row.output).toBe('10'); expect(row.reasoning).toBe('4');
  });
  it('round-trips commas, quotes and carriage returns in metadata without making extra rows', () => {
    expect(exported({ ...event, model: 'model,"variant"\rnext' }).model).toBe('model,"variant"\rnext');
  });
  it.each(['=1+1', '+SUM(1,1)', '-1+1', '@SUM(1,1)', '  =1+1', '\t=1+1', '\r=1+1', '\n=1+1'])(
    'neutralizes untrusted spreadsheet formula %j only in CSV', (model) => {
      const value = { ...event, model };
      expect(exported(value).model).toBe(`'${model}`);
      expect(value.model).toBe(model);
    });
});
