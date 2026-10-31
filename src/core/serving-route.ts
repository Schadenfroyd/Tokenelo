import type { ServingRouteEvidence, UsageComponent } from './types.js';

/** Reported route qualification, never endpoint/runtime attestation. Absence is a legacy policy. */
export type ServingRouteState = 'unrecorded' | 'local-reported' | 'hosted-reported' | 'unknown' | 'invalid' | 'conflict';
export function isServingRouteState(value: unknown): value is ServingRouteState {
  return ['unrecorded', 'local-reported', 'hosted-reported', 'unknown', 'invalid', 'conflict'].includes(value as string);
}
export function reportedRouteState(value: unknown): Exclude<ServingRouteState, 'unrecorded'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'kind' && key !== 'evidence')) return 'invalid';
  if (row.kind === 'local' && row.evidence === 'metered-engine') return 'local-reported';
  if (row.kind === 'hosted' && row.evidence === 'qwen-oauth') return 'hosted-reported';
  if (row.kind === 'unknown' && row.evidence === 'conflicting-reports') return 'conflict';
  if (row.kind === 'unknown' && ['qwen-openai-compatible', 'unrecorded'].includes(row.evidence as string)) return 'unknown';
  return 'invalid';
}
export function componentRouteState(component: Pick<UsageComponent, 'servingRoute'>): ServingRouteState {
  return Object.hasOwn(component, 'servingRoute') ? reportedRouteState(component.servingRoute) : 'unrecorded';
}
export function allowsLocalRatePolicy(state: ServingRouteState): boolean {
  return state === 'unrecorded' || state === 'local-reported';
}

/** JSON must not erase an invalid present value and turn it into the legacy policy. */
export function canonicalizeComponentRoute(component: UsageComponent): UsageComponent {
  return componentRouteState(component) === 'invalid'
    ? { ...component, servingRoute: { kind: 'unknown', evidence: 'invalid' } } : component;
}

/** Missing evidence makes no claim. Retain a supplied claim independent of token winner;
 * incompatible reports or invalid history never become a supported local free rate. */
export function mergeComponentRoute(a: UsageComponent, b: UsageComponent): ServingRouteEvidence | undefined {
  const sa = componentRouteState(a), sb = componentRouteState(b);
  if (sa === 'invalid' || sb === 'invalid') return { kind: 'unknown', evidence: 'invalid' };
  if (sa === 'conflict' || sb === 'conflict') return { kind: 'unknown', evidence: 'conflicting-reports' };
  if (sa === 'unrecorded') return b.servingRoute;
  if (sb === 'unrecorded') return a.servingRoute;
  if (sa !== sb || a.servingRoute!.evidence !== b.servingRoute!.evidence)
    return { kind: 'unknown', evidence: 'conflicting-reports' };
  return a.servingRoute;
}

/** Shared with retained-calibration disclosure. Cloud CLI product names alone do not
 * pin a local runtime; blob/quant/backend/hardware/config or versioned engines do. */
const LOCAL_RUNTIME_FIELDS = ['modelBlobSha256', 'quant', 'numCtx', 'kvCacheType', 'flashAttn', 'backend', 'hardware', 'batch'] as const;
export function pinsLocalRuntime(config: object | undefined): boolean {
  if (!config) return false;
  const c = config as Record<string, unknown>;
  return LOCAL_RUNTIME_FIELDS.some(key => c[key] !== undefined) || typeof c.engine === 'string' && c.engine.includes('@');
}
