// Storage capability: persisting operator records the operator supplied
// (R-1). Named for the capability, not the backend, so a second driver
// (prisma) sits beside it without touching callers. Adapters may import
// domain; never the reverse (CLAUDE.md).
import type { Agent, Delegation, ProofStatus } from '../../domain/agent.js';
import type { CompletedJob, Job } from '../../domain/job.js';
import type { Operator } from '../../domain/operator.js';

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
