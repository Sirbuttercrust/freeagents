// Prisma-backed OperatorRepository over the generated client. This is the
// only file in the repository that knows Postgres exists.
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Agent, Delegation, ProofStatus } from '../../domain/agent.js';
import type { Job, JobStatus } from '../../domain/job.js';
import type { Operator } from '../../domain/operator.js';
import type { KeyRotation } from '../../domain/key-rotation.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
  JobAlreadyExistsError,
  type JobRepository,
  type KeyRotationInput,
  OperatorAlreadyExistsError,
  type OperatorRepository,
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

export class PrismaOperatorRepository implements OperatorRepository {
  async register(input: {
    readonly did: string;
    readonly githubLogin: string;
  }): Promise<Operator> {
    try {
      const row = await db().operator.create({ data: { ...input } });
      return { did: row.did, githubLogin: row.githubLogin, createdAt: row.createdAt };
    } catch (err) {
      // P2002 is Prisma's "unique constraint failed" error code: the only
      // unique constraint reachable here is the DID primary key, so a P2002
      // from create() means the DID is already registered, and the API
      // layer maps the domain error to 409.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new OperatorAlreadyExistsError(input.did);
      }
      throw err;
    }
  }

  async findByDid(did: string): Promise<Operator | null> {
    const row = await db().operator.findUnique({ where: { did } });
    return row === null ? null : { did: row.did, githubLogin: row.githubLogin, createdAt: row.createdAt };
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
        },
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

function toAgent(
  row: { did: string; operatorDid: string; delegation: unknown; name: string; skills: string[]; githubLogin: string | null; proofStatus: 'unverified' | 'pending' | 'verified'; createdAt: Date },
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
  status: JobStatus;
  pullRequestUrl: string | null;
  confirmedAt: Date | null;
  submittedAt: Date | null;
  createdAt: Date;
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
          status: job.status,
          pullRequestUrl: job.pullRequestUrl,
          confirmedAt: job.confirmedAt,
          submittedAt: job.submittedAt,
          createdAt: job.createdAt,
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
          status: job.status,
          pullRequestUrl: job.pullRequestUrl,
          confirmedAt: job.confirmedAt,
          submittedAt: job.submittedAt,
          createdAt: job.createdAt,
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
    status: row.status,
    pullRequestUrl: row.pullRequestUrl,
    confirmedAt: row.confirmedAt,
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
  };
}
