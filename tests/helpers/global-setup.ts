// CI4 round 3: Vitest's own docs guarantee globalSetup runs "before the
// test workers are created" (https://vitest.dev/config/globalsetup), which
// is what makes this the right place to pay Chrome's one-time page-cache
// cost. It runs in a separate global scope from every test worker, once
// per `vitest run` invocation, not once per test file, so the cost is
// genuinely paid once per CI job rather than once per file.
//
// See tests/helpers/real-browser.ts's warmUpChrome for the measured
// mechanism this exists to remove: a job's first real Chrome exec pays
// for populating the OS page cache with Chrome's binary and shared
// libraries (8925-18961ms across every CI4 measurement push), and every
// later launch in the same job reads the now-resident pages (300-900ms).
import { warmUpChrome } from './real-browser.js';

export default async function setup(): Promise<void> {
  await warmUpChrome();
}
