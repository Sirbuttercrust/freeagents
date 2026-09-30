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
    // vitest 5 turned clearMocks on by default, which clears every mock's
    // recorded calls before each test. tests/api/server.test.ts records its
    // mocks' calls once at import time, outside any test, so it needs the
    // vitest 2 default (false) to see them.
    clearMocks: false,
  },
});
