import {defineConfig,mergeConfig} from 'vitest/config';
import cloud from './vitest.cloud.config.js';

// Additional observation only: retain the exact existing portable population,
// worker count, assertions, per-case timeout and external 180-second budget.
export default mergeConfig(cloud,defineConfig({
  test:{setupFiles:['./scripts/cloud-bootstrap-observer.setup.mjs']},
}));
