# Manual harness

Not part of `npm test`. Vitest collects `tests/**/*.test.ts`, and nothing in
here matches that pattern, so these files never run in the suite.

They exist because the pages are wired to real API routes, and reviewing them
against typed-in fixtures proves nothing. `seed-server.ts` starts the app with
a stubbed GitHub adapter and a DID resolver, then `seed.ts` drives an entire
hire from operator registration through merge, so the agent, credential and
verify pages render values the API actually produced.

```
PORT=3141 npx tsx tests/manual/seed-server.ts     # one terminal
npx tsx tests/manual/seed.ts                      # another, prints the URLs
```

The GitHub adapter is stubbed rather than mocked at the HTTP layer: the merge
leg needs a pull request that is merged with a verified signature, and hitting
the real API would make the harness depend on a network and on somebody's
repository staying merged.

Credentials issued here are signed with an ephemeral key, so they stop
verifying when the server restarts. That is the dev-mode warning the server
prints on startup, not a defect in the seed.
