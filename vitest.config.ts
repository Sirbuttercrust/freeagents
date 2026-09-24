import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // CI4 round 3: pays Chrome's one-time page-cache-miss cost exactly
    // once per `vitest run`, before any test file's own launch runs and
    // before any test's own timeout starts (see
    // tests/helpers/global-setup.ts and real-browser.ts's warmUpChrome).
    globalSetup: ['./tests/helpers/global-setup.ts'],
  },
});
