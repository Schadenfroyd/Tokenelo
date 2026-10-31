import { describe,expect,it } from 'vitest';
import { recordedWindowDisclosure,RECORDED_WINDOW_QUALIFICATION,responseTimingWarning } from '../../src/tray/renderer/recorded-window.js';
import type { QueryTimeBasis } from '../../src/tray/renderer/api-types.js';

const NOW=Date.UTC(2026,9,6,12);
const basis:QueryTimeBasis={startMs:NOW-3_600_000,asOfMs:NOW,endInclusive:true,timestampBasis:'recorded-timestamps',excludedFutureEvents:0,excludedFutureActivity:0};

describe('recorded window disclosure',()=>{
  it('shows explicit UTC boundaries and known zero diagnostics',()=>{
    expect(recordedWindowDisclosure(basis)).toEqual({state:'available',window:'Recorded timestamps 2026-10-06T11:00:00.000Z to 2026-10-06T12:00:00.000Z (both boundaries included).',exclusions:'Later timestamps excluded — events: 0; activity records: 0.'});
  });
  it('does not supply a cutoff when older metadata is absent',()=>{
    expect(recordedWindowDisclosure(undefined)).toEqual({state:'unavailable',window:'Recorded timestamp cutoff unavailable from this daemon.',exclusions:null});
  });
  it('distinguishes unknown history start from explicit epoch zero',()=>{
    expect(recordedWindowDisclosure({...basis,startMs:null}).window).toBe('Recorded history through 2026-10-06T12:00:00.000Z (inclusive); start unspecified.');
    expect(recordedWindowDisclosure({...basis,startMs:0}).window).toContain('1970-01-01T00:00:00.000Z');
  });
  it.each([Number.NaN,Number.POSITIVE_INFINITY,-1,8.64e15+1])('refuses invalid cutoff %s',asOfMs=>{
    expect(recordedWindowDisclosure({...basis,asOfMs})).toMatchObject({state:'invalid',exclusions:null});
  });
  it('refuses a reversed interval or unsupported end/basis contract',()=>{
    for(const bad of [{...basis,startMs:NOW+1},{...basis,endInclusive:false},{...basis,timestampBasis:'source-verified'}])expect(recordedWindowDisclosure(bad as QueryTimeBasis).state).toBe('invalid');
  });
  it('keeps missing and invalid diagnostics unavailable while retaining a valid cutoff',()=>{
    for(const value of [undefined,Number.NaN,-1,1.5])expect(recordedWindowDisclosure({...basis,excludedFutureEvents:value} as QueryTimeBasis).exclusions).toBe('Later timestamps excluded — events: unavailable; activity records: 0.');
  });
  it('discloses separate response cutoffs instead of equating windows',()=>{
    const later=recordedWindowDisclosure({...basis,asOfMs:NOW+1,excludedFutureEvents:1200});
    expect(later.window).toContain('2026-10-06T12:00:00.001Z');
    expect(later.window).not.toBe(recordedWindowDisclosure(basis).window);
    expect(later.exclusions).toContain('events: 1,200;');
    expect(RECORDED_WINDOW_QUALIFICATION).toBe('Source clocks and capture completeness are unverified. Later-record counts cover this database.');
  });
});

describe('response timing warning',()=>{
  it('surfaces missing clocks and cutoffs independently without inventing either',()=>{
    expect(responseTimingWarning(undefined,undefined)).toBe('Query clock · Time unavailable · Recorded timestamp cutoff unavailable from this daemon.');
    expect(responseTimingWarning(undefined,basis)).toBe('Query clock · Time unavailable');
    expect(responseTimingWarning(NOW,undefined)).toBe('Recorded timestamp cutoff unavailable from this daemon.');
  });
  it('stays quiet when both the query clock and cutoff are qualified',()=>{
    expect(responseTimingWarning(NOW,basis)).toBeNull();
  });
});
