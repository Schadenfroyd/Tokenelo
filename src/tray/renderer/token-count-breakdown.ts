import type { TokenCounts } from './api-types.js';
import { countBasisLabel, tokenCountDetails } from './token-counts.js';

/** Same session-history response as the tiles. No new query or inferred missing counts. */
export function tokenCountBreakdown(tokens: TokenCounts, events: number): HTMLElement {
  const evidence = tokenCountDetails(tokens);
  const root = document.createElement('details'); root.className = 'token-count-breakdown';
  const summary = document.createElement('summary'); summary.textContent = 'Recorded token categories'; root.append(summary);
  const line = (text: string) => { const p = document.createElement('p'); p.className = 'label-note'; p.textContent = text; root.append(p); };
  line('Recorded session history. The Sessions list covers its selected date range; these history counts can differ.');
  line(countBasisLabel(tokens, events));
  const total = document.createElement('p'); total.className = 'num token-exact-subtotal';
  total.dataset.exactCount = evidence.subtotal === null ? 'unavailable' : String(evidence.subtotal);
  total.textContent = evidence.subtotal === null ? 'Exact category subtotal unavailable'
    : `${evidence.totalAvailable ? 'Category subtotal' : 'Known category subtotal · complete total unavailable'}: ${evidence.subtotal.toLocaleString()} tokens`;
  root.append(total);
  const list = document.createElement('dl'); list.className = 'token-period-components';
  for (const row of evidence.components) {
    const item = document.createElement('div'); item.dataset.component = row.key;
    const name = document.createElement('dt'); name.textContent = row.label;
    const value = document.createElement('dd'); value.className = 'num'; value.dataset.exactCount = row.value === null ? 'unavailable' : String(row.value);
    value.textContent = row.value === null ? row.note ? 'Unavailable' : 'Not recorded or invalid' : row.value.toLocaleString();
    if (row.note) value.append(' · ' + row.note);
    item.append(name, value); list.append(item);
  }
  root.append(list);
  const count = (value: number | null) => value === null ? 'Not recorded or invalid' : value.toLocaleString();
  line(`Reasoning: ${count(evidence.reasoning)} · subset of output; not added again.`);
  line(`Writes assumed 1 hour: ${count(evidence.assumed1h)} · policy subset of cache writes; not added again.`);
  line('Cache reads are included. Missing or unresolved evidence does not establish complete capture. Compact totals marked ≈ are approximate.');
  return root;
}
