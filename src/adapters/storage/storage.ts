// Factory that picks the storage driver from the environment. This is a
// selected mode, not a fallback: an unconfigured deployment announces
// itself at startup, and a configured-but-dead database fails closed with
// a 503 on the first query (invariant 9: portability, fail closed, loud).
import { MemoryAgentRepository, MemoryJobRepository, MemoryOperatorRepository } from './memory.js';
import { PrismaAgentRepository, PrismaJobRepository, PrismaOperatorRepository } from './prisma.js';
import type { AgentRepository, JobRepository, OperatorRepository } from './types.js';

export function createOperatorRepository(): OperatorRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaOperatorRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryOperatorRepository();
}

export function createAgentRepository(): AgentRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaAgentRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryAgentRepository();
}

export function createJobRepository(): JobRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaJobRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryJobRepository();
}
