import { defineConfig } from 'vitest/config';

export const GPU_TESTS = ['test/parity/**/*.test.ts', ...[
  'arena', 'cameraDevelop', 'device', 'graph', 'lensBlur', 'nativeExposure', 'nativeGraph', 'session', 'tiling',
].map((name) => `test/${name}.test.ts`)];
const group = process.env.DICHROIC_TEST_GROUP;

export default defineConfig({
  test: {
    include: group === 'gpu' ? GPU_TESTS : ['test/**/*.test.ts'],
    exclude: group === 'cpu' ? GPU_TESTS : [],
    // Dawn owns native process-global state. Use a fresh fork per file,
    // serialized so concurrent native GPU instances cannot crash each other.
    // Cold asset preparation and shader compilation need more setup time;
    // these timeouts do not change any numerical parity thresholds.
    testTimeout: process.env.CI ? 120000 : 60000,
    // Asset precomputation and cold Dawn compilation exceeded 10 seconds
    // in repeated local runs. This changes setup time only, never parity gates.
    hookTimeout: process.env.CI ? 120000 : 60000,

    pool: 'forks',
    fileParallelism: false,
    isolate: true,
  },
});
