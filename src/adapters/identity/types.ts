// Identity capability (MISSION.md, "Identity"): operator and agent DIDs, with
// agent DIDs delegated from an operator DID, plus DID key sign and verify.
// ed25519 throughout, so the same key serves as DID verification method and
// GitHub commit signer.
import type { Delegation } from '../../domain/agent.js';

export interface DidKeyPair {
  readonly did: string;
  readonly publicKeyMultibase: string;
}

export interface DidDocument {
  readonly id: string;
  readonly controller: string | null;
  readonly verificationMethod: readonly string[];
}

export interface SignedPayload {
  readonly payload: string;
  readonly signature: string;
  readonly signerDid: string;
}

export interface IdentityAdapter {
  createOperatorDid(): Promise<DidKeyPair>;
  // The resulting DID's controller is the operator DID: an agent never
  // stands accountable on its own (MISSION.md, "Who it is for").
  createAgentDid(operatorDid: string): Promise<DidKeyPair>;
  resolveDid(did: string): Promise<DidDocument>;
  sign(did: string, payload: string): Promise<SignedPayload>;
  verify(signed: SignedPayload): Promise<boolean>;
  // R-2: does this delegation proof check out as signed by issuerDid for the
  // agent ownerDid? Total: a malformed or tampered proof is false, never a
  // throw, so the API maps false to 400 without inspecting error messages.
  verifyDelegation(
    delegation: Delegation,
    ownerDid: string,
    issuerDid: string,
  ): Promise<boolean>;
}
