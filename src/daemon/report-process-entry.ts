/** One process owns one report Worker: a Windows Job, a Linux user-service cgroup,
 * or the current macOS process-group path (escaped-descendant gate remains open). */
import fs from 'node:fs';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let worker: Worker | undefined, starting = false, retiring = false;
const send = (message: unknown) => process.stdout.write(JSON.stringify({ channel: 'worker', message }) + '\n');
function stopOwnedTree(code: number): void {
  if (process.platform === 'linux' && process.env.TOKENELO_REPORT_UNIT) {
    if (code !== 0) process.kill(process.pid, 'SIGKILL'); // Self only; systemd retires the cgroup even with a native-blocked Worker.
    else process.exit(0);
  }
  else if (process.platform === 'win32') process.exit(code === 0 ? 0 : 1);
  else { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }
}
function retire(code: number): void {
  if (retiring) return;
  retiring = true;
  process.stdout.write(JSON.stringify({ channel: 'process', event: 'worker_exit', code }) + '\n', () => {
    stopOwnedTree(code);
  });
}
// A broken output pipe must not exit the supervisor while descendants keep running.
// Do not write another frame through that broken pipe during emergency cleanup.
process.stdout.on('error', () => stopOwnedTree(1));
process.on('uncaughtException', () => stopOwnedTree(1));
input.on('line', line => {
  try {
    const packet = JSON.parse(line);
    if (!starting) {
      if (packet.type !== 'start' || typeof packet.workerUrl !== 'string') throw new Error('invalid start');
      starting = true;
      const url = new URL(packet.workerUrl);
      const options = { workerData: packet.workerData, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 2048 }, execArgv: [] };
      worker = packet.development && !fs.existsSync(url)
        ? new Worker(`(async()=>{const {register}=await import('tsx/esm/api');register();await import(${JSON.stringify(new URL('./report-worker.ts', import.meta.url).href)});})().catch(e=>{throw e;});`, { ...options, eval: true })
        : new Worker(url, options);
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.on('message', send);
      worker.once('error', () => process.stdout.write(JSON.stringify({ channel: 'process', event: 'worker_error' }) + '\n'));
      worker.once('exit', retire);
    } else if (packet.type === 'cancel') worker?.postMessage({ type: 'cancel' });
    else throw new Error('invalid control');
  } catch { retire(1); }
});
input.once('close', () => { if (!retiring) retire(1); });
