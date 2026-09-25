// CI4 round 3: Vitest's own docs guarantee globalSetup runs "before the
// test workers are created" (https://vitest.dev/config/globalsetup). It
// runs once per `vitest run`, not once per test file, and it has no test
// timeout, so the cold Chrome start the runner logs show in the opening
// seconds of a job is paid here instead of inside a test's 30s budget.
// See warmUpChrome in real-browser.ts for the evidence and its limits.
import { warmUpChrome } from './real-browser.js';

export default async function setup(): Promise<void> {
  await warmUpChrome();
}
