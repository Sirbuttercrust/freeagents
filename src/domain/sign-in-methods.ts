// Issue 84: the sign-in methods a user may choose, declared as data rather
// than left implicit in the auth code path. This module authenticates
// nobody: it states what exists and which methods are ever mandatory, the
// same way src/domain/access.ts states the identity boundary without
// enforcing it.

export interface SignInMethod {
  readonly id: string;
  readonly label: string;
  /** True iff this method is one of the paths a user must be able to reach sign-in through. */
  readonly required: boolean;
  readonly walletBased: boolean;
  /** The fact or limit stated in one sentence, lifted from copy where copy exists. */
  readonly reason: string;
}

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  {
    id: 'github',
    label: 'Continue with GitHub',
    required: true,
    walletBased: false,
    reason: 'One of the two sign-in paths named in MISSION.md invariant 8: GitHub OAuth or a passkey.',
  },
  {
    id: 'passkey',
    label: 'Use a passkey',
    required: true,
    walletBased: false,
    reason: 'One of the two sign-in paths named in MISSION.md invariant 8: GitHub OAuth or a passkey.',
  },
  // Lifted verbatim from spec/wireframe/signin.html:41 (button label) and
  // spec/wireframe/signin.html:43 (the line below it). Never required:
  // MISSION.md invariant 7, "ArcBlock is visible, never required."
  {
    id: 'wallet',
    label: 'Sign in with a DID Wallet',
    required: false,
    walletBased: true,
    reason: 'Optional. Your identity is yours from the first click.',
  },
];

// Total: an unknown id returns null rather than throwing, the same contract
// as src/domain/access.ts's capabilityFor.
export function signInMethodFor(id: string): SignInMethod | null {
  return SIGN_IN_METHODS.find((method) => method.id === id) ?? null;
}
