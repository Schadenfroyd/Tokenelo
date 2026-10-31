import { describe, expect, it } from 'vitest';
import {
  serializeTrayLifecycleEvent,
  type TrayLifecycleEvent,
} from '../../src/tray/lifecycle-log.js';

describe('tray lifecycle log', () => {
  it.each([
    'instance-lock-refused',
    'daemon-start-failed',
    'tray-created',
    'quit-requested',
    'app-before-quit',
    'startup-failed',
  ] as const)('serializes %s with only allowlisted fields', (event: TrayLifecycleEvent) => {
    const line = serializeTrayLifecycleEvent(
      event,
      42,
      new Date('2026-10-21T07:00:00.000Z')
    );

    const record = JSON.parse(line);
    expect(record).toEqual({
      component: 'tokenelo-tray',
      event,
      pid: 42,
      timestamp: '2026-10-21T07:00:00.000Z',
    });
    expect(Object.keys(record).sort()).toEqual(['component', 'event', 'pid', 'timestamp']);
    expect(line).not.toContain('\n');
  });
});
