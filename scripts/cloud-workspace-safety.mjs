import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Local clone hygiene only. No tracked source changes, secrets read, services or network.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8' }).trim();
const exclude = path.resolve(root, gitPath);
const marker = '# Tokenelo cloud clone: secrets and local ledgers never enter Git';
const entries = ['.env', '.env.*', '!.env.example', 'api-token', 'fleet-token', 'config.local.json', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '*.db', '*.db-wal', '*.db-shm'];
const old = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
if (!old.includes(marker)) {
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, (old.endsWith('\n') || !old ? '' : '\n') + marker + '\n' + entries.join('\n') + '\n');
}
const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = names.filter(n => n !== '.env.example' && /(?:^|\/)(?:api-token|fleet-token|config\.local\.json|\.env(?:\..*)?)$|\.(?:db|sqlite)(?:-wal|-shm)?$/.test(n));
if (bad.length) { console.error('Tracked secret/database paths require private review; values were not read.'); process.exitCode = 1; }
else console.log('Local secret/database exclusions applied; tracked candidate bytes unchanged. No service, network or credential read.');
