// R-23: the identity boundary as a declared, machine-readable contract.
//
// Today the boundary is real but undeclared: browse and verify routes answer
// anyone, hire and listing routes already refuse a caller who names no DID.
// This module states that boundary as data, so a route (GET /capabilities)
// can publish it and a test can hold it in place, before a user or an agent
// buyer invests any effort finding it out the hard way.

export type AccessLevel = 'public' | 'identified';

export interface Capability {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly access: AccessLevel;
  // Body field naming the acting party, for the one shape of 'identified'
  // route that still has one: account creation, where the caller declares
  // a NEW identity because no proof of it can exist yet (nothing to derive
  // it from). Null for every other 'identified' route: R-39 completion's
  // anchor is "party derived, never declared", so a route acting ON BEHALF
  // of an existing account (hiring, listing an agent) derives that party
  // from the session or R-34 signature presented, and the body carries no
  // caller-identity field for the server to trust or ignore. identityField
  // is therefore NOT simply "non-null iff access is identified" any more;
  // it is non-null only for the bootstrap case a proof cannot yet cover.
  readonly identityField: string | null;
  /** The limit, stated in one sentence a user reads before investing effort. */
  readonly reason: string;
}

// Lifted verbatim from spec/wireframe/signin.html:31 (ASSUMPTIONS ACCESS_NOTICE).
export const ACCESS_NOTICE = 'Browsing needs no account. Sign in to hire, or to list an agent.';

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'capabilities.read',
    method: 'GET',
    path: '/capabilities',
    access: 'public',
    identityField: null,
    reason: 'Reading needs no account: this document exists to be read before signing in.',
  },
  {
    id: 'agent.browse',
    method: 'GET',
    path: '/agents/:agentDid',
    access: 'public',
    identityField: null,
    reason: 'Reading needs no account: anyone can look up an agent record.',
  },
  {
    // R-20: the browse listing. Distinct from 'agent.browse' (one agent's
    // own record) and from 'agent.list' (POST /agents, listing an agent ON
    // the platform): this is GET, reads every listed agent as browse cards.
    id: 'agent.browse.list',
    method: 'GET',
    path: '/agents',
    access: 'public',
    identityField: null,
    reason: 'Reading needs no account: browsing agents by evidence and skill is the point of the marketplace.',
  },
  {
    id: 'operator.browse',
    method: 'GET',
    path: '/accounts/:did',
    access: 'public',
    identityField: null,
    reason: 'Reading needs no account: anyone can look up an operator record.',
  },
  {
    id: 'credential.verify',
    method: 'GET',
    path: '/v1/credentials/:credentialId',
    access: 'public',
    identityField: null,
    reason: 'Reading needs no account: a credential must resolve for a stranger to verify it.',
  },
  {
    id: 'operator.register',
    method: 'POST',
    path: '/accounts',
    access: 'identified',
    identityField: 'did',
    reason: 'Registering records who registered: the request must carry did.',
  },
  {
    id: 'agent.list',
    method: 'POST',
    path: '/agents',
    access: 'identified',
    // R-39 completion: the acting party (who is listing) is derived from
    // the session or signature presented, never read from the body -- see
    // identityField's own doc comment above. `operator` still names the
    // account the new agent is delegated FROM in the request body (that
    // is what the delegation credential itself must bind to), but it is
    // no longer trusted as a claim of WHO is calling; the derived party
    // must equal it, or the route refuses.
    identityField: null,
    reason: 'Listing an agent records who listed it: derived from your session or signature, never from the body.',
  },
  {
    id: 'job.hire',
    method: 'POST',
    path: '/jobs',
    access: 'identified',
    // R-39 completion: the acting party (the buyer) is derived from the
    // session or signature presented, never read from the body.
    identityField: null,
    reason: 'Hiring records who hired: derived from your session or signature, never from the body.',
  },
];

// The reads a third party needs to check a claim without calling back into
// this service (invariant 2). Neither may ever become 'identified': that
// would mean a skeptic could no longer verify without an account of their
// own. tests/api/capabilities-invariant2.test.ts holds this in place.
export const VERIFICATION_CAPABILITY_IDS: readonly string[] = ['agent.browse', 'credential.verify'];

// Matches on the declared route PATTERN, not a concrete URL: capabilityFor
// compares against the same literal path strings the routes are registered
// with (e.g. '/agents/:agentDid'), never against a resolved value like
// '/agents/did:abt:x'. A caller wanting the capability for an actual request
// must pass the route's pattern, not the request's path.
export function capabilityFor(method: string, path: string): Capability | null {
  const upperMethod = method.toUpperCase();
  return CAPABILITIES.find((cap) => cap.method === upperMethod && cap.path === path) ?? null;
}

// An unknown route returns false rather than throwing or defaulting to true.
// This module describes a boundary for disclosure; it does not enforce one.
// A miss here means an incomplete disclosure (a route absent from the
// document), never an opened door: no caller's actual access changes because
// this function returned false.
export function requiresIdentity(method: string, path: string): boolean {
  const cap = capabilityFor(method, path);
  return cap !== null && cap.access === 'identified';
}
