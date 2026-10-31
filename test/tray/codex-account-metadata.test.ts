import { describe, expect, it } from 'vitest';
import { codexAccountMetadataCopy } from '../../src/tray/renderer/codex-account-metadata.js';

describe('Codex account snapshot copy', () => {
  it('shows raw plan and balance text without inferring currency or a negative credit claim', () => {
    expect(codexAccountMetadataCopy({
      source: 'codex',
      planType: 'plus',
      credits: { hasCredits: true, unlimited: false, balance: '12.40' },
    })).toEqual({
      plan: 'Recorded plan: plus',
      balance: 'Reported balance: 12.40 · unit not recorded',
      creditsAvailable: 'Credits available: Reported',
      unlimitedCredits: 'Unlimited credits: Not confirmed',
      footer: 'Local Codex snapshot · not a live balance check.',
    });
  });

  it('preserves a literal zero and treats empty stored values and false flags as unconfirmed', () => {
    const copy = codexAccountMetadataCopy({
      source: 'codex',
      planType: '',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    });
    expect(copy?.plan).toBe('Recorded plan: Not reported');
    expect(copy?.balance).toBe('Reported balance: 0 · unit not recorded');
    expect(copy?.creditsAvailable).toBe('Credits available: Not confirmed');
    expect(copy?.unlimitedCredits).toBe('Unlimited credits: Not confirmed');
    expect(copy?.balance).not.toContain('$');
    expect(copy?.balance).not.toContain('USD');
  });

  it('keeps raw plan text intact for the renderer to insert as a text node', () => {
    const rawPlan = '<script>plus</script>';
    const copy = codexAccountMetadataCopy({
      source: 'codex',
      planType: rawPlan,
      credits: { hasCredits: false, unlimited: true, balance: '' },
    });
    expect(copy?.plan).toBe('Recorded plan: ' + rawPlan);
    expect(copy?.balance).toBe('Reported balance: Not reported · unit not recorded');
    expect(copy?.unlimitedCredits).toBe('Unlimited credits: Reported');
  });

  it('omits the optional block for Claude snapshots and Codex snapshots without account fields', () => {
    expect(codexAccountMetadataCopy({ source: 'claude-desktop' })).toBeNull();
    expect(codexAccountMetadataCopy({ source: 'codex' })).toBeNull();
  });
});
