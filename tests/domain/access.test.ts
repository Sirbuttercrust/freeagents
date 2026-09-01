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

  it('identityField is non-null exactly when access is identified', () => {
    for (const cap of CAPABILITIES) {
      if (cap.access === 'identified') {
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
      { id: 'agent.list', method: 'POST', path: '/agents', access: 'identified', identityField: 'operator' },
      { id: 'job.hire', method: 'POST', path: '/jobs', access: 'identified', identityField: 'buyerDid' },
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
