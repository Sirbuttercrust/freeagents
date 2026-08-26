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
