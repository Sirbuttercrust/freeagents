// Factory that picks the storage driver from the environment. This is a
// selected mode, not a fallback: an unconfigured deployment announces
// itself at startup, and a configured-but-dead database fails closed with
// a 503 on the first query (invariant 9: portability, fail closed, loud).
import { MemoryAgentRepository, MemoryCompromiseRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryOperatorRepository, MemoryReviewRepository } from './memory.js';
import { PrismaAgentRepository, PrismaCompromiseRepository, PrismaCredentialRepository, PrismaJobRepository, PrismaOperatorRepository, PrismaReviewRepository } from './prisma.js';
import type { AgentRepository, CompromiseRepository, CredentialRepository, JobRepository, OperatorRepository, ReviewRepository } from './types.js';

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

export function createCredentialRepository(): CredentialRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaCredentialRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryCredentialRepository();
}

export function createCompromiseRepository(): CompromiseRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaCompromiseRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryCompromiseRepository();
}

export function createReviewRepository(): ReviewRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaReviewRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryReviewRepository();
}
