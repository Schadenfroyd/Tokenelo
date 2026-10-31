export type TrayLifecycleEvent =
  | 'instance-lock-refused'
  | 'daemon-start-failed'
  | 'tray-created'
  | 'quit-requested'
  | 'app-before-quit'
  | 'startup-failed';

export function serializeTrayLifecycleEvent(
  event: TrayLifecycleEvent,
  pid: number,
  timestamp: Date
): string {
  return JSON.stringify({
    component: 'tokenelo-tray',
    event,
    pid,
    timestamp: timestamp.toISOString(),
  });
}

export function writeTrayLifecycleEvent(event: TrayLifecycleEvent): void {
  process.stderr.write(serializeTrayLifecycleEvent(event, process.pid, new Date()) + '\n');
}
