import type { SnapshotFixtureMarker } from './api-types.js';

export const FILED_EXAMPLE_SNAPSHOT_NOTICE =
  'FILED-EXAMPLE: synthetic saved values; not measured usage or invoice evidence. Matching query clocks do not prove a shared live snapshot.';

export function fixtureExampleNotice(marker: SnapshotFixtureMarker): string | null {
  return marker === 'FILED-EXAMPLE' ? FILED_EXAMPLE_SNAPSHOT_NOTICE : null;
}

export function showUsageFixtureInlineNotice(
  usageScope: 'shared-read-transaction' | 'filed-fixture',
  marker: SnapshotFixtureMarker,
): boolean {
  return usageScope === 'filed-fixture' && marker !== 'FILED-EXAMPLE';
}
