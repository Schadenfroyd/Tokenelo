import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

/** Declared portable subset, never the original full alpha gate. The historical
 * 3108-case Linux population held five such files; one of them tested a feature
 * this edition no longer has and was removed, so the counts quoted for that
 * population no longer apply to these four. The historical brief
 * reported 53 no-user-bus failures; a current absent-bus full failure count was
 * not rerun. Current source-bound startup refusal and 14 pure cases were checked.
 * Run scripts/check-cloud-portable-report.mjs separately to retain those 14 pure
 * checks. Farm Linux hosts must still run the unchanged default full suite.
 * No timeout, workers, test content or production containment is changed. */
export const nativeReportFiles = [
  'test/daemon/report-linux-unit.test.ts',
  'test/daemon/report-process-framing.test.ts',
  'test/daemon/report-process-tree.test.ts',
  'test/daemon/report-reads.test.ts',
] as const;

export default mergeConfig(baseConfig, defineConfig({
  test: { exclude: [...nativeReportFiles] },
}));
