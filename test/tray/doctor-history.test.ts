import {expect,it}from 'vitest';import {doctorSummary}from '../../src/tray/renderer/doctor-summary.js';import type{DoctorReport}from '../../src/tray/renderer/api-types.js';
function note(input:object){return doctorSummary({ollama:{backlog:input}} as DoctorReport).find(r=>r.label==='Proxy capture backlog')!.note;}
const clean={observedAt:1000,pending:0,quarantined:0,writeFailures:0};
it('a zero count never hides failure evidence that could not be stored',()=>{expect(note({...clean,failureEvidenceStored:false})).toContain('Capture needs review');expect(note({...clean,failureEvidenceStored:false})).toContain('Failure evidence could not be stored');});
it('damaged history is qualified even beside a currently persisted snapshot',()=>{expect(note({...clean,failureEvidenceStored:true,historyIncomplete:true})).toContain('Failure history is incomplete');});
it.each([undefined,null,'0',-1,1.5,NaN])('unknown or malformed diagnostic counters require review (%s)',(bad)=>{const result=note({...clean,writeFailures:bad});expect(result).toContain('Diagnostic counts are unavailable');expect(result).toContain('Capture needs review');});

it.each([{historyIncomplete:1},{historyIncomplete:'true'},{failureEvidenceStored:0},{failureEvidenceStored:'false'},{failureEvidenceStored:'x'}])('malformed diagnostic flags require review (%j)',flag=>{expect(note({...clean,...flag})).toContain('Capture needs review');});
it('older optional flags and null persistence remain qualified by valid counters without inventing an error',()=>{expect(note({...clean,failureEvidenceStored:null})).not.toContain('Capture needs review');});
