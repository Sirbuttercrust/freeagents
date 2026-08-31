// In-memory OperatorRepository: real storage for dev and tests, and the selected
// mode when DATABASE_URL is unset (see storage.ts). A Map keyed by DID gives the
// same duplicate-key semantics the database gives through its primary key.
import type { Agent, ProofStatus } from '../../domain/agent.js';
import type { CompletedJob, Job } from '../../domain/job.js';
import type { CompromiseReport } from '../../domain/compromise.js';
import type { Operator } from '../../domain/operator.js';
import type { KeyRotation } from '../../domain/key-rotation.js';
import type { VerifiableCredential } from '../credentials/types.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
  type CompromiseReportInput,
  type CompromiseRepository,
  CredentialAlreadyIssuedError,
  type CredentialRepository,
  type StoredCredential,
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

// R-16 (ENT-8.4): append-only compromise reports, keyed by agent DID, the
// same shape KeyRotation history takes on Agent, but kept as a side record
// rather than a field: a disputed marker never enters the signed credential
// (ENT-8.3).
export class MemoryCompromiseRepository implements CompromiseRepository {
  private readonly rows = new Map<string, CompromiseReport[]>();

  async record(agentDid: string, input: CompromiseReportInput): Promise<CompromiseReport> {
    // The driver stamps the time; storage does not re-check well-formedness
    // (same stance as create: the API layer validates against the domain
    // rule).
    const report: CompromiseReport = {
      key: input.key,
      since: input.since,
      reportedAt: new Date(),
    };
    const existing = this.rows.get(agentDid) ?? [];
    // Append, never replace: nothing is deleted or hidden (R-16 accept).
    this.rows.set(agentDid, [...existing, report]);
    return report;
  }

  async listByAgentDid(agentDid: string): Promise<readonly CompromiseReport[]> {
    return [...(this.rows.get(agentDid) ?? [])];
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

  async findCompletedByAgent(agentDid: string): Promise<readonly CompletedJob[]> {
    // Exact DID string match: agentDid is the indexed column and the caller
    // passes the stored agent DID it just read back from
    // AgentRepository.findByDid. Suffix reconciliation is the domain layer's
    // job and applies to the buyer comparison only.
    const completed: CompletedJob[] = [];
    for (const row of this.rows.values()) {
      if (row.agentDid !== agentDid) continue;
      if (row.mergeCommit === null || row.mergedAt === null) continue;
      completed.push({
        id: row.id,
        jobId: row.id,
        buyerDid: row.buyerDid,
        agentDid: row.agentDid,
        mergeCommit: row.mergeCommit,
        completedAt: row.mergedAt,
      });
    }
    completed.sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    return completed;
  }
}

// Each stored row carries its subjectDid and repositoryPublic beside the
// document, so listBySubjectDid can filter and answer evidenceTier's
// question without parsing the credential shape (a pre-R-35 row may not
// even nest credentialSubject.hire the current way).
interface CredentialRow {
  readonly subjectDid: string;
  readonly document: VerifiableCredential;
  readonly repositoryPublic: boolean;
}

export class MemoryCredentialRepository implements CredentialRepository {
  private readonly rows = new Map<string, CredentialRow>();

  async save(input: {
    readonly completedJobId: string;
    readonly subjectDid: string;
    readonly document: VerifiableCredential;
    readonly repositoryPublic?: boolean;
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
    // repositoryPublic defaults to false: an unrecorded visibility fact
    // must never read as verified.
    this.rows.set(key, {
      subjectDid: input.subjectDid,
      document: input.document,
      repositoryPublic: input.repositoryPublic ?? false,
    });
  }

  async findByDocumentId(documentId: string): Promise<VerifiableCredential | null> {
    return this.rows.get(credentialLookupKey(documentId))?.document ?? null;
  }

  async listBySubjectDid(subjectDid: string): Promise<readonly StoredCredential[]> {
    // Map iteration order is insertion order (the JS spec guarantees it),
    // so filtering here is already oldest-first with no extra sort.
    return [...this.rows.values()]
      .filter((row) => row.subjectDid === subjectDid)
      .map((row) => ({ document: row.document, repositoryPublic: row.repositoryPublic }));
  }
}
