import { createApp } from './app.js';
import { resolveListenPort } from '../adapters/runtime/runtime.js';
import { buildConfigReport, formatConfigReport, probeGithubTokenScope, formatGithubScopeLine } from '../adapters/config/report.js';
import { platformIssuerFromEnv } from '../adapters/credentials/credentials.js';

const port = resolveListenPort();

// P9: printed once, at startup, additive to every rail's own call-time
// fail-closed guard. This never throws and never exits the process; an
// operator who wants to run without USDC configured is told plainly that
// the USDC rail is off, not stopped from running.
//
// ISS1 (bugs.md B30): the issuer DID is resolved once here, through the
// exact same platformIssuerFromEnv the credentials adapter itself defaults
// to, so the DID printed at boot is provably the DID this process signs
// with, never a second computation that could drift from it. Resolution
// is async (a real key derivation), so the report line prints after one
// await; nothing else in this file's startup sequence is affected.
platformIssuerFromEnv()
  .then((issuer) => {
    console.log(formatConfigReport(buildConfigReport(), issuer.did));
  })
  .catch((err: unknown) => {
    console.error('startup: failed to derive the platform issuer DID for the configuration report', err);
    console.log(formatConfigReport(buildConfigReport()));
  });

// B14a: the live github token scope probe, additive to the report above.
// A probe failure (network unreachable, DNS) must not block startup any
// more than an unconfigured rail does -- caught and logged as its own
// line, the same fail-quiet-not-fail-loud stance the report already
// takes for every other capability.
probeGithubTokenScope()
  .then((probe) => {
    console.log(formatGithubScopeLine(probe));
  })
  .catch((err: unknown) => {
    console.error('startup: github token scope probe failed', err);
  });

createApp().listen(port, () => {
  console.log(`freeagents listening on port ${port}`);
});
