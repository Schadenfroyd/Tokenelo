export type SnapshotFixtureMarker = 'FILED-EXAMPLE' | null;
export type SnapshotSourceMode = 'fixtures' | 'live' | null;

/** Main-process source decision reduced to one fixed renderer label, never a path or credential. */
export function snapshotFixtureMarker(snapshotMode: boolean, sourceMode: SnapshotSourceMode): SnapshotFixtureMarker {
  return snapshotMode && sourceMode === 'fixtures' ? 'FILED-EXAMPLE' : null;
}
