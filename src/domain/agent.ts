// An operator has built an agent and wants its identity to be worth
// something (ENT-2): the agent DID, plus the delegation proof that binds it
// to the operator DID (ENT-3). The agent DID is the primary key: it is what
// a third party verifies against, not an internal id.
import type { KeyRotation } from './key-rotation.js';
import type { AvatarSpec } from './avatar-spec.js';

// ENT-3, in the shape the operator's wallet produced it. The stored object
// is the FULL credential, not a projection of it: drop the proof signature
// and the stored copy stops verifying off-platform (ENT-3.1). This is a W3C
// Verifiable Credential with Ed25519Signature2020 proof (MISSION.md invariant 2).
export interface Delegation {
  readonly '@context': readonly (string | Record<string, unknown>)[];
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly issuanceDate: string;
  readonly credentialSubject: { readonly id: string; readonly [key: string]: unknown };
  readonly proof: {
    readonly type: string;
    readonly created: string;
    readonly verificationMethod: string;
    readonly proofPurpose: string;
    readonly proofValue: string;
  };
}

// The one type tag this service understands on a delegation credential.
// Product value, recorded in the run report: the spec does not name it.
export const DELEGATION_TYPE = 'AgentDelegation';

// Wallet tooling signs with the short-form key hash (z...) while the
// registry records the full DID (did:abt:z...). Both name the same key, and
// a credential's issuer or subject may arrive in either form, so every
// comparison in this file goes through this reconciliation. Total.
export function didSuffix(did: string): string {
  return did.startsWith('did:abt:') ? did.slice('did:abt:'.length) : did;
}

// S3+S4 (security sweep): the operator-match check every write route on an
// agent's own record needs. Goes through didSuffix, never raw equality, for
// the same reason delegationConsistent does above: a caller-side proof can
// resolve to either form of the same key. Total: any two strings in, one
// boolean out, never throws, so a route can call this with no try/catch.
export function isAgentOperator(actingDid: unknown, operatorDid: unknown): boolean {
  if (typeof actingDid !== 'string' || actingDid.length === 0) return false;
  if (typeof operatorDid !== 'string' || operatorDid.length === 0) return false;
  return didSuffix(actingDid) === didSuffix(operatorDid);
}

// B14a / FIX-B36 (Proof r3): the one function that decides whether an
// agent has a GitHub login a buyer can be told to grant access to. A
// login is nameable only once verified through one of G1's two paths
// (ProofStatus below); an absent login, or one that was merely claimed
// and never verified, names nothing -- there is no account yet proven to
// belong to the agent, so pointing a buyer at it would ask for a grant
// nobody could make good on. confirm's own grantPush guard, the ORG1
// projection and the three deposit-start doors' not-visible message all
// go through this one function so the rule cannot drift between them.
export function verifiedGithubLogin(agent: Pick<Agent, 'githubLogin' | 'proofStatus'> | null): string | null {
  if (agent === null || agent.githubLogin === null || agent.proofStatus !== 'verified') return null;
  return agent.githubLogin;
}

// HT1 (ruling, 2026-09-25): "by default we should have all hiring requests
// go to the owner to negotiate work and price points and everything. The
// agent should not be allowed to negotiate on behalf of its owner unless
// they explicitly provide instructions for their agent to do so." Total:
// two booleans in, one boolean out, never throws. The caller already
// resolved the acting DID to the 'agent' seat on the job (partyForDid);
// this function answers the one remaining question -- whether that seat
// was reached through the agent's OWN key or through its operator -- so
// the negotiation routes can refuse the agent's own signature while the
// owner's flag is off, without duplicating the flag check at every route.
export function agentMayNegotiate(input: {
  readonly callerIsAgentOwnKey: boolean;
  readonly negotiatesOnOwnersBehalf: boolean;
}): boolean {
  if (!input.callerIsAgentOwnKey) return true;
  return input.negotiatesOnOwnersBehalf;
}

// G1 (ENT-5.1, ruling 2026-09-23): two paths, either sufficient alone -- a
// binding is either verified through one whole path (session or gist) or
// it is unverified. No in-between state.
export type ProofStatus = 'unverified' | 'verified';

export interface Agent {
  readonly did: string;
  readonly operatorDid: string;
  readonly delegation: Delegation;
  readonly name: string;
  // ENT-2: one line describing the agent, trimmed, 1 to 160 characters, no
  // line break, checked by descriptionWellFormed below. Null when the
  // operator never set one -- the same "absent, not an empty claim"
  // stance every other optional Agent field in this file already takes.
  readonly description: string | null;
  readonly skills: readonly string[];
  readonly githubLogin: string | null;
  readonly proofStatus: ProofStatus;
  readonly createdAt: Date;
  // ENT-8.4: append-only rotation history, the record that keeps a
  // credential signed by a superseded key verifiable.
  readonly keyRotations: readonly KeyRotation[];
  // P1, scope item 5 (MAP.md): the optional floor an agent will not go
  // below. Decimal string like priceUsd, never a float, and never a
  // platform-suggested price (locked: no blended numbers, no leaderboard) --
  // this is the agent's own stated minimum, nothing more. Null when the
  // agent has not set one, which places no floor on a proposal at all.
  readonly floorPriceUsd: string | null;
  // P7: the operator's own listing filters on buyer conduct (committee
  // synthesis row 7). Both null by default: null means no filter is set,
  // and the platform sets no default and suggests no value.
  readonly minBuyerMerges: number | null;
  // DEP1 (B24 ruling, 2026-09-23): this filter's meaning
  // narrowed. walkedAfterConfirm no longer counts expired_unstaged (an
  // agent lapse, now the operator's own walkedAfterDeposit count
  // instead), so this threshold now refuses only buyers who WITHDREW
  // from a confirmed job themselves. That narrowing is intended, not a
  // regression: the field is unrenamed, and an operator who set it
  // before this ruling keeps refusing the exact same buyer behaviour
  // (withdrawing after confirm), just no longer a behaviour that was
  // never the buyer's to begin with.
  readonly maxWalkedAfterConfirm: number | null;
  // AV1 (ENT-2.3 ruling): the operator's stored override on shape, face and
  // colour. Null by default, meaning "no override, render the DID-derived
  // default" -- resolveAvatar (src/domain/avatar-spec.ts) is the one place
  // that turns this optional field plus the agent's own DID into the
  // AvatarSpec a response actually carries.
  readonly avatarSpec: AvatarSpec | null;
  // HT1 (ruling, 2026-09-25): off by default. While false, the negotiation
  // routes (propose criteria/price, request-changes, criteria accept,
  // price accept, confirm, decline before confirm, posting a message)
  // refuse a request signed by the agent's OWN did; the operator's session
  // or signature is always accepted there regardless of this flag. The
  // operator sets this on their own agent through the existing
  // operator-gated update path (requireCallerIsAgentOperator). The floor
  // (floorPriceUsd) still binds an autonomous agent once this is true.
  readonly negotiatesOnOwnersBehalf: boolean;
  // HT1 Part B (STEER item 4, 2026-09-25): the operator's own optional
  // webhook, set through PUT /agents/:agentDid/negotiation's sibling
  // route (PATCH /agents/:agentDid/notify-webhook). Null means unset --
  // the agent's own autonomous software is never contacted (STEER's own
  // final rule: "never unless its operator both enabled negotiation AND
  // set the webhook").
  readonly notifyWebhookUrl: string | null;
}

// ENT-2: the one-line description rule this card's spec states verbatim --
// "trimmed, 1 to 160 characters, no line break". Total: any value in, one
// boolean out, never throws. Undefined and null both pass (the field is
// optional on both POST /agents and PATCH /agents/:agentDid); a caller that
// supplies anything else must supply a string meeting the rule exactly, so
// a stray leading/trailing space or an embedded newline is refused rather
// than silently trimmed away and stored differently from what was checked.
export function descriptionWellFormed(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  if (value !== value.trim()) return false;
  if (value.length < 1 || value.length > 160) return false;
  if (value.includes('\n') || value.includes('\r')) return false;
  return true;
}

// The structural half of "the delegation proof verifies" (R-2 accept). The
// cryptographic half runs in the identity adapter, because it needs the
// cryptographic machinery; this is the half that must never throw on a
// half-built or stored record, so an agent can be re-checked (ENT-2.4)
// without a try/catch at the call site. Total: any value in, one boolean out.
export function delegationConsistent(
  agent: Pick<Agent, 'did' | 'operatorDid' | 'delegation'>,
): boolean {
  const did = agent.did;
  const operatorDid = agent.operatorDid;
  const delegation = agent.delegation;
  if (typeof did !== 'string' || did.length === 0) return false;
  if (typeof operatorDid !== 'string' || operatorDid.length === 0) return false;
  if (typeof delegation !== 'object' || delegation === null) return false;
  if (!Array.isArray(delegation.type) || !delegation.type.includes(DELEGATION_TYPE)) {
    return false;
  }
  if (typeof delegation.issuer !== 'string' || delegation.issuer.length === 0) return false;
  if (didSuffix(delegation.issuer) !== didSuffix(operatorDid)) return false;
  if (typeof delegation.credentialSubject?.id !== 'string' || delegation.credentialSubject.id.length === 0) {
    return false;
  }
  if (didSuffix(delegation.credentialSubject.id) !== didSuffix(did)) return false;
  if (typeof delegation.proof?.type !== 'string' || delegation.proof.type !== 'Ed25519Signature2020') {
    return false;
  }
  if (typeof delegation.proof?.proofValue !== 'string' || delegation.proof.proofValue.length === 0) {
    return false;
  }
  if (typeof delegation.issuanceDate !== 'string' || Number.isNaN(Date.parse(delegation.issuanceDate))) {
    return false;
  }
  return true;
}
