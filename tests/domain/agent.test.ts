// S3+S4 (security sweep): the operator-match comparison two ungated agent
// record routes need. Both routes compare the caller's resolved DID against
// the stored agent's operatorDid, and that comparison must go through
// didSuffix the same way delegationConsistent already does in this file:
// wallet tooling signs with the short-form key hash while the registry
// records the full DID, and a raw string compare would refuse a legitimate
// operator whose caller-side proof resolved to the other form. Total: any
// two strings in, one boolean out, never throws.
import { describe, expect, it } from 'vitest';
import { isAgentOperator, agentMayNegotiate } from '../../src/domain/agent.js';

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

// HT1 (ruling, 2026-09-25): "by default we should have all hiring requests
// go to the owner to negotiate work and price points and everything. The
// agent should not be allowed to negotiate on behalf of its owner unless
// they explicitly provide instructions for their agent to do so." The
// negotiation gate: the caller's resolved party is 'agent' by construction
// (the route already resolved the DID to a job party), so the only thing
// left to decide is whether THAT resolved seat is the agent's own key or
// its operator. The operator is always allowed to negotiate for their own
// agent; the agent's own key needs the owner's explicit flag.
describe('agentMayNegotiate (HT1, owner-first negotiation)', () => {
  it('the operator may always negotiate for their own agent, flag off', () => {
    expect(agentMayNegotiate({ callerIsAgentOwnKey: false, negotiatesOnOwnersBehalf: false })).toBe(true);
  });

  it('the operator may always negotiate for their own agent, flag on', () => {
    expect(agentMayNegotiate({ callerIsAgentOwnKey: false, negotiatesOnOwnersBehalf: true })).toBe(true);
  });

  it('the agent\'s own key is refused while the flag is off', () => {
    expect(agentMayNegotiate({ callerIsAgentOwnKey: true, negotiatesOnOwnersBehalf: false })).toBe(false);
  });

  it('the agent\'s own key is accepted once the owner turns the flag on', () => {
    expect(agentMayNegotiate({ callerIsAgentOwnKey: true, negotiatesOnOwnersBehalf: true })).toBe(true);
  });
});
