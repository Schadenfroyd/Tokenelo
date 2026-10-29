import http from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { describe, it, expect, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  parseLsofListenOutput,
  parseSsListenOutput,
  parseNetstatListenOutput,
  parseTasklistCsv,
  resolveLogPath,
  canonicalManifestName,
  buildManifestMap,
  probeOllama,
  getOllamaVersion,
} from '../../src/collectors/ollama-probe.js';

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'ollama');

it('skips unused manifest reads for server-only probes while preserving collector defaults and server results', async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    expect(request.url).toBe('/api/version');
    expect(request.headers['accept-encoding']).toBe('identity');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: 'fixture-version' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback version fixture unavailable');
  const readdir = vi.spyOn(fsp, 'readdir');
  try {
    const options = { platform: 'aix' as const, modelsDir: FIXTURES, now: () => 42, ollamaUpstream: `http://127.0.0.1:${address.port}` };
    const serverOnly = await probeOllama({ ...options, includeManifests: false });
    expect(serverOnly.manifests.size).toBe(0);
    expect(readdir).not.toHaveBeenCalled();
    const collector = await probeOllama(options);
    expect(collector.servers).toEqual(serverOnly.servers);
    expect(collector.generatedAt).toBe(serverOnly.generatedAt);
    expect(collector.manifests.get('dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da')).toBe('gemma4:26b');
    expect(readdir).toHaveBeenCalled();
    expect(requests).toBe(2);
  } finally {
    readdir.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('treats a compressed /api/version response as unavailable without decoding it', async () => {
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify({ version: 'fixture-version' }), 'utf8'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
    response.end(compressed);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback version fixture unavailable');
  try {
    await expect(getOllamaVersion(`http://127.0.0.1:${address.port}`)).resolves.toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('an already-cancelled readonly probe rejects instead of claiming no servers or manifests', async () => {
  const controller = new AbortController(), reason = new Error('owned report cancelled'); controller.abort(reason);
  await expect(probeOllama({ signal: controller.signal })).rejects.toBe(reason);
  await expect(getOllamaVersion('http://127.0.0.1:1', 2000, controller.signal)).rejects.toBe(reason);
  await expect(buildManifestMap(FIXTURES, controller.signal)).rejects.toBe(reason);
});

// ── macOS lsof parsing — verified against REAL output captured on M4a 2026-09-26 ──
// (`lsof -nP -iTCP:11434 -sTCP:LISTEN`): Homebrew ollama owns IPv4 127.0.0.1, Ollama.app owns the
// IPv6 wildcard socket. This is not a hand-built fixture — it is the literal command output.
const REAL_LSOF_OUTPUT = `COMMAND  PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
ollama  2282 example    3u  IPv4 0x547b19e391a78918      0t0  TCP 127.0.0.1:11434 (LISTEN)
ollama  2830 example    3u  IPv6 0xbb9d370cda53e46f      0t0  TCP *:11434 (LISTEN)`;

describe('parseLsofListenOutput (verified real macOS output)', () => {
  it('finds both the Homebrew IPv4 and Ollama.app IPv6 listeners on M4a', () => {
    const result = parseLsofListenOutput(REAL_LSOF_OUTPUT, 11434);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ pid: 2282, command: 'ollama', family: 'IPv4', localAddress: '127.0.0.1', port: 11434 });
    expect(result[1]).toEqual({ pid: 2830, command: 'ollama', family: 'IPv6', localAddress: '*', port: 11434 });
  });

  it('returns [] for output with no matching lines', () => {
    expect(parseLsofListenOutput('', 11434)).toEqual([]);
    expect(parseLsofListenOutput('COMMAND  PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME', 11434)).toEqual([]);
  });
});

// ── Linux ss / Windows netstat — SHAPE-ONLY / UNPROVEN (hand-built against documented formats,
// never cross-checked against a live `ss -ltnp` or `netstat -ano` run in this task). ──
describe('parseSsListenOutput (shape-only / unproven — documented ss -ltnp format)', () => {
  it('parses an IPv4 loopback LISTEN line', () => {
    const out = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN 0      4096         127.0.0.1:11434       0.0.0.0:*     users:(("ollama",pid=1234,fd=7))`;
    const result = parseSsListenOutput(out, 11434);
    expect(result).toEqual([{ pid: 1234, command: 'ollama', family: 'IPv4', localAddress: '127.0.0.1', port: 11434 }]);
  });

  it('parses an IPv6 loopback LISTEN line', () => {
    const out = `LISTEN 0      4096              [::1]:11434          [::]:*    users:(("ollama",pid=5678,fd=8))`;
    const result = parseSsListenOutput(out, 11434);
    expect(result).toEqual([{ pid: 5678, command: 'ollama', family: 'IPv6', localAddress: '::1', port: 11434 }]);
  });

  it('ignores lines for a different port', () => {
    const out = `LISTEN 0 4096 127.0.0.1:9999 0.0.0.0:* users:(("other",pid=1,fd=1))`;
    expect(parseSsListenOutput(out, 11434)).toEqual([]);
  });
});

describe('parseNetstatListenOutput + parseTasklistCsv (shape-only / unproven — documented netstat -ano / tasklist format)', () => {
  it('parses an IPv4 LISTENING line', () => {
    const out = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       1234`;
    const result = parseNetstatListenOutput(out, 11434);
    expect(result).toEqual([{ pid: 1234, family: 'IPv4', localAddress: '127.0.0.1', port: 11434 }]);
  });

  it('parses an IPv6 LISTENING line', () => {
    const out = `  TCP6   [::1]:11434            [::]:0                 LISTENING       1234`;
    const result = parseNetstatListenOutput(out, 11434);
    expect(result).toEqual([{ pid: 1234, family: 'IPv6', localAddress: '::1', port: 11434 }]);
  });

  it('parses tasklist CSV to extract the image name', () => {
    const csv = `"ollama.exe","1234","Console","1","12,345 K"`;
    expect(parseTasklistCsv(csv)).toBe('ollama.exe');
  });

  it('returns null for empty tasklist output', () => {
    expect(parseTasklistCsv('INFO: No tasks running.')).toBeNull();
  });
});

// ── Log path resolution ─────────────────────────────────────────────────────
describe('resolveLogPath', () => {
  it('resolves the Homebrew log path when the process command contains /homebrew/', () => {
    const res = resolveLogPath(
      { pid: 1, command: '/opt/homebrew/opt/ollama/bin/ollama serve', family: 'IPv4', localAddress: '127.0.0.1', port: 11434 },
      { platform: 'darwin', homeDir: '/Users/fixture', exists: (p) => p === '/opt/homebrew/var/log/ollama.log' }
    );
    expect(res).toEqual({ path: '/opt/homebrew/var/log/ollama.log', source: 'homebrew', available: true });
  });

  it('resolves the Ollama.app log path when the process command contains Ollama.app', () => {
    const res = resolveLogPath(
      { pid: 2, command: '/Applications/Ollama.app/Contents/Resources/ollama serve', family: 'IPv6', localAddress: '*', port: 11434 },
      { platform: 'darwin', homeDir: '/Users/fixture', exists: () => false }
    );
    expect(res).toEqual({ path: '/Users/fixture/.ollama/logs/server.log', source: 'ollama-app', available: true });
  });

  it('reports Linux journalctl as unavailable (verified empirically: no structured token data)', () => {
    const res = resolveLogPath(null, { platform: 'linux', homeDir: '/home/fixture' });
    expect(res.available).toBe(false);
    expect(res.source).toBe('linux-systemd');
    expect(res.path).toBeNull();
  });

  it('resolves the Windows LOCALAPPDATA log path', () => {
    const res = resolveLogPath(null, {
      platform: 'win32',
      homeDir: 'C:\\Users\\fixture',
      env: { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' },
    });
    expect(res.available).toBe(true);
    expect(res.source).toBe('windows');
    expect(res.path).toBe(path.join('C:\\Users\\fixture\\AppData\\Local', 'Ollama', 'server.log'));
  });

  it('never hardcodes ~/.ollama/logs/server.log when the owning binary is unknown and neither candidate exists (spike S7 "wrong-log-file trap")', () => {
    const res = resolveLogPath(null, { platform: 'darwin', homeDir: '/Users/fixture', exists: () => false });
    expect(res.available).toBe(false);
    expect(res.source).toBe('unknown');
  });
});

// ── Manifest canonicalization + real manifest map ───────────────────────────
describe('canonicalManifestName (verified against this host\'s real manifest paths)', () => {
  it('drops the default registry.ollama.ai/library prefix', () => {
    expect(canonicalManifestName(['registry.ollama.ai', 'library', 'gemma4', '26b'])).toBe('gemma4:26b');
  });

  it('keeps a non-default registry/namespace verbatim', () => {
    expect(canonicalManifestName(['hf.co', 'unsloth', 'Qwen3.8-27B-GGUF', 'UD-Q4_K_XL'])).toBe(
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'
    );
  });

  it('drops the registry.ollama.ai prefix even for a non-library namespace (matches Ollama\'s own CLI naming)', () => {
    expect(canonicalManifestName(['registry.ollama.ai', 'someorg', 'model', 'tag'])).toBe('someorg/model:tag');
  });
});

describe('buildManifestMap (against real manifest fixtures copied verbatim from this host)', () => {
  it('maps the gemma4:26b weights blob sha to "gemma4:26b"', async () => {
    const map = await buildManifestMap(FIXTURES);
    expect(map.get('dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da')).toBe('gemma4:26b');
  });

  it('maps the Qwen weights blob sha to its hf.co-prefixed name', async () => {
    const map = await buildManifestMap(FIXTURES);
    expect(map.get('3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e')).toBe(
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'
    );
  });

  it('never maps a non-model layer (template/projector/params digests are absent from the map)', async () => {
    const map = await buildManifestMap(FIXTURES);
    // the gemma4 manifest's template-layer digest must NOT appear as a key
    expect(map.has('b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315')).toBe(false);
  });

  it('returns an empty map for a directory with no manifests (never throws)', async () => {
    const map = await buildManifestMap(path.join(FIXTURES, 'does-not-exist'));
    expect(map.size).toBe(0);
  });
});
