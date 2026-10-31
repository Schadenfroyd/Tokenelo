/**
 * Regenerates the committed test/fixtures/api/*.json files from fixtures.ts (the type-checked
 * source of truth). Run with `npx tsx test/fixtures/api/write-json.ts` after editing fixtures.ts.
 * Not wired into package.json scripts (hard rule: no edits there) — invoke directly, or via
 * test/tray/fixtures-typecheck.test.ts's round-trip check, which fails loudly if these two ever
 * drift apart instead of silently regenerating them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFixtures } from './fixtures.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const [name, data] of Object.entries(allFixtures)) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', name);
}
