import { createApp } from './app.js';
import { resolveListenPort } from '../adapters/runtime/runtime.js';
import { buildConfigReport, formatConfigReport, probeGithubTokenScope, formatGithubScopeLine } from '../adapters/config/report.js';
import { createCredentialsAdapter } from '../adapters/credentials/credentials.js';
import { createCredentialRepository } from '../adapters/storage/storage.js';

const port = resolveListenPort();

// P9: printed once, at startup, additive to every rail's own call-time
// fail-closed guard. This never throws and never exits the process; an
// operator who wants to run without USDC configured is told plainly that
// the USDC rail is off, not stopped from running.
//
// ISS1 (bugs.md B30, review round 1): the credentials adapter is built
// ONCE, here, and handed straight into createApp below -- both the
// adapter itself and the credential repository it shares with the app's
// other credential reads and writes. That makes exactly one call to
// platformIssuerFromEnv for the whole process. Before this, server.ts
// resolved its own issuer for the report line while createApp's default
// argument built a second, independent credentials adapter with its own
// call to platformIssuerFromEnv; with no seed configured that mints a
// fresh random ephemeral key per call, so the boot report could print
// one DID while the running app signed with, and served at
// /.well-known/freeagents-issuer.json, a different one. describeIssuer()
// below awaits this adapter's own memoized issuer promise, so the DID in
// the report is provably the DID this process actually signs with, and
// the FREEAGENTS_PLATFORM_SEED / FREEAGENTS_PLATFORM_DID warnings each
// fire at most once per boot rather than once per derivation.
//
// Resolution is async (a real key derivation), so the report line prints
// after one await; nothing else in this file's startup sequence is
// affected.
const credentialRepo = createCredentialRepository();
const credentialsAdapter = createCredentialsAdapter(undefined, credentialRepo);

credentialsAdapter
  .describeIssuer()
  .then((description) => {
    console.log(formatConfigReport(buildConfigReport(), description.issuer));
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

// ISS1: credentials and credentialRepo are the SAME instances the report
// above resolves its issuer from. Every other createApp argument keeps
// its own env-derived default (this file passes undefined for each),
// exactly as an omitted argument would.
createApp(undefined, undefined, undefined, undefined, undefined, credentialsAdapter, undefined, credentialRepo).listen(
  port,
  () => {
    console.log(`freeagents listening on port ${port}`);
  },
);
