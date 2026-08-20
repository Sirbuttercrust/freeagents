// Prisma-backed OperatorRepository over the generated client. This is the
// only file in the repository that knows Postgres exists.
import { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Agent, Delegation } from '../../domain/agent.js';
import type { Operator } from '../../domain/operator.js';
import {
  AgentAlreadyExistsError,
  type AgentInput,
  type AgentRepository,
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
      return toAgent(row);
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
    const row = await db().agent.findUnique({ where: { did } });
    return row === null ? null : toAgent(row);
  }
}

function toAgent(row: { did: string; operatorDid: string; delegation: unknown; name: string; skills: string[]; githubLogin: string | null; proofStatus: 'unverified' | 'pending' | 'verified'; createdAt: Date }): Agent {
  return {
    did: row.did,
    operatorDid: row.operatorDid,
    delegation: row.delegation as Delegation,
    name: row.name,
    skills: [...row.skills],
    githubLogin: row.githubLogin,
    proofStatus: row.proofStatus,
    createdAt: row.createdAt,
  };
}
