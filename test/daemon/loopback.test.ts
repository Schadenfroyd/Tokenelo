import { describe, it, expect } from 'vitest';
import { isAllowedLoopbackHost, isAllowedLoopbackOrigin } from '../../src/daemon/loopback.js';

describe('isAllowedLoopbackHost', () => {
  it('accepts 127.0.0.1:<port>, localhost:<port>, [::1]:<port> for the given port', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:11444', 11444)).toBe(true);
    expect(isAllowedLoopbackHost('localhost:11444', 11444)).toBe(true);
    expect(isAllowedLoopbackHost('[::1]:11444', 11444)).toBe(true);
  });

  it('rejects the wrong port, a bare hostname with no port, and any non-loopback host', () => {
    expect(isAllowedLoopbackHost('127.0.0.1:9999', 11444)).toBe(false);
    expect(isAllowedLoopbackHost('127.0.0.1', 11444)).toBe(false);
    expect(isAllowedLoopbackHost('attacker.example.com:11444', 11444)).toBe(false);
    expect(isAllowedLoopbackHost('', 11444)).toBe(false);
  });

  it('mutation check: a hostname that merely CONTAINS "localhost" is not accepted', () => {
    expect(isAllowedLoopbackHost('localhost.evil.com:11444', 11444)).toBe(false);
    expect(isAllowedLoopbackHost('notlocalhost:11444', 11444)).toBe(false);
  });
});

describe('isAllowedLoopbackOrigin', () => {
  it('accepts http/https loopback origins at any port, and with no port at all', () => {
    expect(isAllowedLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedLoopbackOrigin('https://127.0.0.1:3000')).toBe(true);
    expect(isAllowedLoopbackOrigin('http://localhost:8080')).toBe(true);
    expect(isAllowedLoopbackOrigin('http://[::1]:5173')).toBe(true);
    expect(isAllowedLoopbackOrigin('http://localhost')).toBe(true);
  });

  it('rejects a non-loopback origin, even one that merely mentions localhost', () => {
    expect(isAllowedLoopbackOrigin('http://evil.example.com')).toBe(false);
    expect(isAllowedLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedLoopbackOrigin('http://evil.com/?x=localhost')).toBe(false);
  });

  it('rejects a loopback host with a path/query (an Origin header never has one; this guards against a caller passing a full URL by mistake)', () => {
    expect(isAllowedLoopbackOrigin('http://127.0.0.1:3000/')).toBe(false);
    expect(isAllowedLoopbackOrigin('http://127.0.0.1:3000/x')).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(isAllowedLoopbackOrigin('ftp://127.0.0.1:3000')).toBe(false);
    expect(isAllowedLoopbackOrigin('file://127.0.0.1')).toBe(false);
  });

  it('rejects the empty string and garbage', () => {
    expect(isAllowedLoopbackOrigin('')).toBe(false);
    expect(isAllowedLoopbackOrigin('null')).toBe(false);
  });
});
