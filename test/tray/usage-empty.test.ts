import { describe, expect, it } from 'vitest';
import type { SummaryResponse, TimeseriesResponse } from '../../src/tray/renderer/api-types.js';
import { usageTimelineEmptyCaption } from '../../src/tray/renderer/usage-empty.js';

function empty() {
  const summary={range:'30d',byModel:[],totals:{events:0,apiEquivUsd:0,unpricedEvents:0,estimatedPriceEvents:0,tokens:{inputFresh:0,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:0,reasoning:0}}} as unknown as SummaryResponse;
  const series={range:'30d',points:[],priceQualityCounts:true} as unknown as TimeseriesResponse;
  return {summary,series};
}
const known='No usage events recorded for this timeline.';
const points='No API-equivalent timeline points were provided.';
describe('Usage timeline empty evidence',()=>{
  it('describes mutually consistent scoped zero records without denying recorded activity',()=>{
    const {summary,series}=empty();expect(usageTimelineEmptyCaption(summary,series)).toBe(known);
  });
  it('preserves nonempty timeline points instead of hiding a contradictory chart',()=>{
    const {summary,series}=empty();series.points=[{} as TimeseriesResponse['points'][number]];
    expect(usageTimelineEmptyCaption(summary,series)).toBeNull();
  });
  it('does not label other-range or legacy empty points as a known zero',()=>{
    const {summary,series}=empty();expect(usageTimelineEmptyCaption(summary,{...series,range:'7d'})).toBe(points);
    expect(usageTimelineEmptyCaption(summary,{...series,priceQualityCounts:undefined})).toBe(points);
  });
  it('preserves unresolved or contradictory counter evidence',()=>{
    for(const quality of ['incomplete','invalid','conflict'] as const){const {summary,series}=empty();summary.totals.tokens.countQuality=quality;expect(usageTimelineEmptyCaption(summary,series)).toBe(points);}
    const {summary,series}=empty();summary.totals.tokens.inputFresh=1;expect(usageTimelineEmptyCaption(summary,series)).toBe(points);
  });
  it('does not confuse present events, malformed counts or nonzero/unknown dollars with zero records',()=>{
    for(const events of [1,-1,NaN,undefined] as unknown as number[]){const {summary,series}=empty();summary.totals.events=events;expect(usageTimelineEmptyCaption(summary,series)).toBe(points);}
    for(const value of [1,NaN,undefined] as unknown as number[]){const {summary,series}=empty();summary.totals.apiEquivUsd=value;expect(usageTimelineEmptyCaption(summary,series)).toBe(points);}
  });
  it('does not hide model or partial pricing records behind empty points',()=>{
    const {summary,series}=empty();summary.byModel=[{} as SummaryResponse['byModel'][number]];expect(usageTimelineEmptyCaption(summary,series)).toBe(points);
    for(const field of ['unpricedEvents','estimatedPriceEvents'] as const){const s=empty();s.summary.totals[field]=1;expect(usageTimelineEmptyCaption(s.summary,s.series)).toBe(points);}
  });
});
