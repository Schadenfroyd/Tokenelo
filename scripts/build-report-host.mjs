/** Copy the checked Windows GUI host unchanged on every build host. Never compile at runtime.
 * A C# change requires a Windows rebuild and refreshed provenance; missing/stale assets fail. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'native/report-job-host.manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src/daemon/native/report-job-host.cs'));
const binary = fs.readFileSync(path.join(root, 'native/report-job-host.exe'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (sha(source) !== manifest.sourceSha256 || sha(binary) !== manifest.binarySha256) throw new Error('Report job host provenance mismatch');
const pe = binary.readUInt32LE(0x3c);
if (binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 24 + 68) !== 2) throw new Error('Report job host must use Windows GUI subsystem');
const output = path.join(root, 'dist/daemon/native');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, 'native/report-job-host.exe'), path.join(output, 'report-job-host.exe'));
