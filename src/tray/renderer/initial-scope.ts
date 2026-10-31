/** Shared DOM-free scope policy for deep links and snapshot CLI validation. */
import type { Range } from './api-types.js';

export function initialRange(value: string | null): Range {
  return value === '24h' || value === '7d' || value === '30d' || value === 'all' ? value : 'today';
}

export function isRangeScopedTab(tab: string): boolean {
  return ['sessions', 'usage', 'local', 'fleet'].includes(tab);
}
