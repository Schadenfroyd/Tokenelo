import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {codexPrefixWitness,isCodexPrefixWitness} from '../../src/collectors/codex-prefix.js';

it('complete chunk witness verifies a copy, extends partial append, and rejects a rewritten sealed prefix', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-prefix-proof-')),file=path.join(root,'source'),copy=path.join(root,'copy');
  try {
    fs.writeFileSync(file,Buffer.alloc(1024*1024+17,65));
    const initial=await codexPrefixWitness(file,fs.statSync(file).size);expect(isCodexPrefixWitness(initial)).toBe(true);expect(initial.chunks).toHaveLength(1);
    fs.copyFileSync(file,copy);expect((await codexPrefixWitness(copy,initial.bytes,initial,true)).chunks).toEqual(initial.chunks);
    fs.appendFileSync(file,Buffer.alloc(200,66));const extended=await codexPrefixWitness(file,fs.statSync(file).size,initial);expect(extended.chunks).toEqual(initial.chunks);
    const fd=fs.openSync(file,'r+');fs.writeSync(fd,Buffer.from('X'),0,1,10);fs.closeSync(fd);
    await expect(codexPrefixWitness(file,extended.bytes,extended,true)).rejects.toThrow('does not match');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

it('prefix witness rejects short source and changed old partial bytes before append',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-prefix-partial-')),file=path.join(root,'source');
  try {
    fs.writeFileSync(file,'abcdef');const initial=await codexPrefixWitness(file,6);
    fs.writeFileSync(file,'abcXefmore');await expect(codexPrefixWitness(file,10,initial)).rejects.toThrow('partial consumed prefix changed');
    fs.truncateSync(file,2);await expect(codexPrefixWitness(file,6,initial,true)).rejects.toThrow('shortened');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

it('replacement is rejected during append and must explicitly verify the complete saved prefix',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-prefix-object-')),file=path.join(root,'source'),copy=path.join(root,'copy');
  try{
    fs.writeFileSync(file,'abc');const saved=await codexPrefixWitness(file,3);fs.copyFileSync(file,copy);fs.unlinkSync(file);fs.renameSync(copy,file);
    await expect(codexPrefixWitness(file,3,saved)).rejects.toThrow('object changed');
    const verified=await codexPrefixWitness(file,3,saved,true);expect(verified.tail).toBe(saved.tail);expect(verified.object).not.toEqual(saved.object);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
