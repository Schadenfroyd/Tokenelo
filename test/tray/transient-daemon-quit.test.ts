import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  recordLinuxTransientChildError,
  recordLinuxTransientChildExit,
  requestLinuxTrayQuit,
  type LinuxTransientDaemonState,
  type LinuxTrayQuitPrompt,
} from '../../src/tray/transient-daemon-quit.js';
import type { LinuxTransientChildHandle } from '../../src/tray/linux-service-runtime.js';

class FakeTransientChild implements LinuxTransientChildHandle {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly signals: string[] = [];

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM') this.killed = true;
    return true;
  }
}

function confirmWith(prompt: LinuxTrayQuitPrompt, answer: boolean) {
  return vi.fn(async (actual: LinuxTrayQuitPrompt) => {
    expect(actual).toBe(prompt);
    return answer;
  });
}

describe('explicit Linux tray Quit', () => {
  it('defaults cancellation for a tray-owned transient and leaves it running', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();
    const stopFailure = vi.fn();
    const waitForExit = vi.fn(async () => false);
    const confirm = confirmWith('pause-owned-transient', false);

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false, confirm, waitForExit, quit, stopFailure,
    });

    expect(result).toBe('cancelled');
    expect(child.signals).toEqual([]);
    expect(waitForExit).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(stopFailure).not.toHaveBeenCalled();
  });

  it('sends one graceful signal and quits only after the exact owned child exits', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();
    const waitForExit = vi.fn(async (timeoutMs: number) => {
      expect(timeoutMs).toBe(30_000);
      child.exitCode = 0;
      return true;
    });

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false,
      confirm: confirmWith('pause-owned-transient', true), waitForExit, quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('quit-after-pausing-transient');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('keeps tray ownership after timeout and retries by waiting without a second signal', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();
    const stopFailure = vi.fn();
    const waitForExit = vi.fn(async () => false);
    const confirmed = confirmWith('pause-owned-transient', true);

    const first = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false, confirm: confirmed, waitForExit, quit, stopFailure,
    });
    expect(first).toBe('stop-unconfirmed');
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(quit).not.toHaveBeenCalled();
    expect(stopFailure).toHaveBeenCalledOnce();

    const second = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false, confirm: confirmed, waitForExit, quit, stopFailure,
    });
    expect(second).toBe('stop-unconfirmed');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(waitForExit).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();
  });

  it('can finish a prior graceful stop on retry without sending another signal', async () => {
    const child = new FakeTransientChild();
    child.killed = true;
    const quit = vi.fn();
    const waitForExit = vi.fn(async (timeoutMs: number) => {
      expect(timeoutMs).toBe(30_000);
      child.signalCode = 'SIGTERM';
      return true;
    });

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false,
      confirm: confirmWith('pause-owned-transient', true), waitForExit, quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('quit-after-pausing-transient');
    expect(child.signals).toEqual([]);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('retains the tray and reports an unavailable process identity without signaling', async () => {
    const child = new FakeTransientChild();
    child.pid = undefined;
    const quit = vi.fn();
    const stopFailure = vi.fn();
    const waitForExit = vi.fn(async () => true);

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false,
      confirm: confirmWith('pause-owned-transient', true), waitForExit, quit, stopFailure,
    });

    expect(result).toBe('stop-unconfirmed');
    expect(stopFailure).toHaveBeenCalledWith('child-identity-unavailable');
    expect(child.signals).toEqual([]);
    expect(waitForExit).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('retains PID-bearing ownership after an OS error, then retries Quit until graceful exit', async () => {
    const child = new FakeTransientChild();
    const state: LinuxTransientDaemonState<FakeTransientChild> = { child, ownership: 'owned-running' };
    expect(recordLinuxTransientChildError(state, child)).toBe('retained-owned-child');
    expect(state).toEqual({ child, ownership: 'owned-running' });

    const quit = vi.fn();
    const stopFailure = vi.fn();
    const waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (timeoutMs: number) => {
        expect(timeoutMs).toBe(30_000);
        child.exitCode = 0;
        return true;
      });
    const first = await requestLinuxTrayQuit({
      ownership: state.ownership, child: state.child, configuredService: false,
      confirm: confirmWith('pause-owned-transient', true), waitForExit, quit, stopFailure,
    });
    expect(first).toBe('stop-unconfirmed');
    expect(state).toEqual({ child, ownership: 'owned-running' });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(quit).not.toHaveBeenCalled();
    expect(stopFailure).toHaveBeenCalledWith('graceful-stop-not-confirmed');

    const retry = await requestLinuxTrayQuit({
      ownership: state.ownership, child: state.child, configuredService: false,
      confirm: confirmWith('pause-owned-transient', true), waitForExit, quit, stopFailure,
    });
    expect(retry).toBe('quit-after-pausing-transient');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(quit).toHaveBeenCalledOnce();
    expect(recordLinuxTransientChildExit(state, child)).toBe(true);
    expect(state).toEqual({ child: null, ownership: 'owned-exited' });
  });

  it('clears only an exact pre-spawn failure with no PID', () => {
    const child = new FakeTransientChild();
    child.pid = undefined;
    const state: LinuxTransientDaemonState<FakeTransientChild> = { child, ownership: 'owned-running' };

    expect(recordLinuxTransientChildError(state, child)).toBe('pre-spawn-failed');
    expect(state).toEqual({ child: null, ownership: 'spawn-failed' });
  });

  it('ignores stale errors and exits from an older child after a replacement is owned', () => {
    const oldChild = new FakeTransientChild();
    const currentChild = new FakeTransientChild();
    currentChild.pid = 5252;
    const state: LinuxTransientDaemonState<FakeTransientChild> = { child: currentChild, ownership: 'owned-running' };

    expect(recordLinuxTransientChildError(state, oldChild)).toBe('stale-child');
    expect(recordLinuxTransientChildExit(state, oldChild)).toBe(false);
    expect(state).toEqual({ child: currentChild, ownership: 'owned-running' });
  });

  it('leaves a configured service untouched on a confirmed tray-only quit', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();
    const waitForExit = vi.fn(async () => false);

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-exited', child: null, configuredService: true,
      confirm: confirmWith('leave-configured-service', true), waitForExit, quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('quit-with-background-untouched');
    expect(child.signals).toEqual([]);
    expect(waitForExit).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('stops only the exact transient while naming a configured service that will remain', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();
    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: true,
      confirm: confirmWith('pause-owned-transient-and-leave-service', true),
      waitForExit: async timeoutMs => { expect(timeoutMs).toBe(30_000); child.exitCode = 0; return true; },
      quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('quit-after-pausing-transient');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('never signals a running daemon whose ownership belongs to an older or crashed tray', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();

    const result = await requestLinuxTrayQuit({
      ownership: 'unknown-existing', child, configuredService: false,
      confirm: confirmWith('leave-unowned-daemon', true), waitForExit: vi.fn(async () => false), quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('quit-with-background-untouched');
    expect(child.signals).toEqual([]);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('fails closed when confirmation is unavailable', async () => {
    const child = new FakeTransientChild();
    const quit = vi.fn();

    const result = await requestLinuxTrayQuit({
      ownership: 'owned-running', child, configuredService: false,
      confirm: async () => { throw new Error('dialog unavailable'); }, waitForExit: vi.fn(async () => true), quit, stopFailure: vi.fn(),
    });

    expect(result).toBe('confirmation-failed');
    expect(child.signals).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
  });

  it('keeps popover blur as hide-only and routes shutdown only through the explicit tray Quit item', () => {
    const source = readFileSync(new URL('../../src/tray/main.ts', import.meta.url), 'utf8');
    const blur = source.match(/win\.on\('blur',[\s\S]*?\n  \}\);/)?.[0];
    const quitItem = source.match(/label: 'Quit',[\s\S]*?\n    \},/)?.[0];

    expect(blur).toContain('win.hide()');
    expect(blur).not.toContain('quitFromTrayMenu');
    expect(quitItem).toContain('void quitFromTrayMenu()');
    expect(source).not.toMatch(/app\.on\(['"]window-all-closed['"]/);
    expect(source).toContain('recordLinuxTransientChildError(transientDaemonState, child)');
    expect(source).toContain('recordLinuxTransientChildExit(transientDaemonState, child)');
  });
});
