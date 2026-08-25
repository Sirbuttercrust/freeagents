// Storage capability: persisting operator records the operator supplied
// (R-1). Named for the capability, not the backend, so a second driver
// (prisma) sits beside it without touching callers. Adapters may import
// domain; never the reverse (CLAUDE.md).
import type { Agent, Delegation, ProofStatus } from '../../domain/agent.js';
import type { CompletedJob, Job } from '../../domain/job.js';
import type { Operator } from '../../domain/operator.js';
import type { VerifiableCredential } from '../credentials/types.js';

// Thrown by register when the DID already exists, so the API layer can map
// it to 409 without inspecting error messages.
export class OperatorAlreadyExistsError extends Error {
  constructor(did: string) {
    super(`operator ${did} already exists`);
    this.name = 'OperatorAlreadyExistsError';
  }
}

export interface OperatorRepository {
  // Throws OperatorAlreadyExistsError when the DID is already registered.
  register(input: { readonly did: string; readonly githubLogin: string }): Promise<Operator>;
  findByDid(did: string): Promise<Operator | null>;
}

// Thrown by AgentRepository.create when the agent DID is already delegated,
// so the API layer maps it to 409 without inspecting error messages.
export class AgentAlreadyExistsError extends Error {
  constructor(did: string) {
    super(`agent ${did} is already delegated`);
    this.name = 'AgentAlreadyExistsError';
  }
}

// Everything the operator supplied or vouched for at delegation time. The
// delegation credential arrives verified (R-2); storage does not re-check it.
export interface AgentInput {
  readonly did: string;
  readonly operatorDid: string;
  readonly delegation: Delegation;
  readonly name: string;
  readonly skills: readonly string[];
  readonly githubLogin: string | null;
}

// One rotation record, in the shape the API accepts (R-30). Carries only
// the public key identifiers in DID fragment form; the driver stamps the
// time. No key material, ever.
export interface KeyRotationInput {
  readonly fromKey: string;
  readonly toKey: string;
}

export interface AgentRepository {
  // Throws AgentAlreadyExistsError when the DID is already delegated.
  create(input: AgentInput): Promise<Agent>;
  findByDid(did: string): Promise<Agent | null>;
  // R-3 direction one: record the GitHub binding the DID document proved.
  // Null when the agent is not stored, so the API maps it to 404 without
  // a second lookup.
  updateGithubBinding(
    did: string,
    input: { readonly handle: string; readonly status: ProofStatus },
  ): Promise<Agent | null>;
  // R-29 (ENT-8.4): append one rotation record to the agent's history.
  // Null when the agent is not stored, mirroring updateGithubBinding, so
  // the API maps it to 404 without a second lookup.
  recordKeyRotation(did: string, input: KeyRotationInput): Promise<Agent | null>;
}

// Thrown by JobRepository.create when the id is already stored, so the API
// layer maps it to 409 without inspecting error messages.
export class JobAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`job ${id} already exists`);
    this.name = 'JobAlreadyExistsError';
  }
}

export interface JobRepository {
  // Throws JobAlreadyExistsError when the id is already stored.
  create(job: Job): Promise<Job>;
  // Null when the job is not stored, so the API maps it to 404 without
  // a second lookup.
  update(job: Job): Promise<Job | null>;
  findById(id: string): Promise<Job | null>;
  complete(job: Job, completedJob: Omit<CompletedJob, 'id'>): Promise<Job | null>;
  findCompletedByJobId(id: string): Promise<CompletedJob | null>;
}

// Thrown by CredentialRepository.save when the job already has a credential,
// so the API layer can map it to 409 without inspecting error messages. One
// credential per completed job: the completed job id is the unique key.
export class CredentialAlreadyIssuedError extends Error {
  constructor(completedJobId: string) {
    super(`job ${completedJobId} already has a work-history credential`);
    this.name = 'CredentialAlreadyIssuedError';
  }
}

// Thrown by the credentials adapter when no stored credential carries the
// requested id, so the API layer maps it to 404 without inspecting error
// messages.
export class CredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`no credential with id ${credentialId}`);
    this.name = 'CredentialNotFoundError';
  }
}

// The lookup key of a credential id: its last non-empty path segment, the
// completed job id the credential attests. A credential id is
// '<base>/v1/credentials/<completedJobId>' (ENT-8: stable, resolvable); a
// caller may hand over the full id or the bare key, and both drivers
// normalize here in exactly one place. An id with no slash is its own key.
export function credentialLookupKey(id: string): string {
  const segments = id.split('/');
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && segment.length > 0) return segment;
  }
  return id;
}

// One work-history credential per completed job (ENT-8). The document goes
// in verbatim: the bytes that verified are the bytes that are stored, so a
// resolved credential keeps verifying off-platform (invariant 2).
export interface CredentialRepository {
  // Throws CredentialAlreadyIssuedError when the job already has a
  // credential.
  save(input: {
    readonly completedJobId: string;
    readonly subjectDid: string;
    readonly document: VerifiableCredential;
  }): Promise<void>;
  // documentId may be the full credential id or its lookup key. Null when
  // no credential carries that id, so the adapter maps it to a 404.
  findByDocumentId(documentId: string): Promise<VerifiableCredential | null>;
}
