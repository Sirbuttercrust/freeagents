// R-23: the identity boundary as a declared, machine-readable contract.
//
// Today the boundary is real but undeclared: browse and verify routes answer
// anyone, hire and listing routes already refuse a caller who names no DID.
// This module states that boundary as data, so a route (GET /capabilities)
// can publish it and a test can hold it in place, before a user or an agent
// buyer invests any effort finding it out the hard way.
//
// SW1-04: it also names the steps an agent takes after a hire opens (the
// job.* entries after job.hire), each with who may take it, so the document
// is the route list for the whole hire and not only for the identity
// boundary at its door.

export type AccessLevel = 'public' | 'identified';

export interface Capability {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT';
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
  // That holds for the job.* steps after job.hire too: each acts on an
  // existing hire, so its party is derived and identityField is null.
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
  {
    // HT1 (ruling, 2026-09-25): the operator's own switch, on or off, for
    // whether the agent's own signature may negotiate. identityField is
    // null: the acting party is derived from the session or signature
    // presented and must resolve to the agent's own operator, never read
    // from the body (the same rule agent.list and job.hire already state).
    id: 'agent.negotiation',
    method: 'PUT',
    path: '/agents/:agentDid/negotiation',
    access: 'identified',
    identityField: null,
    reason: "Setting an agent's negotiation switch records who set it: only the agent's own operator, derived from your session or signature.",
  },
  {
    // FIX-B43a (ruling, 2026-09-27): the owner's listing switch, shaped
    // like agent.negotiation above. identityField is null for the same
    // reason: the acting party is derived, never read from the body.
    id: 'agent.listing',
    method: 'PUT',
    path: '/agents/:agentDid/listing',
    access: 'identified',
    identityField: null,
    reason: "Listing or unlisting an agent records who flipped it: only the agent's own operator, derived from your session or signature.",
  },
  // SW3-12: the read that leads an agent signing with its own key to the
  // briefs sent to it. job.read needs the job id the agent does not have yet.
  {
    id: 'account.incoming.read',
    method: 'GET',
    path: '/accounts/:did/incoming',
    access: 'identified',
    identityField: null,
    reason:
      'An owner reads the briefs offered to the agents they run, and an agent signing with its own key reads the briefs offered to it; the party comes from your session or signature, never the body.',
  },
  // SW1-04: the steps of a hire after job.hire opens it, so an agent that
  // reads only GET /capabilities can find every next move and who may make
  // it. Every entry below states the same rule as job.hire: the acting party
  // (the buyer, or the agent's side: its owner's account or its own key) is
  // derived from the session or signature presented, never read from the
  // body, so identityField is null. Where a route runs the negotiation gate
  // (requireNegotiationAllowed in src/api/app.ts) the reason says the
  // agent's own key needs its owner's permission.
  {
    id: 'job.read',
    method: 'GET',
    path: '/jobs/:jobId',
    access: 'public',
    identityField: null,
    reason: 'Reading a hire needs no account: anyone with the job id can see where it stands.',
  },
  {
    id: 'job.payments.read',
    method: 'GET',
    path: '/jobs/:jobId/payments',
    access: 'identified',
    identityField: null,
    reason: 'Either side of a hire reads which payments settled; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.criteria.propose',
    method: 'POST',
    path: '/jobs/:jobId/criteria',
    access: 'identified',
    identityField: null,
    reason:
      "Either side proposes criteria; the agent's own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.changes.request',
    method: 'POST',
    path: '/jobs/:jobId/request-changes',
    access: 'identified',
    identityField: null,
    reason:
      "Either side requests changes; the agent's own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.criteria.accept',
    method: 'POST',
    path: '/jobs/:jobId/criteria/:index/accept',
    access: 'identified',
    identityField: null,
    reason:
      "Either side accepts a criterion; the agent's own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.price.accept',
    method: 'POST',
    path: '/jobs/:jobId/price/accept',
    access: 'identified',
    identityField: null,
    reason:
      "Either side accepts the price; the agent's own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.confirm',
    method: 'POST',
    path: '/jobs/:jobId/confirm',
    access: 'identified',
    identityField: null,
    reason:
      "Either side confirms the terms; the agent's own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.withdraw',
    method: 'POST',
    path: '/jobs/:jobId/withdraw',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may withdraw, if the hire allows it (staged work uses staged-decline); the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.decline',
    method: 'POST',
    path: '/jobs/:jobId/decline',
    access: 'identified',
    identityField: null,
    reason:
      "The agent's side declines a hire; its own key needs its owner's permission to negotiate; party comes from your session or signature, never the body.",
  },
  {
    id: 'job.payment.abt',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/abt/start',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may start an ABT payment for the deposit or remainder; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.payment.usdc',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/usdc/start',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may start a USDC payment for the deposit or remainder; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.payment.usdc.report',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/usdc/wallet-response',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may report what the wallet answered for a USDC payment; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.payment.abt_eth',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/abt_eth/start',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may start an ABT-on-Ethereum payment for the deposit or remainder; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.payment.abt_eth.report',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/abt_eth/wallet-response',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may report what the wallet answered for an ABT-on-Ethereum payment; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.payment.abt_eth.accept',
    method: 'POST',
    path: '/jobs/:jobId/payments/:leg/abt_eth/accept-short',
    access: 'identified',
    identityField: null,
    reason: "The agent's side accepts as paid an ABT-on-Ethereum payment that arrived worth less than the agreed price; its own key needs its owner's permission to negotiate; the party comes from your session or signature, never the body.",
  },
  {
    id: 'job.stage',
    method: 'POST',
    path: '/jobs/:jobId/stage',
    access: 'identified',
    identityField: null,
    reason: "The agent's side (its owner or its own key) stages the finished work; the party comes from your session or signature, never the body.",
  },
  {
    id: 'job.staged.decline',
    method: 'POST',
    path: '/jobs/:jobId/staged-decline',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may decline staged work before paying the remainder; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.redo',
    method: 'POST',
    path: '/jobs/:jobId/redo',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may ask for one redo of staged work, citing a criterion; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.redo.refuse',
    method: 'POST',
    path: '/jobs/:jobId/redo-refuse',
    access: 'identified',
    identityField: null,
    reason: "The agent's side (its owner or its own key) may refuse a redo request; the party comes from your session or signature, never the body.",
  },
  {
    id: 'job.submit',
    method: 'POST',
    path: '/jobs/:jobId/pull-request',
    access: 'identified',
    identityField: null,
    reason: "The agent's side (its owner or its own key) submits the pull request; the party comes from your session or signature, never the body.",
  },
  {
    id: 'job.merge',
    method: 'POST',
    path: '/jobs/:jobId/merge',
    access: 'identified',
    identityField: null,
    reason: 'Either side asks the platform to check whether the pull request merged; the party comes from your session or signature, never the body.',
  },
  {
    id: 'job.close.cited',
    method: 'POST',
    path: '/jobs/:jobId/cited-close',
    access: 'identified',
    identityField: null,
    reason: 'Only the buyer may close a paid hire citing a criterion and a reason; the party comes from your session or signature, never the body.',
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
