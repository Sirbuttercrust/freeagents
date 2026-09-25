import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // CI4 round 3: one throwaway Chrome launch per `vitest run`, before any
    // test file's own launch and outside every test timeout, so a cold
    // start is not paid inside a test (see tests/helpers/global-setup.ts
    // and warmUpChrome in real-browser.ts).
    globalSetup: ['./tests/helpers/global-setup.ts'],
  },
});
