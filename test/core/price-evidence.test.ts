import { describe, expect, it } from 'vitest';
import { addPriceEvidence, emptyPriceEvidence, priceEvidenceOf, priceEvidenceProblem } from '../../src/core/price-evidence.js';
import { priceQualityOf, priceQualityProblem } from '../../src/core/price-quality.js';
import { aggregatePriceFields, priceFieldLabel, priceFieldState, priceFieldsUsable } from '../../src/tray/renderer/price-evidence.js';
import { formatApiEquivSubtotal } from '../../src/tray/renderer/format.js';
import { describePoint, renderStackedBarChart } from '../../src/tray/renderer/charts.js';
import { priceQualityTotalsOk } from '../../src/tray/api-client.js';

describe('recorded price field checks: consistency, not authenticity', () => {
  it.each([[null,'UNPRICED'],[0,'LIST'],[0,'ESTIMATE'],[1,'LIST']])('accepts a consistent recorded value %s / %s', (amount,status) => {
    const priceEvidence = priceEvidenceOf(amount,status);
    expect(priceEvidence.issuesEvents).toBe(0); expect(priceEvidenceProblem(priceEvidence,1)).toBeNull();
    expect(priceFieldState({events:1,priceEvidence})).toBe('checked');
  });
  it.each([[null,'LIST',0,0,1],[null,'ESTIMATE',0,0,1],[1,'UNPRICED',0,0,1],[-1,'LIST',1,0,0],['1','LIST',1,0,0],[Infinity,'LIST',1,0,0],[1,'UNKNOWN',0,1,0],[-1,'UNPRICED',1,0,1]])('retains overlapping checks for %s / %s', (amount,status,invalid,unknown,conflicts) => {
    const e=priceEvidenceOf(amount,status);
    expect(e).toMatchObject({events:1,issuesEvents:1,invalidAmountEvents:invalid,unknownStatusEvents:unknown,statusAmountConflictEvents:conflicts});
    expect(priceEvidenceProblem(e,1)).toBeNull(); expect(priceFieldsUsable({events:1,priceEvidence:e})).toBe(false);
  });
  it('keeps absent checks unknown, rejects malformed scope/union and matches the core validator', () => {
    expect(priceFieldState({})).toBe('unchecked'); expect(priceFieldLabel({})).toBe('Price field checks unavailable');
    const base=priceEvidenceOf(null,'LIST');
    for(const e of [null,{...base,events:0},{...base,issuesEvents:0},{...base,version:2},{...base,aggregateAmountInvalid:undefined},{...base,unknownStatusEvents:2}]) {
      expect(priceEvidenceProblem(e,1)).not.toBeNull(); expect(priceFieldState({events:1,priceEvidence:e})).toBe('invalid');
    }
  });
  it('qualifies aggregate overflow even when individual fields are valid', () => {
    const q=priceQualityOf([{apiEquivUsd:Number.MAX_VALUE,priceStatus:'LIST'},{apiEquivUsd:Number.MAX_VALUE,priceStatus:'LIST'}]);
    expect(q).toMatchObject({priceStatus:null,priceEvidence:{issuesEvents:0,aggregateAmountInvalid:true}});
    expect(priceQualityProblem(q)).toBeNull();
  });
  it('validates a conflict as evidence, retaining raw counts without a trusted status', () => {
    const q=priceQualityOf([{apiEquivUsd:null,priceStatus:'LIST'}]);
    expect(priceQualityTotalsOk(q as unknown as Record<string,unknown>)).toBe(true);
    expect(priceQualityTotalsOk({...q,priceStatus:'LIST'})).toBe(false);
  });
  it('cannot average away one host conflict or pretend legacy checks were supplied', () => {
    const clean={events:1,priceEvidence:priceEvidenceOf(1,'LIST')}; const bad={events:1,priceEvidence:priceEvidenceOf(null,'LIST')};
    expect(aggregatePriceFields([clean,bad])).toMatchObject({usable:false,priceEvidence:{events:2,issuesEvents:1}});
    expect(aggregatePriceFields([{},bad])).toEqual({usable:false});
    expect(aggregatePriceFields([{},clean])).toEqual({usable:true});
    expect(aggregatePriceFields([clean,clean])).toMatchObject({usable:true,priceEvidence:{events:2,issuesEvents:0}});
  });
  it('hides usable dollar displays and chart breakdowns while preserving token charts', () => {
    const e=emptyPriceEvidence();addPriceEvidence(e,null,'LIST');
    const point={t:0,apiEquivUsd:1,tokens:10,totalTokens:10,bySource:{codex:1},priceEvidence:e};
    expect(formatApiEquivSubtotal({events:1,apiEquivUsd:1,unpricedEvents:0,priceEvidence:e})).toBe('—');
    expect(describePoint(point,['codex'],'hour').bySource).toEqual([]);
    expect(renderStackedBarChart([point])).toContain('Dollar timeline unavailable');
    expect(renderStackedBarChart([point],{metric:'tokens',sources:['codex']})).not.toContain('Dollar timeline unavailable');
  });
});
