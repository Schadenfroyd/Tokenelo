/**
 * What the renderer says about a failed daemon read. Pure, so the tests drive it directly.
 *
 * A local request that passes its deadline fails in the main process with a DaemonTimeoutError (src/tray/api-client.ts). The class
 * does not reach the renderer: Electron's IPC sends only `String(error)`, so the rejection arrives as a plain Error whose message is
 * `Error invoking remote method '<channel>': DaemonTimeoutError: [tokenelo:local-timeout] GET <route> …`. The marker is the one
 * signal that survives, so it alone decides, and only where it starts the message or follows `: `. No other client error contains it.
 * Every other failure keeps the message it had before, and none of them is ever shown as an empty or zero result.
 *
 * The marker is duplicated from api-client.ts rather than imported (see api-types.ts for why the renderer cannot import Node-side
 * modules); a test checks that the two strings match.
 */

export const LOCAL_TIMEOUT_MARKER = '[tokenelo:local-timeout]';

/** Shown in place of the error message when a read timed out. It makes no claim about the cause. */
export const LOCAL_TIMEOUT_COPY = 'Tokenelo is taking longer than expected to respond. Try again in a moment.';

const LOCAL_TIMEOUT_PATTERN = /(?:^|: )\[tokenelo:local-timeout\] /;
export function isSummaryCancelled(err: unknown): boolean {
  return err instanceof Error && /(?:^|: )\[tokenelo:summary-cancelled\] /.test(err.message);
}

/** True only for a local-deadline failure, whether it arrives directly or through IPC. */
export function isLocalTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && LOCAL_TIMEOUT_PATTERN.test(message);
}

/** The text to show for a failed read: the timeout copy for a timeout, the error's own message otherwise (unchanged behaviour). */
export function failureMessage(err: unknown): string {
  if (isSummaryCancelled(err)) return 'The historical report was cancelled. Choose a shorter period or try again.';
  if (isLocalTimeout(err)) return LOCAL_TIMEOUT_COPY;
  return err instanceof Error ? err.message : String(err);
}
