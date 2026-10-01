// Mirrors src/domain/access.ts (CLAUDE.md: tests mirror the src/ path they
// cover). Pure, no server: this file checks the declared data and the two
// pure helpers, not the route that serves it (tests/api/capabilities.test.ts
// covers that boundary).
import { describe, expect, it } from 'vitest';

import {
  ACCESS_NOTICE,
  CAPABILITIES,
  capabilityFor,
  requiresIdentity,
} from '../../src/domain/access.js';

describe('CAPABILITIES', () => {
  it('every entry has a non-empty id and reason, and a path starting with /', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.id.length).toBeGreaterThan(0);
      expect(cap.reason.length).toBeGreaterThan(0);
      expect(cap.path.startsWith('/')).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(CAPABILITIES.length);
  });

  // R-39 completion: identityField is no longer "non-null iff identified".
  // Only account.register still declares one (the bootstrap case: no proof
  // of the not-yet-existing account can exist), the exact set the domain
  // comment above documents. This test pins that narrower invariant
  // instead of the old "every identified route names a field" one, which
  // stopped being true the moment agent.list and job.hire started
  // deriving their party server-side instead of reading it from the body.
  const BOOTSTRAP_IDS_WITH_IDENTITY_FIELD = new Set(['operator.register']);
  it('identityField is non-null only for the bootstrap capability that creates an account', () => {
    for (const cap of CAPABILITIES) {
      if (BOOTSTRAP_IDS_WITH_IDENTITY_FIELD.has(cap.id)) {
        expect(cap.identityField).not.toBeNull();
      } else {
        expect(cap.identityField).toBeNull();
      }
    }
  });

  it('pins every declared capability exactly: id, method, path, access, identityField', () => {
    // Unlike the shape checks above, this pins the literal published
    // values. Those values are read by callers (e.g. which body field
    // names the acting party) and by tests/api/capabilities.test.ts's
    // VALID_BODY_MINUS_IDENTITY fixture, which is keyed by cap.id rather
    // than derived from cap.identityField - so a wrong identityField value
    // (or a wrong path, method, or access) would otherwise fail no test.
    expect(CAPABILITIES.map(({ id, method, path, access, identityField }) => ({ id, method, path, access, identityField }))).toEqual([
      { id: 'capabilities.read', method: 'GET', path: '/capabilities', access: 'public', identityField: null },
      { id: 'agent.browse', method: 'GET', path: '/agents/:agentDid', access: 'public', identityField: null },
      { id: 'agent.browse.list', method: 'GET', path: '/agents', access: 'public', identityField: null },
      { id: 'operator.browse', method: 'GET', path: '/accounts/:did', access: 'public', identityField: null },
      { id: 'credential.verify', method: 'GET', path: '/v1/credentials/:credentialId', access: 'public', identityField: null },
      { id: 'operator.register', method: 'POST', path: '/accounts', access: 'identified', identityField: 'did' },
      { id: 'agent.list', method: 'POST', path: '/agents', access: 'identified', identityField: null },
      { id: 'job.hire', method: 'POST', path: '/jobs', access: 'identified', identityField: null },
      { id: 'agent.negotiation', method: 'PUT', path: '/agents/:agentDid/negotiation', access: 'identified', identityField: null },
      { id: 'agent.listing', method: 'PUT', path: '/agents/:agentDid/listing', access: 'identified', identityField: null },
      // SW3-12: account.incoming.read joined after agent.listing, so an
      // agent signing with its own key can find the briefs sent to it
      // without a job id.
      { id: 'account.incoming.read', method: 'GET', path: '/accounts/:did/incoming', access: 'identified', identityField: null },
      // SW1-04: the list grew by 18 because GET /capabilities stopped at
      // job.hire, so an agent reading only it had no declared step after
      // opening a hire. job.payments.read, the party-only read of which
      // payments settled, made it 19.
      { id: 'job.read', method: 'GET', path: '/jobs/:jobId', access: 'public', identityField: null },
      { id: 'job.payments.read', method: 'GET', path: '/jobs/:jobId/payments', access: 'identified', identityField: null },
      { id: 'job.criteria.propose', method: 'POST', path: '/jobs/:jobId/criteria', access: 'identified', identityField: null },
      { id: 'job.changes.request', method: 'POST', path: '/jobs/:jobId/request-changes', access: 'identified', identityField: null },
      { id: 'job.criteria.accept', method: 'POST', path: '/jobs/:jobId/criteria/:index/accept', access: 'identified', identityField: null },
      { id: 'job.price.accept', method: 'POST', path: '/jobs/:jobId/price/accept', access: 'identified', identityField: null },
      { id: 'job.confirm', method: 'POST', path: '/jobs/:jobId/confirm', access: 'identified', identityField: null },
      { id: 'job.withdraw', method: 'POST', path: '/jobs/:jobId/withdraw', access: 'identified', identityField: null },
      { id: 'job.decline', method: 'POST', path: '/jobs/:jobId/decline', access: 'identified', identityField: null },
      { id: 'job.payment.abt', method: 'POST', path: '/jobs/:jobId/payments/:leg/abt/start', access: 'identified', identityField: null },
      { id: 'job.payment.usdc', method: 'POST', path: '/jobs/:jobId/payments/:leg/usdc/start', access: 'identified', identityField: null },
      { id: 'job.payment.usdc.report', method: 'POST', path: '/jobs/:jobId/payments/:leg/usdc/wallet-response', access: 'identified', identityField: null },
      { id: 'job.stage', method: 'POST', path: '/jobs/:jobId/stage', access: 'identified', identityField: null },
      { id: 'job.staged.decline', method: 'POST', path: '/jobs/:jobId/staged-decline', access: 'identified', identityField: null },
      { id: 'job.redo', method: 'POST', path: '/jobs/:jobId/redo', access: 'identified', identityField: null },
      { id: 'job.redo.refuse', method: 'POST', path: '/jobs/:jobId/redo-refuse', access: 'identified', identityField: null },
      { id: 'job.submit', method: 'POST', path: '/jobs/:jobId/pull-request', access: 'identified', identityField: null },
      { id: 'job.merge', method: 'POST', path: '/jobs/:jobId/merge', access: 'identified', identityField: null },
      { id: 'job.close.cited', method: 'POST', path: '/jobs/:jobId/cited-close', access: 'identified', identityField: null },
    ]);
  });
});

describe('capabilityFor', () => {
  it('matches a declared route pattern by method and path', () => {
    expect(capabilityFor('GET', '/agents/:agentDid')?.id).toBe('agent.browse');
  });

  it('matches the method case-insensitively', () => {
    expect(capabilityFor('get', '/agents/:agentDid')?.id).toBe('agent.browse');
  });

  it('does not match a concrete URL: it compares route patterns, not resolved paths', () => {
    expect(capabilityFor('GET', '/agents/did:abt:concrete')).toBeNull();
  });

  it('does not match a declared path under the wrong method', () => {
    // '/agents/:agentDid' is declared, but only under GET (agent.browse).
    // A method comparison that is dropped would let this fall through to
    // that entry on path alone.
    expect(capabilityFor('POST', '/agents/:agentDid')).toBeNull();
  });
});

describe('requiresIdentity', () => {
  it('is true for POST /jobs', () => {
    expect(requiresIdentity('POST', '/jobs')).toBe(true);
  });

  it('is true for POST /agents', () => {
    expect(requiresIdentity('POST', '/agents')).toBe(true);
  });

  it('is false for GET /agents/:agentDid', () => {
    expect(requiresIdentity('GET', '/agents/:agentDid')).toBe(false);
  });

  it('is false for an unknown route', () => {
    expect(requiresIdentity('GET', '/nope')).toBe(false);
  });

  it('is false for a declared path under the wrong method', () => {
    // '/jobs' is declared only under POST (job.hire, identified). Dropping
    // the method comparison inside capabilityFor would let this match on
    // path alone and report true.
    expect(requiresIdentity('GET', '/jobs')).toBe(false);
  });
});

describe('ACCESS_NOTICE', () => {
  it('is non-empty and states both halves of the boundary', () => {
    // R-23's third clause is that the limit is stated; an empty or
    // one-sided notice states nothing.
    expect(ACCESS_NOTICE.length).toBeGreaterThan(0);
    expect(ACCESS_NOTICE).toContain('no account');
    expect(ACCESS_NOTICE).toContain('hire');
    expect(ACCESS_NOTICE).toContain('list');
  });
});
