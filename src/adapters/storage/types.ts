// Storage capability: persisting operator records the operator supplied
// (R-1). Named for the capability, not the backend, so a second driver
// (prisma) sits beside it without touching callers. Adapters may import
// domain; never the reverse (CLAUDE.md).
import type { Agent, Delegation, ProofStatus } from '../../domain/agent.js';
import type { CompromiseReport } from '../../domain/compromise.js';
import type { CompletedJob, Job } from '../../domain/job.js';
import type { Account } from '../../domain/account.js';
import type { Review } from '../../domain/review.js';
import type { VerifiableCredential } from '../credentials/types.js';

// Thrown by register when the DID already exists, so the API layer can map
// it to 409 without inspecting error messages.
export class AccountAlreadyExistsError extends Error {
  constructor(did: string) {
    super(`account ${did} already exists`);
    this.name = 'AccountAlreadyExistsError';
  }
}

export interface AccountRepository {
  // Throws AccountAlreadyExistsError when the DID is already registered.
  // passkeySubject is optional: an account may register with a GitHub
  // login only, and bind a passkey subject later. The schema's unique
  // constraint on passkeySubject (prisma/schema.prisma) means a second
  // register naming an already-bound subject throws the same error a
  // duplicate DID would; the caller-facing distinction is not this
  // repository's job (see AccountAlreadyExistsError's single shape).
  register(input: {
    readonly did: string;
    readonly githubLogin: string;
    readonly passkeySubject?: string | null;
  }): Promise<Account>;
  findByDid(did: string): Promise<Account | null>;
  // R-39 completion: session resolution. A GitHub OAuth session names the
  // GitHub login the OAuth exchange proved; this is the ONLY lookup that
  // may resolve a session to an account, because githubLogin is the
  // unique key the schema enforces. Null when no account claims that
  // login, exactly like findByDid on an unknown DID.
  findByGithubLogin(githubLogin: string): Promise<Account | null>;
  // R-39 completion: the passkey sibling of findByGithubLogin. Null when
  // no account claims that passkey subject.
  findByPasskeySubject(passkeySubject: string): Promise<Account | null>;
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
  // R-20: every listed agent, oldest first. Empty for a store with none,
  // never null (D1, ENT-2.4: a zero listing is a zero, not an absence).
  // Optional, mirroring JobRepository.findCompletedByAgent's stance: a
  // hand-rolled stand-in from an unrelated route's tests may omit it, and
  // the browse route treats an omitting driver as storage-unavailable, the
  // same 503 an actual outage produces.
  listAll?(): Promise<readonly Agent[]>;
}

// One compromise report in the shape the API accepts (R-16). The operator
// supplies the key and when the window opens; the driver stamps reportedAt,
// the same way recordKeyRotation stamps rotatedAt. Public key identifiers
// only, never key material.
export interface CompromiseReportInput {
  readonly key: string;
  readonly since: Date;
}

// R-16 (ENT-8.4): append-only compromise reports, a side record beside the
// agent rather than a field on it. Separate from AgentRepository on purpose:
// the report is never part of an Agent projection, because a disputed marker
// inside a signed credential would violate ENT-8.3.
export interface CompromiseRepository {
  // Append one report. Does not check the agent exists: the API route does
  // that lookup, the same way the key-rotation route does.
  record(agentDid: string, input: CompromiseReportInput): Promise<CompromiseReport>;
  // Every report for an agent, oldest first. Empty array when there are none.
  listByAgentDid(agentDid: string): Promise<readonly CompromiseReport[]>;
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
  // R-33: every completed hire for one agent, oldest first (completedAt
  // ascending). Empty array when the agent has none, never null: a zero
  // record renders as a zero, not as an absent one (decision D1). Optional
  // so the hand-rolled JobRepository stand-ins in the job-lifecycle route
  // tests (which never touch hire history) are not forced to grow a method
  // they are never asked to call. Both real drivers (memory.ts, prisma.ts)
  // always implement it; the /hires route treats a stand-in that omits it
  // as storage-unavailable, the same 503 an actual outage produces.
  findCompletedByAgent?(agentDid: string): Promise<readonly CompletedJob[]>;
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

// One stored work-history credential, plus the one fact evidenceTier needs
// that never belongs inside the W3C document itself (repositoryPublic):
// ENT-8.3 forbids a judgement inside the signature envelope, and
// repository visibility is exactly the kind of platform-observed fact that
// travels beside the document the same way subjectDid already does.
export interface StoredCredential {
  readonly document: VerifiableCredential;
  readonly repositoryPublic: boolean;
}

// One work-history credential per completed job (ENT-8). The document goes
// in verbatim: the bytes that verified are the bytes that are stored, so a
// resolved credential keeps verifying off-platform (invariant 2).
export interface CredentialRepository {
  // Throws CredentialAlreadyIssuedError when the job already has a
  // credential. repositoryPublic defaults to false when the caller omits
  // it: an unrecorded visibility fact must never read as verified (R-17,
  // PR 70's rejected finding), so silence fails closed the same direction
  // as a private repository would.
  save(input: {
    readonly completedJobId: string;
    readonly subjectDid: string;
    readonly document: VerifiableCredential;
    readonly repositoryPublic?: boolean;
  }): Promise<void>;
  // documentId may be the full credential id or its lookup key. Null when
  // no credential carries that id, so the adapter maps it to a 404.
  findByDocumentId(documentId: string): Promise<VerifiableCredential | null>;
  // R-17: every credential issued to this agent DID, oldest first, paired
  // with the repositoryPublic fact evidenceTier needs. Empty array for an
  // agent with none, never null and never a throw on an unknown subject:
  // the profile route renders an honest zero (ENT-2.4) rather than
  // branching on absence.
  listBySubjectDid(subjectDid: string): Promise<readonly StoredCredential[]>;
}

// Thrown by ReviewRepository.save when the job already has a review, so the
// API layer can map it to 409 without inspecting error messages (rule 4 of
// R-22, ENT-10.1: one review per completed hire; a second attempt is
// refused, not appended).
export class ReviewAlreadyExistsError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} already has a review`);
    this.name = 'ReviewAlreadyExistsError';
  }
}

// One review per completed job (R-22, ENT-10). The eligibility check
// (completed status, exact buyer, exact agent) happens in the domain layer
// against the Job record before save is ever called; this repository only
// persists what it is handed and refuses a second write for the same job.
export interface ReviewRepository {
  // Throws ReviewAlreadyExistsError when the job already has a review.
  save(review: Review): Promise<void>;
  // Every review on record for an agent, oldest first. Empty array for an
  // agent with none, never null (the same "zero renders as zero" stance
  // every other listing in this file takes).
  listByAgentDid(agentDid: string): Promise<readonly Review[]>;
}

// R-3 + R-4 completion (D2, task t_8a82c865): the durable record of the
// most recent verification method this process has independently checked
// for a DID, through the R-34 signing-key resolver's binding check (the
// same check buildDidAbtLoader performs for a credential proof) AND a
// genuinely verified request signature (D4/D5, task t_8a82c865: the write
// happens from http-signature.ts's verify(), only once the ed25519 bytes
// have checked out, never merely on the binding check over public data).
// A side record, not a field on Agent or Account -- the same separation
// KeyRotation and CompromiseReport already keep from the entity they
// describe -- because this exists so identity.resolveDid and identity.verify
// survive a process restart, not because it belongs to a DID's own
// identity. The anchor (MISSION.md, this card): "a stranger derives the
// same verificationMethod from the keyid whether or not this process
// happened to be running when the agent last signed" -- before this
// interface existed, this process could not either: KnownKeyStore alone is
// an in-memory Map, and a restart between an agent's last signed request
// and POST /jobs/:jobId/merge permanently 503'd the merge, with no
// agent-drivable recovery once the job was submitted.
export interface ObservedKeyRepository {
  // Overwrites any prior entry for this DID, mirroring KnownKeyStore's own
  // stance (did-abt-resolver.ts): a later verified signature is the
  // freshest evidence, never merged with an older one.
  record(did: string, verificationMethod: string): Promise<void>;
  // Null when this DID has never passed the binding check durably.
  get(did: string): Promise<string | null>;
}
