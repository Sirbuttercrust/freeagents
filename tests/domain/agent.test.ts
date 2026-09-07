// S3+S4 (security sweep): the operator-match comparison two ungated agent
// record routes need. Both routes compare the caller's resolved DID against
// the stored agent's operatorDid, and that comparison must go through
// didSuffix the same way delegationConsistent already does in this file:
// wallet tooling signs with the short-form key hash while the registry
// records the full DID, and a raw string compare would refuse a legitimate
// operator whose caller-side proof resolved to the other form. Total: any
// two strings in, one boolean out, never throws.
import { describe, expect, it } from 'vitest';
import { isAgentOperator } from '../../src/domain/agent.js';

describe('isAgentOperator', () => {
  it('the same DID in the same form matches', () => {
    expect(isAgentOperator('did:abt:zOperatorKeyHash', 'did:abt:zOperatorKeyHash')).toBe(true);
  });

  it('the full form on one side and the short form on the other still matches', () => {
    expect(isAgentOperator('did:abt:zOperatorKeyHash', 'zOperatorKeyHash')).toBe(true);
    expect(isAgentOperator('zOperatorKeyHash', 'did:abt:zOperatorKeyHash')).toBe(true);
  });

  it('a different key does not match', () => {
    expect(isAgentOperator('did:abt:zOperatorKeyHash', 'did:abt:zSomeoneElse')).toBe(false);
  });

  it('is total on garbage: throws nothing, returns false', () => {
    for (const garbage of [null, undefined, 42, {}, []]) {
      expect(() => isAgentOperator(garbage as unknown as string, 'did:abt:zOperatorKeyHash')).not.toThrow();
      expect(isAgentOperator(garbage as unknown as string, 'did:abt:zOperatorKeyHash')).toBe(false);
      expect(() => isAgentOperator('did:abt:zOperatorKeyHash', garbage as unknown as string)).not.toThrow();
      expect(isAgentOperator('did:abt:zOperatorKeyHash', garbage as unknown as string)).toBe(false);
    }
  });
});
