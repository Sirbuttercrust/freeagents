// R-23: the identity boundary, as domain policy. Browse and verify need no
// identity (accept clause 1); hiring and listing do (accept clause 2, the
// column derived from hard invariant 7 - ArcBlock is visible, never
// required - and hard invariant 8 - sign-in is GitHub OAuth or a passkey).
//
// This file declares the boundary; it does not authenticate anyone - a
// sign-in provider is a separate, human-seeded subsystem.
//
// Total functions and constants only, in the shape of operator-did.ts: no
// import, so tests/architecture/domain-purity.test.ts holds by construction.

export const SIGN_IN_METHODS = ['github-oauth', 'passkey'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export const CAPABILITIES = ['browse', 'verify', 'hire', 'list'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface IdentityRequirement {
  capability: Capability;
  identityRequired: boolean;
  walletRequired: false;
  signInMethods: SignInMethod[];
  statement: string;
}

// walletRequired is typed as the literal false on every row, including hire
// and list (invariant 7): a future row that tries to set it true fails
// npm run typecheck before it can fail a test.
const POLICY: Readonly<Record<Capability, Omit<IdentityRequirement, 'capability'>>> = {
  browse: {
    identityRequired: false,
    walletRequired: false,
    signInMethods: [],
    statement: 'Browsing agents and operators needs no account. Nothing is hidden behind sign-in.',
  },
  verify: {
    identityRequired: false,
    walletRequired: false,
    signInMethods: [],
    statement:
      'Verifying a credential needs no account. Credentials verify against the issuer DID with any W3C verifier, without calling this service.',
  },
  hire: {
    identityRequired: true,
    walletRequired: false,
    signInMethods: [...SIGN_IN_METHODS],
    statement:
      'Hiring requires an identity, so the buyer on a job is accountable. Sign in with GitHub or a passkey. No wallet is required.',
  },
  list: {
    identityRequired: true,
    walletRequired: false,
    signInMethods: [...SIGN_IN_METHODS],
    statement:
      'Listing an agent requires an identity, so an operator is accountable for the agents they run. Sign in with GitHub or a passkey. No wallet is required.',
  },
};

// Total and never throws: any value in, one boolean out.
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

// A fresh object with a fresh signInMethods array on every call: a caller
// that mutates the returned array must not be able to rewrite the policy
// for everyone else.
export function identityRequirement(capability: Capability): IdentityRequirement {
  const row = POLICY[capability];
  return {
    capability,
    identityRequired: row.identityRequired,
    walletRequired: row.walletRequired,
    signInMethods: [...row.signInMethods],
    statement: row.statement,
  };
}

// One source of truth: this reads identityRequirement rather than a second
// table, so the two can never drift apart.
export function requiresIdentity(capability: Capability): boolean {
  return identityRequirement(capability).identityRequired;
}

// One entry per CAPABILITIES member, in CAPABILITIES order, built by mapping
// CAPABILITIES: adding a capability to the tuple and forgetting its row in
// POLICY is a typecheck failure, not a silent gap.
export function accessPolicy(): IdentityRequirement[] {
  return CAPABILITIES.map((capability) => identityRequirement(capability));
}
