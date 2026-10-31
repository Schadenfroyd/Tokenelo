import type { PriceEvidence } from './api-types.js';
export type PriceFieldState = 'unchecked' | 'invalid' | 'conflict' | 'checked';
export function priceFieldState(figure: { events?: number; priceEvidence?: unknown }): PriceFieldState {
  if (figure.priceEvidence === undefined) return 'unchecked';
  if (!figure.priceEvidence || typeof figure.priceEvidence !== 'object') return 'invalid';
  const e = figure.priceEvidence as PriceEvidence;
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (e.version !== 1 || typeof e.aggregateAmountInvalid !== 'boolean'
    || ![e.events, e.invalidAmountEvents, e.unknownStatusEvents, e.statusAmountConflictEvents, e.issuesEvents].every(count)
    || figure.events !== undefined && e.events !== figure.events
    || e.issuesEvents > e.events || [e.invalidAmountEvents, e.unknownStatusEvents, e.statusAmountConflictEvents].some(n => n > e.issuesEvents)
    || e.issuesEvents > e.invalidAmountEvents + e.unknownStatusEvents + e.statusAmountConflictEvents) return 'invalid';
  return e.issuesEvents > 0 || e.aggregateAmountInvalid ? 'conflict' : 'checked';
}
export function priceFieldLabel(figure: { events?: number; priceEvidence?: unknown }): string | null {
  const state = priceFieldState(figure);
  if (state === 'unchecked') return 'Price field checks unavailable';
  if (state === 'invalid') return 'Price field evidence unavailable';
  if (state === 'checked') return null;
  const e = figure.priceEvidence as PriceEvidence;
  return e.aggregateAmountInvalid ? 'Dollar amount unavailable · invalid recorded value'
    : `Price evidence conflicts · ${e.issuesEvents.toLocaleString()} ${e.issuesEvents === 1 ? 'event' : 'events'}`;
}
/** Unknown legacy validation does not erase an existing qualified value; conflicts never show a trusted dollar figure. */
export function priceFieldsUsable(figure: { events?: number; priceEvidence?: unknown }): boolean {
  const state = priceFieldState(figure); return state === 'checked' || state === 'unchecked';
}

/** Missing legacy checks remain unknown; a known conflict on any host prevents a usable fleet dollar value. */
export function aggregatePriceFields(rows: { events?: number; priceEvidence?: unknown }[]): { usable: boolean; priceEvidence?: PriceEvidence } {
  const usable = rows.every(priceFieldsUsable);
  if (rows.some(row => !['checked', 'conflict'].includes(priceFieldState(row)))) return { usable };
  const evidence: PriceEvidence = { version: 1, events: 0, invalidAmountEvents: 0, unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false };
  for (const row of rows) {
    const e = row.priceEvidence as PriceEvidence;
    for (const key of ['events', 'invalidAmountEvents', 'unknownStatusEvents', 'statusAmountConflictEvents', 'issuesEvents'] as const) evidence[key] += e[key];
    evidence.aggregateAmountInvalid ||= e.aggregateAmountInvalid;
  }
  return { usable: usable && priceFieldState({ priceEvidence: evidence }) === 'checked', priceEvidence: evidence };
}

/** Same selected response, no collection or new read. Review retains numeric stored values for inspection only. */
export function priceFieldReview(figure: { events?: number; apiEquivUsd?: number | null; priceEvidence?: unknown }): HTMLElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'evidence-trigger price-field-review';
  button.textContent = 'Review price fields'; button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', event => {
    event.stopPropagation();
    const dialog = document.createElement('dialog'); dialog.className = 'evidence-dialog'; dialog.setAttribute('aria-label', 'Recorded price field checks');
    const title = document.createElement('h2'); title.textContent = 'Recorded price field checks'; dialog.append(title);
    const line = (text: string) => { const p = document.createElement('p'); p.textContent = text; dialog.append(p); };
    const state = priceFieldState(figure);
    if (state === 'invalid' || state === 'unchecked') line('These checks were not supplied in a usable form. Missing checks do not establish that the price fields agree.');
    else {
      const e = figure.priceEvidence as PriceEvidence;
      line(`${e.events.toLocaleString()} ${e.events === 1 ? 'event' : 'events'} in this figure · ${e.issuesEvents.toLocaleString()} ${e.issuesEvents === 1 ? 'event needs' : 'events need'} review.`);
      line(`${e.invalidAmountEvents.toLocaleString()} invalid ${e.invalidAmountEvents === 1 ? 'amount' : 'amounts'} · ${e.unknownStatusEvents.toLocaleString()} unknown price ${e.unknownStatusEvents === 1 ? 'label' : 'labels'} · ${e.statusAmountConflictEvents.toLocaleString()} ${e.statusAmountConflictEvents === 1 ? 'label disagrees' : 'labels disagree'} with recorded amounts.`);
      if (e.aggregateAmountInvalid) line('The combined dollar value is outside the supported numeric range or invalid.');
      line('Some checks overlap. Their counts are not added together.');
    }
    if (typeof figure.apiEquivUsd === 'number' && Number.isFinite(figure.apiEquivUsd)) line(`Stored dollar subtotal for inspection: ${figure.apiEquivUsd.toLocaleString(undefined, { maximumFractionDigits: 8 })} USD.`);
    else line('Stored dollar subtotal is unavailable as a finite number.');
    line('These checks compare stored fields. They do not verify vendor rates or reconcile an invoice. Stored values have not been recalculated.');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'evidence-close'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close()); dialog.append(close);
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, { once: true }); document.body.append(dialog); dialog.showModal();
  });
  button.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); }); return button;
}
