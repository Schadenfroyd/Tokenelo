/**
 * The Doctor overlay and its badge (src/tray/renderer/app.ts wires them to the DOM). Pure, so the tests drive it directly.
 *
 * Numbering. Every diagnostic request (an opening from the trigger, a read from the Refresh click, or a background read at boot) takes
 * the next start number. A result applies only by these rules, which order the user's intent against background reads:
 * - An opening applies only if it is still pending when its report arrives. A trigger while pending, Close, Escape, and the Refresh
 *   click cancel it. A background read never cancels it. Its report sets the badge and the overlay together.
 * - A read from the Refresh click applies if it is newer than the report the badge (and an open overlay) shows, and was not retired
 *   by a later click. It updates the badge and, if the overlay is open, its content.
 * - A background read (at boot) applies to the badge only, and only while the overlay is closed. It never changes an open overlay,
 *   so a background response cannot replace the report the user opened.
 * - `retire()` is the Refresh click, called at once. It cancels a pending opening and retires every read that started before it. An
 *   open overlay keeps its last good report until the newest one arrives.
 *
 * Pending cue. The trigger shows its pending state from the start of an opening until that same opening settles: its report or error
 * arrives (the cue clears before the overlay shows), or it is cancelled. Only this file starts and ends a pending opening, and a reply
 * that is no longer the pending one returns before touching the cue, so a late reply cannot clear a newer opening's cue. Reads never
 * touch it.
 *
 * Failures. A failed opening shows a contained error inside the overlay. A failed read rejects to its caller, and keeps the last good
 * badge and the last good overlay content.
 *
 * Tradeoff. A background read that finishes while the overlay is closed sets the badge. An open overlay's badge and content come from
 * one report, and are changed only by the user's opening or by an explicit Refresh.
 */
import type { DoctorReport } from './api-types.js';
import { failureMessage } from './request-failure.js';

/** What the overlay shows: the warnings of a report, or a contained error message. */
export type DoctorContent = { kind: 'report'; report: DoctorReport } | { kind: 'error'; message: string };

/** Who started a read: the Refresh click (it may change an open overlay) or the background read at boot (it may not). */
export type ReadOrigin = 'click' | 'background';

export interface DoctorHost {
  /** Replaces the overlay's content. Does not change whether it is open. */
  renderContent(content: DoctorContent): void;
  /** Opens or closes the overlay, with the matching trigger state and focus. */
  setOpen(open: boolean): void;
  setBadge(hasWarnings: boolean): void;
  /** Shows or clears the trigger's pending cue. Called only when an opening starts or ends pending. */
  setPending(pending: boolean): void;
}

/** A timed-out read shows the timeout copy; any other failure keeps its own message. */
function messageOf(err: unknown): string {
  return failureMessage(err);
}

export class DoctorView {
  /** The number of the most recent diagnostic request started. */
  private starts = 0;
  /** The start number of the pending opening, or null when none is pending. */
  private pendingOpen: number | null = null;
  /** Reads that started before this number were retired by a Refresh click. */
  private retiredBefore = 0;
  /** The start number of the report that the badge (and an open overlay) shows. */
  private shownSeq = 0;
  private open = false;

  constructor(
    private readonly host: DoctorHost,
    private readonly load: () => Promise<DoctorReport>
  ) {}

  isOpen(): boolean {
    return this.open;
  }

  isPending(): boolean {
    return this.pendingOpen !== null;
  }

  /**
   * The trigger. Closes an open overlay. While an opening is pending it cancels that opening, with no new request. Otherwise it
   * starts an opening, which opens when its report arrives if it is still pending.
   */
  async toggle(): Promise<void> {
    if (this.open || this.pendingOpen !== null) {
      this.close();
      return;
    }
    const start = ++this.starts;
    this.pendingOpen = start;
    this.host.setPending(true);
    let content: DoctorContent;
    let report: DoctorReport | null = null;
    try {
      report = await this.load();
      content = { kind: 'report', report };
    } catch (err) {
      content = { kind: 'error', message: messageOf(err) };
    }
    if (this.pendingOpen !== start) return; // cancelled by Close, Escape, a second trigger, or the Refresh click
    this.endPending();
    if (report) {
      this.shownSeq = Math.max(this.shownSeq, start);
      this.host.setBadge(report.warnings.length > 0);
    }
    this.host.renderContent(content);
    this.open = true;
    this.host.setOpen(true);
  }

  /** Dismissal: Close, Escape, or the trigger while pending. Cancels a pending opening, and closes an open overlay. Reads keep going. */
  close(): void {
    if (this.pendingOpen === null && !this.open) return;
    this.endPending();
    if (this.open) {
      this.open = false;
      this.host.setOpen(false);
    }
  }

  /** The Refresh click, called at once rather than after the tab body loads: cancels a pending opening, and retires older reads. */
  retire(): void {
    this.endPending();
    this.retiredBefore = ++this.starts;
  }

  /** Ends the pending opening, if any, and clears the trigger's cue with it. */
  private endPending(): void {
    if (this.pendingOpen === null) return;
    this.pendingOpen = null;
    this.host.setPending(false);
  }

  /**
   * A badge read, from the Refresh click or from the background read at boot. A failed read rejects, and leaves the last good state.
   * Its result applies only by the rules at the top of this file.
   */
  async refreshBadge(origin: ReadOrigin): Promise<void> {
    const start = ++this.starts;
    const report = await this.load();
    if (start < this.retiredBefore || start <= this.shownSeq) return; // retired, or older than the report shown
    if (origin === 'background' && this.open) return; // a background read never changes an open overlay
    this.shownSeq = start;
    this.host.setBadge(report.warnings.length > 0);
    if (this.open) this.host.renderContent({ kind: 'report', report });
  }
}
