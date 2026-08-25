// In-memory OperatorRepository: real storage for dev and tests, and the selected
// mode when DATABASE_URL is unset (see storage.ts). A Map keyed by DID gives the
// same duplicate-key semantics the database gives through its primary key.
import type { Agent, ProofStatus } from '../../domain/agent.js';
import type { CompletedJob, Job } from '../../domain/job.js';
import type { Operator } from '../../domain/operator.js';
import type { KeyRotation } from '../../domain/key-rotation.js';
import type { VerifiableCredential } from '../credentials/types.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
  CredentialAlreadyIssuedError,
  type CredentialRepository,
  JobAlreadyExistsError,
  type JobRepository,
  type KeyRotationInput,
  OperatorAlreadyExistsError,
  type OperatorRepository,
  credentialLookupKey,
} from './types.js';

export class MemoryOperatorRepository implements OperatorRepository {
  private readonly rows = new Map<string, Operator>();

  async register(input: {
    readonly did: string;
    readonly githubLogin: string;
  }): Promise<Operator> {
    // Check-then-set is safe here: Node is single-threaded and this method awaits
    // nothing, so two concurrent registers of one DID cannot both pass the check.
    if (this.rows.has(input.did)) {
      throw new OperatorAlreadyExistsError(input.did);
    }
    const row: Operator = {
      did: input.did,
      githubLogin: input.githubLogin,
      createdAt: new Date(),
    };
    this.rows.set(input.did, row);
    return row;
  }

  async findByDid(did: string): Promise<Operator | null> {
    return this.rows.get(did) ?? null;
  }
}

export class MemoryAgentRepository implements AgentRepository {
  private readonly rows = new Map<string, Agent>();

  async create(input: AgentInput): Promise<Agent> {
    // Check-then-set is safe here: Node is single-threaded and this method
    // awaits nothing, so two concurrent creates of one DID cannot both pass.
    if (this.rows.has(input.did)) {
      throw new AgentAlreadyExistsError(input.did);
    }
    const row: Agent = {
      did: input.did,
      operatorDid: input.operatorDid,
      delegation: input.delegation,
      name: input.name,
      skills: [...input.skills],
      githubLogin: input.githubLogin,
      proofStatus: 'unverified',
      createdAt: new Date(),
      keyRotations: [],
    };
    this.rows.set(input.did, row);
    return row;
  }

  async findByDid(did: string): Promise<Agent | null> {
    return this.rows.get(did) ?? null;
  }

  async updateGithubBinding(
    did: string,
    input: { readonly handle: string; readonly status: ProofStatus },
  ): Promise<Agent | null> {
    const row = this.rows.get(did);
    if (row === undefined) return null;
    // The live DID document is the source of truth, so a later successful
    // check for a different handle replaces the stored binding.
    const updated: Agent = { ...row, githubLogin: input.handle, proofStatus: input.status };
    this.rows.set(did, updated);
    return updated;
  }

  async recordKeyRotation(did: string, input: KeyRotationInput): Promise<Agent | null> {
    const row = this.rows.get(did);
    if (row === undefined) return null;
    // The driver stamps the time; storage does not re-check well-formedness
    // (same stance as create: the API layer validates against the domain
    // rule).
    const rotation: KeyRotation = {
      fromKey: input.fromKey,
      toKey: input.toKey,
      rotatedAt: new Date(),
    };
    // Append, never replace: the rotation history is the point of the
    // record (ENT-8.4), and replacing it would silently orphan the
    // credentials signed by earlier keys.
    const updated: Agent = { ...row, keyRotations: [...row.keyRotations, rotation] };
    this.rows.set(did, updated);
    return updated;
  }
}

export class MemoryJobRepository implements JobRepository {
  private readonly rows = new Map<string, Job>();

  async create(job: Job): Promise<Job> {
    // Check-then-set is safe here: Node is single-threaded and this method
    // awaits nothing, so two concurrent creates of one id cannot both pass.
    if (this.rows.has(job.id)) {
      throw new JobAlreadyExistsError(job.id);
    }
    const row: Job = { ...job };
    this.rows.set(job.id, row);
    return row;
  }

  async update(job: Job): Promise<Job | null> {
    if (!this.rows.has(job.id)) return null;
    const row: Job = { ...job };
    this.rows.set(job.id, row);
    return row;
  }

  async findById(id: string): Promise<Job | null> {
    return this.rows.get(id) ?? null;
  }

  async complete(job: Job, _completedJob: Omit<CompletedJob, 'id'>): Promise<Job | null> {
    if (!this.rows.has(job.id)) return null;
    // The completed row is the whole job, so store it exactly like update
    // stores its argument; the anchor record R-12 persists is not a second
    // row in this driver. Criteria are deep-copied, not shared with the
    // caller's input.
    const row: Job = { ...job, criteria: job.criteria.map((criterion) => ({ ...criterion })) };
    this.rows.set(job.id, row);
    return row;
  }

  async findCompletedByJobId(id: string): Promise<CompletedJob | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    // The completed facts live on the job row in this driver; a job that
    // never completed has no completed record to read back, so it is null
    // like an unknown id.
    if (row.mergeCommit === null || row.mergedAt === null) return null;
    return {
      id: row.id,
      jobId: row.id,
      buyerDid: row.buyerDid,
      agentDid: row.agentDid,
      mergeCommit: row.mergeCommit,
      completedAt: row.mergedAt,
    };
  }
}

export class MemoryCredentialRepository implements CredentialRepository {
  private readonly rows = new Map<string, VerifiableCredential>();

  async save(input: {
    readonly completedJobId: string;
    readonly subjectDid: string;
    readonly document: VerifiableCredential;
  }): Promise<void> {
    const key = credentialLookupKey(input.completedJobId);
    // Check-then-set is safe here: Node is single-threaded and this method
    // awaits nothing, so two concurrent saves of one job cannot both pass
    // the check.
    if (this.rows.has(key)) {
      throw new CredentialAlreadyIssuedError(input.completedJobId);
    }
    // The document goes in verbatim (the Prisma driver stores it the same
    // way): the bytes that verified are the bytes that are served back.
    this.rows.set(key, input.document);
  }

  async findByDocumentId(documentId: string): Promise<VerifiableCredential | null> {
    return this.rows.get(credentialLookupKey(documentId)) ?? null;
  }
}
