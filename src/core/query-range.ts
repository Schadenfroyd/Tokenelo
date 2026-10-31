import type { Range } from './types.js';

/** Inclusive epoch-ms start; 'today' is local midnight, and 'all' has no lower bound. */
export function rangeSince(range: Range, now: number): number | undefined {
  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    case 'all': return undefined;
  }
}
