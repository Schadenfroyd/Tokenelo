import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer, closeHttpReads, type CreateHttpServerOpts } from '../../src/daemon/http.js';
import type { Queries } from '../../src/store/queries.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';
import type { ReadControl } from '../../src/core/read-control.js';

let server: http.Server | undefined;
afterEach(async () => { if (server) { await closeHttpReads(server); await new Promise<void>(ok => server!.close(() => ok())); server = undefined; } });
async function start(summary: Queries['getSummary']) {
  const opts: CreateHttpServerOpts = { port: 0, token: 'secret', host: 'H', queries: { getSummary: summary } as Queries };
  server = createHttpServer(opts);
  await new Promise<void>(ok => server!.listen(0, '127.0.0.1', () => ok()));
  opts.port = (server.address() as import('node:net').AddressInfo).port;
  return 'http://127.0.0.1:' + opts.port;
}
describe('authenticated report admission and retirement', () => {
  it('keeps method/Host/Origin/auth checks ahead of any report admission', async () => {
    let admitted = 0;
    const base = await start(async () => { admitted++; throw new ReportReadError('read_capacity'); });
    for (const [headers,status] of [[{},401],[{ Host:'other:1',Authorization:'Bearer secret' },403],
      [{ Origin:'http://localhost',Authorization:'Bearer secret' },403]] as const) {
      const actual = await new Promise<number>(ok => {
        const request = http.request(base+'/v1/summary?range=all', { headers }, response => { response.resume(); ok(response.statusCode!); });
        request.end();
      });
      expect(actual).toBe(status);
    }
    expect((await fetch(base+'/v1/summary', { method:'POST',headers:{Authorization:'Bearer secret'} })).status).toBe(405);
    expect(admitted).toBe(0);
    const response = await fetch(base+'/v1/summary?range=all', { headers:{Authorization:'Bearer secret'} });
    expect(response.status).toBe(429); expect((await response.json()).error).toBe('read_capacity'); expect(admitted).toBe(1);
  });
  for (const [code,status] of [['read_timeout',504],['read_unavailable',503],['query_failed',503],['result_too_large',413]] as const) {
    it('returns an explicit '+code+' instead of a successful empty report', async () => {
      const base = await start(async () => { throw new ReportReadError(code); });
      const response = await fetch(base+'/v1/summary', { headers:{Authorization:'Bearer secret'} });
      expect(response.status).toBe(status); expect((await response.json()).error).toBe(code);
    });
  }
  it('cancels the authenticated read when its HTTP response is disconnected', async () => {
    let admitted!: () => void, retired!: () => void;
    const ready = new Promise<void>(ok => { admitted = ok; }), cancelled = new Promise<void>(ok => { retired = ok; });
    const base = await start((_range,control?: ReadControl) => new Promise((_ok,no) => {
      control!.signal!.addEventListener('abort',()=>{ retired(); no(new ReportReadError('read_cancelled')); },{once:true}); admitted();
    }));
    const controller = new AbortController();
    const response = fetch(base+'/v1/summary', { headers:{Authorization:'Bearer secret'},signal:controller.signal }).catch(error=>error.name);
    await ready; controller.abort(); expect(await response).toBe('AbortError'); await cancelled;
  });
});
