import type { LimitSnapshot } from './api-types.js';

export interface CodexAccountMetadataCopy {
  plan: string;
  balance: string;
  creditsAvailable: string;
  unlimitedCredits: string;
  footer: string;
}

/**
 * Format only stored Codex account metadata. False collector flags are not enough evidence for
 * a negative claim, and the balance has no recorded unit, so preserve its raw text without a
 * currency marker. DOM callers must render these strings as text nodes.
 */
export function codexAccountMetadataCopy(
  snapshot: Pick<LimitSnapshot, 'source' | 'planType' | 'credits'>,
): CodexAccountMetadataCopy | null {
  if (snapshot.source !== 'codex' || (snapshot.planType === undefined && snapshot.credits === undefined)) return null;

  const planType = typeof snapshot.planType === 'string' && snapshot.planType.trim().length > 0
    ? snapshot.planType
    : 'Not reported';
  const rawBalance = snapshot.credits?.balance;
  const balance = typeof rawBalance === 'string' && rawBalance.trim().length > 0 ? rawBalance : 'Not reported';
  return {
    plan: 'Recorded plan: ' + planType,
    balance: 'Reported balance: ' + balance + ' · unit not recorded',
    creditsAvailable: 'Credits available: ' + (snapshot.credits?.hasCredits === true ? 'Reported' : 'Not confirmed'),
    unlimitedCredits: 'Unlimited credits: ' + (snapshot.credits?.unlimited === true ? 'Reported' : 'Not confirmed'),
    footer: 'Local Codex snapshot · not a live balance check.',
  };
}
