/** Wait for parent-held cgroup ownership before loading any report entry. */
import fs from 'node:fs';
import { linuxProcessBirth } from './report-linux-unit.js';
import { REPORT_PROCESS_MAX_CONTROL_BYTES } from './report-process.js';

const unit = process.env.TOKENELO_REPORT_UNIT;
if (process.platform !== 'linux' || !unit || !/^tokenelo-report-[a-f0-9]{32}\.service$/.test(unit)) process.exit(1);
// This listener remains ahead of the imported entry's listener. Never join a
// native-blocked Worker on EPIPE: self-kill lets the service retire the cgroup.
process.stdout.on('error', () => process.kill(process.pid, 'SIGKILL'));
await new Promise<void>((resolve, reject) => {
  const parts: Buffer[] = []; let size = 0;
  const eof = () => reject(new Error('report parent closed before ownership'));
  const data = (bytes: Buffer) => {
    const newline = bytes.indexOf(10);
    const part = newline < 0 ? bytes : bytes.subarray(0, newline);
    size += part.length; parts.push(part);
    if (size > REPORT_PROCESS_MAX_CONTROL_BYTES) { reject(new Error('invalid ownership acknowledgement')); return; }
    if (newline < 0) return;
    process.stdin.pause(); process.stdin.off('data', data); process.stdin.off('end', eof);
    try {
      const packet = JSON.parse(Buffer.concat(parts, size).toString());
      if (packet.type !== 'owned' || packet.unit !== unit || !packet.env || typeof packet.env !== 'object'
        || Array.isArray(packet.env) || Object.values(packet.env).some(value => typeof value !== 'string')) throw new Error('invalid ownership acknowledgement');
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, packet.env);
      delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;
      process.env.TOKENELO_REPORT_UNIT = unit;
      if (newline + 1 < bytes.length) process.stdin.unshift(bytes.subarray(newline + 1));
      resolve();
    } catch (error) { reject(error); }
  };
  process.stdin.on('data', data); process.stdin.once('end', eof);
  const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().replace(/^0::/, '');
  process.stdout.write(JSON.stringify({ channel: 'process', event: 'linux_started', unit,
    pid: process.pid, birth: linuxProcessBirth(process.pid), cgroup }) + '\n');
}).catch(() => process.exit(1));
await import(process.argv[2]);
process.stdin.resume();
