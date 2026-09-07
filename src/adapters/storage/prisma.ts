// Prisma-backed AccountRepository over the generated client. This is the
// only file in the repository that knows Postgres exists.
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Agent, Delegation, ProofStatus } from '../../domain/agent.js';
import type { CompromiseReport } from '../../domain/compromise.js';
import type { IssuedCredentialDocument } from '../credentials/types.js';
import type { CompletedJob, Criterion, Job, JobStatus } from '../../domain/job.js';
import { DEPOSIT_PERCENT, REDO_ALLOWANCE } from '../../domain/job.js';
import type { Attestation } from '../../domain/attestation.js';
import type { Account } from '../../domain/account.js';
import type { KeyRotation } from '../../domain/key-rotation.js';
import type { Review } from '../../domain/review.js';
import type { SignedAttestation } from '../credentials/types.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
  type CompromiseReportInput,
  type CompromiseRepository,
  CredentialAlreadyIssuedError,
  type CredentialRepository,
  JobAlreadyExistsError,
  type JobRepository,
  type KeyRotationInput,
  AccountAlreadyExistsError,
  type AccountRepository,
  ReviewAlreadyExistsError,
  type ReviewRepository,
  type StoredCredential,
  type ObservedKeyRepository,
  AttestationAlreadyStoredError,
  type AttestationRepository,
  type StoredAttestation,
  type ObservedSettlementRecord,
  type SettlementRepository,
  credentialLookupKey,
} from './types.js';

// The client is created on first use, not at import time: constructing a
// PrismaClient opens nothing immediately, but keeping construction out of
// module scope means the app can boot, typecheck, and be imported in tests
// without a database, and a misconfigured deployment fails on the first
// query with a 503 instead of at boot (invariant 9: fail closed, loud).
let client: PrismaClient | null = null;
function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

// The generated client lags the schema: src/generated/ is a gitignored
// build artifact and this path cannot regenerate it, so the rotation
// surface is addressed structurally against the schema, not the stale
// generated types. See the run report for R-29.
interface KeyRotationRow {
  id: string;
  agentDid: string;
  fromKey: string;
  toKey: string;
  rotatedAt: Date;
}
function rotationDb() {
  return db() as unknown as {
    keyRotation: {
      create(args: {
        data: { agentDid: string; fromKey: string; toKey: string; rotatedAt: Date };
      }): Promise<KeyRotationRow>;
      findMany(args: {
        where: { agentDid: string };
        orderBy: { rotatedAt: 'asc' };
      }): Promise<KeyRotationRow[]>;
    };
  };
}

// Every read path returns an Agent through this helper, so every Agent the
// driver returns carries its rotation history (ENT-8.4).
async function agentWithRotations(did: string): Promise<Agent | null> {
  const row = await db().agent.findUnique({ where: { did } });
  if (row === null) return null;
  const rows = await rotationDb().keyRotation.findMany({
    where: { agentDid: did },
    orderBy: { rotatedAt: 'asc' },
  });
  return toAgent(
    row,
    rows.map((r) => ({ fromKey: r.fromKey, toKey: r.toKey, rotatedAt: r.rotatedAt })),
  );
}

export class PrismaAccountRepository implements AccountRepository {
  async register(input: {
    readonly did: string;
    readonly githubLogin: string;
    readonly passkeySubject?: string | null;
  }): Promise<Account> {
    try {
      const row = await db().account.create({
        data: {
          did: input.did,
          githubLogin: input.githubLogin,
          passkeySubject: input.passkeySubject ?? null,
        },
      });
      return {
        did: row.did,
        githubLogin: row.githubLogin,
        passkeySubject: row.passkeySubject,
        createdAt: row.createdAt,
        operatorAddressEvm: row.operatorAddressEvm,
      };
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: it fires
      // on the DID primary key, the unique githubLogin, or the unique
      // passkeySubject alike. All three collisions mean the same thing to
      // a caller (this identity already claims an account), so all three
      // map to the same domain error rather than three different ones.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AccountAlreadyExistsError(input.did);
      }
      throw err;
    }
  }

  async findByDid(did: string): Promise<Account | null> {
    const row = await db().account.findUnique({ where: { did } });
    return row === null
      ? null
      : {
          did: row.did,
          githubLogin: row.githubLogin,
          passkeySubject: row.passkeySubject,
          createdAt: row.createdAt,
          operatorAddressEvm: row.operatorAddressEvm,
        };
  }

  async findByGithubLogin(githubLogin: string): Promise<Account | null> {
    const row = await db().account.findUnique({ where: { githubLogin } });
    return row === null
      ? null
      : {
          did: row.did,
          githubLogin: row.githubLogin,
          passkeySubject: row.passkeySubject,
          createdAt: row.createdAt,
          operatorAddressEvm: row.operatorAddressEvm,
        };
  }

  async findByPasskeySubject(passkeySubject: string): Promise<Account | null> {
    const row = await db().account.findUnique({ where: { passkeySubject } });
    return row === null
      ? null
      : {
          did: row.did,
          githubLogin: row.githubLogin,
          passkeySubject: row.passkeySubject,
          createdAt: row.createdAt,
          operatorAddressEvm: row.operatorAddressEvm,
        };
  }

  async setOperatorAddressEvm(did: string, operatorAddressEvm: string): Promise<Account | null> {
    try {
      const row = await db().account.update({
        where: { did },
        data: { operatorAddressEvm },
      });
      return {
        did: row.did,
        githubLogin: row.githubLogin,
        passkeySubject: row.passkeySubject,
        createdAt: row.createdAt,
        operatorAddressEvm: row.operatorAddressEvm,
      };
    } catch (err) {
      // P2025 is Prisma's "record to update not found" error code: the
      // did is unknown, mirroring PrismaAgentRepository.updateGithubBinding's
      // own P2025-to-null mapping.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }
}

export class PrismaAgentRepository implements AgentRepository {
  async create(input: AgentInput): Promise<Agent> {
    try {
      const row = await db().agent.create({
        data: {
          did: input.did,
          operatorDid: input.operatorDid,
          // The credential goes in verbatim: the Json column stores exactly
          // the object that verified, so the stored bytes stay verifiable.
          delegation: input.delegation as unknown as Prisma.InputJsonValue,
          name: input.name,
          skills: [...input.skills],
          githubLogin: input.githubLogin,
          floorPriceUsd: input.floorPriceUsd ?? null,
          minBuyerMerges: input.minBuyerMerges ?? null,
          maxWalkedAfterConfirm: input.maxWalkedAfterConfirm ?? null,
        } as unknown as Prisma.AgentCreateInput,
      });
      // A fresh agent has no rotation history; do not add a nested create.
      return toAgent(row, []);
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is the DID primary key, so a P2002
      // from create() means the agent is already delegated, and the API
      // layer maps the domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AgentAlreadyExistsError(input.did);
      }
      throw err;
    }
  }

  async findByDid(did: string): Promise<Agent | null> {
    return agentWithRotations(did);
  }

  async listAll(): Promise<readonly Agent[]> {
    const rows = await db().agent.findMany({ orderBy: { createdAt: 'asc' } });
    // Every read path returns an Agent with its rotation history attached
    // (ENT-8.4); listAll fetches each agent's rotations the same way
    // agentWithRotations does for a single lookup, rather than inventing a
    // second shape for the list case.
    return Promise.all(
      rows.map(async (row) => {
        const rotationRows = await rotationDb().keyRotation.findMany({
          where: { agentDid: row.did },
          orderBy: { rotatedAt: 'asc' },
        });
        return toAgent(
          row,
          rotationRows.map((r) => ({ fromKey: r.fromKey, toKey: r.toKey, rotatedAt: r.rotatedAt })),
        );
      }),
    );
  }

  async recordKeyRotation(did: string, input: KeyRotationInput): Promise<Agent | null> {
    // Reading first, not updating: an unknown DID resolves to null instead
    // of a P2025 from update, and the rotation row is only written after
    // the agent is known to exist.
    const agent = await db().agent.findUnique({ where: { did } });
    if (agent === null) return null;
    // Driver stamps the date, matching memory.
    await rotationDb().keyRotation.create({
      data: { agentDid: did, fromKey: input.fromKey, toKey: input.toKey, rotatedAt: new Date() },
    });
    return agentWithRotations(did);
  }

  async updateGithubBinding(
    did: string,
    input: { readonly handle: string; readonly status: ProofStatus },
  ): Promise<Agent | null> {
    try {
      await db().agent.update({
        where: { did },
        data: { githubLogin: input.handle, proofStatus: input.status },
      });
      // The update row does not carry rotations; the helper re-fetches them.
      return agentWithRotations(did);
    } catch (err) {
      // P2025 is Prisma's "record to update not found" error code: the
      // agent was never stored (or the DID is unknown), and the API layer
      // maps the null to 404.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }
}

// R-16 (ENT-8.4): a compromise report, addressed structurally for the same
// reason rotationDb() is: the generated client lags the schema, and this
// path cannot regenerate it.
interface CompromiseReportRow {
  id: string;
  agentDid: string;
  key: string;
  since: Date;
  reportedAt: Date;
}
function compromiseDb() {
  return db() as unknown as {
    compromiseReport: {
      create(args: {
        data: { agentDid: string; key: string; since: Date; reportedAt: Date };
      }): Promise<CompromiseReportRow>;
      findMany(args: {
        where: { agentDid: string };
        orderBy: { reportedAt: 'asc' };
      }): Promise<CompromiseReportRow[]>;
    };
  };
}

// R-16 (ENT-8.4): append-only compromise reports, a side record beside the
// agent rather than a field on it (the same separation KeyRotation keeps
// from Agent's core columns).
export class PrismaCompromiseRepository implements CompromiseRepository {
  async record(agentDid: string, input: CompromiseReportInput): Promise<CompromiseReport> {
    // Driver stamps the date, matching memory.
    const row = await compromiseDb().compromiseReport.create({
      data: { agentDid, key: input.key, since: input.since, reportedAt: new Date() },
    });
    return { key: row.key, since: row.since, reportedAt: row.reportedAt };
  }

  async listByAgentDid(agentDid: string): Promise<readonly CompromiseReport[]> {
    const rows = await compromiseDb().compromiseReport.findMany({
      where: { agentDid },
      orderBy: { reportedAt: 'asc' },
    });
    return rows.map((row) => ({ key: row.key, since: row.since, reportedAt: row.reportedAt }));
  }
}

function toAgent(
  row: {
    did: string;
    operatorDid: string;
    delegation: unknown;
    name: string;
    skills: string[];
    githubLogin: string | null;
    proofStatus: 'unverified' | 'pending' | 'verified';
    createdAt: Date;
    // The generated client lags the schema (see JobRow's comment below):
    // a worktree generated before this column exists types the Agent row
    // without it, so it is optional here and defaults to null, the same
    // "no floor set" meaning an absent column already carries.
    floorPriceUsd?: string | null;
    // P7: same reasoning as floorPriceUsd above -- a worktree generated
    // before these columns exist types the Agent row without them, and an
    // absent column means "no filter set", the same meaning a stored null
    // already carries.
    minBuyerMerges?: number | null;
    maxWalkedAfterConfirm?: number | null;
  },
  keyRotations: readonly KeyRotation[],
): Agent {
  return {
    did: row.did,
    operatorDid: row.operatorDid,
    delegation: row.delegation as Delegation,
    name: row.name,
    skills: [...row.skills],
    githubLogin: row.githubLogin,
    proofStatus: row.proofStatus,
    createdAt: row.createdAt,
    keyRotations: [...keyRotations],
    floorPriceUsd: row.floorPriceUsd ?? null,
    minBuyerMerges: row.minBuyerMerges ?? null,
    maxWalkedAfterConfirm: row.maxWalkedAfterConfirm ?? null,
  };
}

// The generated client is produced from schema.prisma at build time and is
// gitignored; a worktree generated before the brief column exists types the
// Job row without it. The casts keep this file compiling against either
// generation of the client, and are no-ops once a fresh client is generated.
interface JobRow {
  id: string;
  buyerDid: string;
  agentDid: string;
  repository: string;
  brief: string;
  briefHash: string;
  confirmedSpecHash: string | null;
  // Json column: arrives as whatever the database round-tripped, so it is
  // validated structurally in toJob rather than trusted.
  criteria: unknown;
  status: JobStatus;
  pullRequestUrl: string | null;
  mergeCommit: string | null;
  mergedAt: Date | null;
  confirmedAt: Date | null;
  submittedAt: Date | null;
  deadline: Date | null;
  createdAt: Date;
  // P1: optional, same reasoning as floorPriceUsd on the Agent row above --
  // a worktree generated before these columns exist types the row without
  // them, and an absent column means "not yet proposed", the same meaning
  // a stored null already carries.
  priceUsd?: string | null;
  rail?: string | null;
  priceAcceptedByBuyer?: boolean;
  priceAcceptedByAgent?: boolean;
  depositPercent?: number;
  redoAllowance?: number;
  deliveryWindowDays?: number | null;
  // P4: optional, same reasoning as priceUsd above -- a worktree generated
  // before these columns exist types the row without them, and an absent
  // column means "never staged", the same meaning a stored null already
  // carries.
  stagedAt?: Date | null;
  stagedCommit?: string | null;
  // B14a: optional, same reasoning as stagedAt above -- a worktree
  // generated before these columns exist types the row without them,
  // and an absent column means "no staging repository yet", the same
  // meaning a stored null already carries.
  stagingRepoOwner?: string | null;
  stagingRepoName?: string | null;
  baseCommit?: string | null;
  stagingRepoDeleteAfter?: Date | null;
  // P6: optional, same reasoning as stagedAt above -- a worktree generated
  // before these columns exist types the row without them, and an absent
  // column means "never redone" / "never cited-closed", the same meaning
  // a stored default or null already carries.
  redoUsedCount?: number;
  redoRequestedCriterionIndex?: number | null;
  redoRequestedAt?: Date | null;
  redoRefusedAt?: Date | null;
  stagedLapseExtensionDays?: number;
  citedCloseCriterionIndex?: number | null;
  citedCloseReasonText?: string | null;
  citedCloseAuthorDid?: string | null;
  citedCloseAt?: Date | null;
  deemedCompletedAt?: Date | null;
}

export class PrismaJobRepository implements JobRepository {
  async create(job: Job): Promise<Job> {
    try {
      const row = await db().job.create({
        // createdAt is passed explicitly: the domain timestamp must survive
        // the round-trip, not be re-issued by the database default.
        data: {
          id: job.id,
          buyerDid: job.buyerDid,
          agentDid: job.agentDid,
          repository: job.repository,
          brief: job.brief,
          briefHash: job.briefHash,
          confirmedSpecHash: job.confirmedSpecHash,
          criteria: job.criteria,
          status: job.status,
          pullRequestUrl: job.pullRequestUrl,
          mergeCommit: job.mergeCommit,
          mergedAt: job.mergedAt,
          confirmedAt: job.confirmedAt,
          submittedAt: job.submittedAt,
          deadline: job.deadline,
          createdAt: job.createdAt,
          priceUsd: job.priceUsd,
          rail: job.rail,
          priceAcceptedByBuyer: job.priceAcceptedByBuyer,
          priceAcceptedByAgent: job.priceAcceptedByAgent,
          depositPercent: job.depositPercent,
          redoAllowance: job.redoAllowance,
          deliveryWindowDays: job.deliveryWindowDays,
          stagedAt: job.stagedAt,
          stagedCommit: job.stagedCommit,
          stagingRepoOwner: job.stagingRepo?.owner ?? null,
          stagingRepoName: job.stagingRepo?.repo ?? null,
          baseCommit: job.baseCommit,
          stagingRepoDeleteAfter: job.stagingRepoDeleteAfter,
          redoUsedCount: job.redoUsedCount,
          redoRequestedCriterionIndex: job.redoRequestedCriterionIndex,
          redoRequestedAt: job.redoRequestedAt,
          redoRefusedAt: job.redoRefusedAt,
          stagedLapseExtensionDays: job.stagedLapseExtensionDays,
          citedCloseCriterionIndex: job.citedCloseCriterionIndex,
          citedCloseReasonText: job.citedCloseReasonText,
          citedCloseAuthorDid: job.citedCloseAuthorDid,
          citedCloseAt: job.citedCloseAt,
          deemedCompletedAt: job.deemedCompletedAt,
        } as unknown as Prisma.JobCreateInput,
      });
      return toJob(row as unknown as JobRow);
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is the id primary key, so a P2002
      // from create() means the job is already stored, and the API layer
      // maps the domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new JobAlreadyExistsError(job.id);
      }
      throw err;
    }
  }

  async update(job: Job): Promise<Job | null> {
    try {
      const row = await db().job.update({
        where: { id: job.id },
        data: {
          buyerDid: job.buyerDid,
          agentDid: job.agentDid,
          repository: job.repository,
          brief: job.brief,
          briefHash: job.briefHash,
          confirmedSpecHash: job.confirmedSpecHash,
          criteria: job.criteria,
          status: job.status,
          pullRequestUrl: job.pullRequestUrl,
          confirmedAt: job.confirmedAt,
          submittedAt: job.submittedAt,
          deadline: job.deadline,
          createdAt: job.createdAt,
          priceUsd: job.priceUsd,
          rail: job.rail,
          priceAcceptedByBuyer: job.priceAcceptedByBuyer,
          priceAcceptedByAgent: job.priceAcceptedByAgent,
          depositPercent: job.depositPercent,
          redoAllowance: job.redoAllowance,
          deliveryWindowDays: job.deliveryWindowDays,
          stagedAt: job.stagedAt,
          stagedCommit: job.stagedCommit,
          stagingRepoOwner: job.stagingRepo?.owner ?? null,
          stagingRepoName: job.stagingRepo?.repo ?? null,
          baseCommit: job.baseCommit,
          stagingRepoDeleteAfter: job.stagingRepoDeleteAfter,
          redoUsedCount: job.redoUsedCount,
          redoRequestedCriterionIndex: job.redoRequestedCriterionIndex,
          redoRequestedAt: job.redoRequestedAt,
          redoRefusedAt: job.redoRefusedAt,
          stagedLapseExtensionDays: job.stagedLapseExtensionDays,
          citedCloseCriterionIndex: job.citedCloseCriterionIndex,
          citedCloseReasonText: job.citedCloseReasonText,
          citedCloseAuthorDid: job.citedCloseAuthorDid,
          citedCloseAt: job.citedCloseAt,
          deemedCompletedAt: job.deemedCompletedAt,
        } as unknown as Prisma.JobUpdateInput,
      });
      return toJob(row as unknown as JobRow);
    } catch (err) {
      // P2025 is Prisma's "record to update not found" error code: the job
      // was never stored, and the API layer maps the null to 404.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Job | null> {
    const row = await db().job.findUnique({ where: { id } });
    return row === null ? null : toJob(row as unknown as JobRow);
  }

  async complete(job: Job, _completedJob: Omit<CompletedJob, 'id'>): Promise<Job | null> {
    try {
      const row = await db().job.update({
        where: { id: job.id },
        // The merge columns are written here and nowhere else: update
        // deliberately omits them, so a non-merge transition can never
        // clear or forge the observed facts.
        data: {
          buyerDid: job.buyerDid,
          agentDid: job.agentDid,
          repository: job.repository,
          brief: job.brief,
          briefHash: job.briefHash,
          confirmedSpecHash: job.confirmedSpecHash,
          criteria: job.criteria,
          status: job.status,
          pullRequestUrl: job.pullRequestUrl,
          mergeCommit: job.mergeCommit,
          mergedAt: job.mergedAt,
          confirmedAt: job.confirmedAt,
          submittedAt: job.submittedAt,
          deadline: job.deadline,
          createdAt: job.createdAt,
          priceUsd: job.priceUsd,
          rail: job.rail,
          priceAcceptedByBuyer: job.priceAcceptedByBuyer,
          priceAcceptedByAgent: job.priceAcceptedByAgent,
          depositPercent: job.depositPercent,
          redoAllowance: job.redoAllowance,
          deliveryWindowDays: job.deliveryWindowDays,
          stagedAt: job.stagedAt,
          stagedCommit: job.stagedCommit,
          stagingRepoOwner: job.stagingRepo?.owner ?? null,
          stagingRepoName: job.stagingRepo?.repo ?? null,
          baseCommit: job.baseCommit,
          stagingRepoDeleteAfter: job.stagingRepoDeleteAfter,
          redoUsedCount: job.redoUsedCount,
          redoRequestedCriterionIndex: job.redoRequestedCriterionIndex,
          redoRequestedAt: job.redoRequestedAt,
          redoRefusedAt: job.redoRefusedAt,
          stagedLapseExtensionDays: job.stagedLapseExtensionDays,
          citedCloseCriterionIndex: job.citedCloseCriterionIndex,
          citedCloseReasonText: job.citedCloseReasonText,
          citedCloseAuthorDid: job.citedCloseAuthorDid,
          citedCloseAt: job.citedCloseAt,
          deemedCompletedAt: job.deemedCompletedAt,
        } as unknown as Prisma.JobUpdateInput,
      });
      return toJob(row as unknown as JobRow);
    } catch (err) {
      // P2025 is Prisma's "record to update not found" error code: the
      // row was gone between the read and the write, and the API layer
      // maps the null to 404.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  }

  async findCompletedByJobId(id: string): Promise<CompletedJob | null> {
    const row = await db().job.findUnique({ where: { id } });
    if (row === null) return null;
    const job = toJob(row as unknown as JobRow);
    // A job that never completed has no completed record to read back, so
    // it is null like an unknown id.
    if (job.mergeCommit === null || job.mergedAt === null) return null;
    return {
      id: job.id,
      jobId: job.id,
      buyerDid: job.buyerDid,
      agentDid: job.agentDid,
      mergeCommit: job.mergeCommit,
      completedAt: job.mergedAt,
    };
  }

  async findCompletedByAgent(agentDid: string): Promise<readonly CompletedJob[]> {
    // Exact DID string match: agentDid is the indexed column and the caller
    // passes the stored agent DID it just read back from
    // AgentRepository.findByDid. Suffix reconciliation is the domain layer's
    // job and applies to the buyer comparison only. Reads the Job table, not
    // CompletedJob, the same way findCompletedByJobId does.
    const rows = await db().job.findMany({ where: { agentDid } });
    const completed: CompletedJob[] = [];
    for (const row of rows) {
      const job = toJob(row as unknown as JobRow);
      // A job that never completed has no completed record to read back, so
      // it is filtered out here in JS rather than in the where clause: the
      // same null check findCompletedByJobId makes, without a Prisma
      // where-type cast.
      if (job.mergeCommit === null || job.mergedAt === null) continue;
      completed.push({
        id: job.id,
        jobId: job.id,
        buyerDid: job.buyerDid,
        agentDid: job.agentDid,
        mergeCommit: job.mergeCommit,
        completedAt: job.mergedAt,
      });
    }
    completed.sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    return completed;
  }

  // P7: every job for one buyer DID, in any status, projected exactly
  // like findById already does.
  async findByBuyerDid(buyerDid: string): Promise<readonly Job[]> {
    const rows = await db().job.findMany({ where: { buyerDid } });
    return rows.map((row) => toJob(row as unknown as JobRow));
  }
}

export class PrismaCredentialRepository implements CredentialRepository {
  async save(input: {
    readonly completedJobId: string;
    readonly subjectDid: string;
    readonly document: IssuedCredentialDocument;
    readonly repositoryPublic?: boolean;
  }): Promise<void> {
    try {
      await db().credential.create({
        data: {
          completedJobId: credentialLookupKey(input.completedJobId),
          subjectDid: input.subjectDid,
          // The credential goes in verbatim: the Json column stores exactly
          // the object that verified, so the stored bytes stay verifiable.
          document: input.document as unknown as Prisma.InputJsonValue,
          // An unrecorded visibility fact must never read as verified
          // (R-17, PR 70's rejected finding), so an omitted caller value
          // fails closed the same direction a private repository would.
          repositoryPublic: input.repositoryPublic ?? false,
          issuedAt: new Date(),
        },
      });
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is completedJobId, so a P2002 from
      // create() means the job already has a credential, and the API layer
      // maps the domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new CredentialAlreadyIssuedError(input.completedJobId);
      }
      throw err;
    }
  }

  async findByDocumentId(documentId: string): Promise<IssuedCredentialDocument | null> {
    const row = await db().credential.findUnique({
      where: { completedJobId: credentialLookupKey(documentId) },
    });
    // The Json column round-trips as unknown; storage does not re-validate
    // (same stance as the delegation column), it serves the stored bytes.
    return row === null ? null : (row.document as unknown as IssuedCredentialDocument);
  }

  async listBySubjectDid(subjectDid: string): Promise<readonly StoredCredential[]> {
    const rows = await db().credential.findMany({
      where: { subjectDid },
      orderBy: { issuedAt: 'asc' },
    });
    // Verbatim documents, same stance as findByDocumentId: the bytes that
    // verified are the bytes served back, oldest first (R-17: the only
    // order both drivers can produce identically, since the memory driver
    // has no timestamp column to sort by). A row written before this
    // column existed reads back null, which the pair maps to false, not
    // undefined: an unrecorded visibility fact must never read as verified.
    return rows.map((row) => ({
      document: row.document as unknown as IssuedCredentialDocument,
      repositoryPublic: row.repositoryPublic ?? false,
    }));
  }
}

// Every Job field, no omissions: a dropped field here is a silent loss of
// the buyer's record, which is the failure class R-27 closes.
function toJob(row: JobRow): Job {
  return {
    id: row.id,
    buyerDid: row.buyerDid,
    agentDid: row.agentDid,
    repository: row.repository,
    brief: row.brief,
    briefHash: row.briefHash,
    confirmedSpecHash: row.confirmedSpecHash,
    // A row written before the column existed (or a null) is a job with no
    // proposal yet, never a job whose criteria are undefined: every caller
    // may read criteria as an array.
    criteria: Array.isArray(row.criteria) ? row.criteria.map(normalizeCriterion) : [],
    status: row.status,
    pullRequestUrl: row.pullRequestUrl,
    mergeCommit: row.mergeCommit,
    mergedAt: row.mergedAt,
    confirmedAt: row.confirmedAt,
    submittedAt: row.submittedAt,
    deadline: row.deadline,
    createdAt: row.createdAt,
    priceUsd: row.priceUsd ?? null,
    rail: (row.rail ?? null) as Job['rail'],
    priceAcceptedByBuyer: row.priceAcceptedByBuyer ?? false,
    priceAcceptedByAgent: row.priceAcceptedByAgent ?? false,
    depositPercent: row.depositPercent ?? DEPOSIT_PERCENT,
    redoAllowance: row.redoAllowance ?? REDO_ALLOWANCE,
    deliveryWindowDays: row.deliveryWindowDays ?? null,
    stagedAt: row.stagedAt ?? null,
    stagedCommit: row.stagedCommit ?? null,
    stagingRepo:
      row.stagingRepoOwner != null && row.stagingRepoName != null
        ? { owner: row.stagingRepoOwner, repo: row.stagingRepoName }
        : null,
    baseCommit: row.baseCommit ?? null,
    stagingRepoDeleteAfter: row.stagingRepoDeleteAfter ?? null,
    redoUsedCount: row.redoUsedCount ?? 0,
    redoRequestedCriterionIndex: row.redoRequestedCriterionIndex ?? null,
    redoRequestedAt: row.redoRequestedAt ?? null,
    redoRefusedAt: row.redoRefusedAt ?? null,
    stagedLapseExtensionDays: row.stagedLapseExtensionDays ?? 0,
    citedCloseCriterionIndex: row.citedCloseCriterionIndex ?? null,
    citedCloseReasonText: row.citedCloseReasonText ?? null,
    citedCloseAuthorDid: row.citedCloseAuthorDid ?? null,
    citedCloseAt: row.citedCloseAt ?? null,
    deemedCompletedAt: row.deemedCompletedAt ?? null,
  };
}

// A row written before this issue's two-party split (a single `accepted`
// flag rather than acceptedByBuyer/acceptedByAgent) must still load: this
// is a JSON column, so nothing enforced the new shape on rows written
// earlier. Its `accepted: true` meant, per the ORIGINAL ENT-6.2 wording,
// "both parties agreed" (the flag was mis-enforced, not mis-named) - so it
// maps to both new flags true, and `accepted: false` maps to both false.
// A row already in the new shape passes through untouched.
function normalizeCriterion(raw: unknown): Criterion {
  const c = raw as Record<string, unknown>;
  if (typeof c.acceptedByBuyer === 'boolean' && typeof c.acceptedByAgent === 'boolean') {
    return c as unknown as Criterion;
  }
  const legacyAccepted = c.accepted === true;
  return {
    text: String(c.text),
    proposedBy: c.proposedBy === 'buyer' ? 'buyer' : 'agent',
    acceptedByBuyer: legacyAccepted,
    acceptedByAgent: legacyAccepted,
  };
}

// R-22 (ENT-10, issue 29): one review per completed job, keyed by jobId
// (completedJobId in the schema, targeting Job.id directly, the same
// repoint R-35 lap B made for Credential). Eligibility already ran in the
// domain layer before save is ever called; this driver only refuses a
// second write for a job that already has one.
export class PrismaReviewRepository implements ReviewRepository {
  async save(review: Review): Promise<void> {
    try {
      await db().review.create({
        data: {
          completedJobId: review.jobId,
          authorDid: review.authorDid,
          agentDid: review.agentDid,
          text: review.text,
          createdAt: review.createdAt,
        },
      });
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is completedJobId, so a P2002 from
      // create() means the job already has a review, and the API layer
      // maps the domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ReviewAlreadyExistsError(review.jobId);
      }
      throw err;
    }
  }

  async listByAgentDid(agentDid: string): Promise<readonly Review[]> {
    const rows = await db().review.findMany({
      where: { agentDid },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      jobId: row.completedJobId,
      authorDid: row.authorDid,
      agentDid: row.agentDid,
      text: row.text,
      createdAt: row.createdAt,
    }));
  }
}

// D2 (task t_8a82c865): addressed structurally, for the same reason
// rotationDb() and compromiseDb() are: the generated client lags the
// schema, and this path cannot regenerate it.
interface ObservedKeyRow {
  did: string;
  verificationMethod: string;
  observedAt: Date;
}
function observedKeyDb() {
  return db() as unknown as {
    observedKey: {
      upsert(args: {
        where: { did: string };
        create: { did: string; verificationMethod: string };
        update: { verificationMethod: string; observedAt: Date };
      }): Promise<ObservedKeyRow>;
      findUnique(args: { where: { did: string } }): Promise<ObservedKeyRow | null>;
    };
  };
}

// D2 (task t_8a82c865): the durable half of the R-34 signing-key
// resolver's binding check. upsert, not create: a later verified signature
// replaces the prior row, the same overwrite-on-record stance the
// in-process KnownKeyStore already takes (did-abt-resolver.ts).
export class PrismaObservedKeyRepository implements ObservedKeyRepository {
  async record(did: string, verificationMethod: string): Promise<void> {
    await observedKeyDb().observedKey.upsert({
      where: { did },
      create: { did, verificationMethod },
      update: { verificationMethod, observedAt: new Date() },
    });
  }

  async get(did: string): Promise<string | null> {
    const row = await observedKeyDb().observedKey.findUnique({ where: { did } });
    return row?.verificationMethod ?? null;
  }
}

// P5/P6: many attestation records per job (design record, 2026-09-01;
// widened by P6's redo), each row IMMUTABLE once written
// (AttestationRepository's own header comment, src/adapters/storage/types.ts).
// Both `document` and `signed` go in verbatim, the same "the bytes that
// verified are the bytes served back" stance PrismaCredentialRepository
// already keeps for work-history credentials. sequence is computed from
// a count of the job's existing rows rather than a database identity
// column, so the memory driver and this one derive it the same way.
export class PrismaAttestationRepository implements AttestationRepository {
  async save(input: {
    readonly jobId: string;
    readonly attestation: Attestation;
    readonly signed: SignedAttestation;
  }): Promise<StoredAttestation> {
    const existingCount = await db().attestation.count({ where: { jobId: input.jobId } });
    const sequence = existingCount + 1;
    try {
      const row = await db().attestation.create({
        data: {
          jobId: input.jobId,
          sequence,
          document: input.attestation as unknown as Prisma.InputJsonValue,
          signed: input.signed as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        jobId: row.jobId,
        sequence: row.sequence,
        attestation: input.attestation,
        signed: input.signed,
      };
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is the (jobId, sequence) pair, so
      // a P2002 from create() means a genuine write race computed the
      // identical next sequence concurrently, and the API layer maps the
      // domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AttestationAlreadyStoredError(input.jobId);
      }
      throw err;
    }
  }

  async findByJobId(jobId: string): Promise<StoredAttestation | null> {
    const row = await db().attestation.findFirst({ where: { jobId }, orderBy: { sequence: 'desc' } });
    if (row === null) return null;
    return {
      jobId: row.jobId,
      sequence: row.sequence,
      // The Json columns round-trip as unknown; storage does not
      // re-validate (same stance as every other Json column in this
      // file), it serves the stored bytes.
      attestation: row.document as unknown as Attestation,
      signed: row.signed as unknown as SignedAttestation,
    };
  }

  async listByJobId(jobId: string): Promise<readonly StoredAttestation[]> {
    const rows = await db().attestation.findMany({ where: { jobId }, orderBy: { sequence: 'asc' } });
    return rows.map((row) => ({
      jobId: row.jobId,
      sequence: row.sequence,
      attestation: row.document as unknown as Attestation,
      signed: row.signed as unknown as SignedAttestation,
    }));
  }
}

// P10: the observed settlement record (payment surface brief, scope item
// 1), on the ObservedSettlement model. record() upserts on the (jobId,
// leg) unique key, mirroring PrismaUsdcHalfPaidStorage's own
// upsert-by-key shape: a repeat confirm() on the same ref must leave
// exactly one row, never a P2002 the route layer would have to catch.
export class PrismaSettlementRepository implements SettlementRepository {
  async record(input: ObservedSettlementRecord): Promise<void> {
    const data = {
      rail: input.rail,
      hash: input.hash,
      secondaryHash: input.secondaryHash,
      operatorAddress: input.operatorAddress,
      feeAddress: input.feeAddress,
      amountUsd: input.amountUsd,
      observedAt: input.observedAt,
    };
    await db().observedSettlement.upsert({
      where: { jobId_leg: { jobId: input.jobId, leg: input.leg } },
      create: { jobId: input.jobId, leg: input.leg, ...data },
      update: data,
    });
  }

  async findByJobAndLeg(jobId: string, leg: 'deposit' | 'remainder'): Promise<ObservedSettlementRecord | null> {
    const row = await db().observedSettlement.findUnique({ where: { jobId_leg: { jobId, leg } } });
    if (row === null) return null;
    return {
      jobId: row.jobId,
      leg: row.leg as 'deposit' | 'remainder',
      rail: row.rail as 'abt' | 'usdc',
      hash: row.hash,
      secondaryHash: row.secondaryHash,
      operatorAddress: row.operatorAddress,
      feeAddress: row.feeAddress,
      amountUsd: row.amountUsd,
      observedAt: row.observedAt,
    };
  }
}
