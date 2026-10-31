/** Private count-only review contract. No license grant, public API or privacy certification. */
/** Raw finite nonnegative observations can be fractional/unsafe; usable totals separately require safe integers. */
export type CountField = { state: 'reported'; value: number } | { state: 'missing' | 'invalid'; value: null };
export type CountQuality = 'complete' | 'incomplete' | 'invalid' | 'conflict' | 'unrecorded';
export type CountContainer = 'present' | 'absent' | 'null' | 'malformed';

export interface CountEnvelope {
  kind: 'count-envelope';
  contractVersion: 'tokenelo/count-envelope@v0';
  scope: 'single-caller-selected-component';
  policies: {
    numericObservation: 'tokenelo/claude-observation-parser@v0';
    componentCount: 'tokenelo/claude-component-counts@v2';
    cacheProjection: 'tokenelo/cache-write-projection@v0';
    ttlFallback: 'assume-1h-if-no-ttl-reported';
    countConvention: 'nonnegative-safe-integer';
    componentSelection: 'caller';
    dedup: 'not-applied';
    merge: 'not-applied';
  };
  observations: {
    inputFresh: CountField;
    output: CountField;
    cacheRead: CountField;
    cacheCreation: { flatTotal: CountField; container: CountContainer; ephemeral5m: CountField; ephemeral1h: CountField };
  };
  /** Zero-valued normalized categories do not establish that missing fields were reported. */
  categories: {
    inputFresh: number; output: number; cacheRead: number;
    cacheWrite5m: number; cacheWrite1h: number; cacheWriteUnassigned: number;
    /** Subset of cacheWrite1h; never add it again. */
    cacheWriteAssumed1h: number;
  };
  totals: {
    /** Fresh input + cache creation + cache read + output, each counted once. */
    full: { quality: CountQuality; value: number | null };
    /** Fresh input + cache creation + output. This is a token-count basis, not a valuation. */
    freshWork: { quality: CountQuality; value: number | null };
  };
  cache: {
    exactCreationCount: number | null;
    unassignedTtlCount: number | null;
    ttlBasis: 'reported-ttl' | 'no-cache-work' | 'assumed-1h' | 'unknown-ttl' | 'incomplete' | 'conflict' | 'invalid';
    invalidTtlEvidence: boolean;
  };
}
export type CountEnvelopeResult = CountEnvelope | { kind: 'rejected'; reason: 'component-object-required' | 'iterations-unsupported' };
