// D3 (QA review round 1, task t_05b14bcc): nextCreated() walks the default
// `created` back one second per call within a wall-clock second so rapid
// same-second test calls don't collide as accidental replays (S5). That
// bucket has a ceiling: once SIGNATURE_MAX_AGE_SECONDS is exhausted, the
// next `created` it would hand out is already stale, so a caller relying
// on the default would get a real, but confusing, "signature rejected"
// failure with no indication the fixture -- not the signature -- is out of
// room. This pins that the fixture fails loudly and by name instead.
import { describe, it, expect } from 'vitest';
import { signingIdentityFromSeed, signRequest } from './sign-request.js';

describe('signRequest fixture: default created bucket (D3)', () => {
  it('throws a named fixture-exhausted error rather than silently handing out a stale created', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(3));
    const targetUri = 'http://127.0.0.1:41234/jobs';

    expect(() => {
      for (let i = 0; i < 400; i += 1) {
        signRequest(identity, 'GET', targetUri);
      }
    }).toThrow(/signRequest: fixture bucket exhausted/);
  });
});
