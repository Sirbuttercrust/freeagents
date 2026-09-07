// D3 (QA review round 1, task t_05b14bcc): nextCreated() walks the default
// `created` back one second per call within a wall-clock second so rapid
// same-second test calls don't collide as accidental replays (S5). That
// bucket has a ceiling: once SIGNATURE_MAX_AGE_SECONDS is exhausted, the
// next `created` it would hand out is already stale, so a caller relying
// on the default would get a real, but confusing, "signature rejected"
// failure with no indication the fixture -- not the signature -- is out of
// room. This pins that the fixture fails loudly and by name instead.
//
// D5 (QA review round 2, task t_05b14bcc): the per-second bucket used to
// reset its offset back to zero every time the wall clock ticked over to a
// new second, then walk the SAME descending range again from that new
// second. A call made right after the tick could land on a `created` a
// call before the tick had already handed out, producing byte-identical
// signatures for two genuinely independent calls. This pins that the
// default `created` is never reissued, even across a second boundary.
import { describe, it, expect, vi } from 'vitest';
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

describe('signRequest fixture: default created never repeats across a second boundary (D5)', () => {
  it('does not reissue a created value it already handed out when the wall clock ticks to a new second', async () => {
    const identity = await signingIdentityFromSeed(new Uint8Array(32).fill(5));
    const targetUri = 'http://127.0.0.1:41234/jobs';

    // Reproduces the exact QA probe: a call in second S, then two calls
    // in second S+1. The old bucket reset its offset to zero on the tick
    // into S+1 (created = S+1), then walked back one step for the very
    // next call (created = S+1 - 1 = S), colliding with the first call.
    const secondS = 1788743677;
    const spy = vi.spyOn(Date, 'now');
    try {
      spy.mockReturnValueOnce(secondS * 1000);
      spy.mockReturnValueOnce((secondS + 1) * 1000);
      spy.mockReturnValueOnce((secondS + 1) * 1000 + 500);

      const first = signRequest(identity, 'GET', targetUri);
      const second = signRequest(identity, 'GET', targetUri);
      const third = signRequest(identity, 'GET', targetUri);

      const createdOf = (headers: { readonly 'signature-input': string }): string => {
        const match = headers['signature-input'].match(/;created=(\d+)/);
        if (!match) throw new Error('expected a created parameter');
        return match[1] ?? '';
      };

      const createds = [first, second, third].map(createdOf);
      expect(new Set(createds).size).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});
