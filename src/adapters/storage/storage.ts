// Factory that picks the storage driver from the environment. This is a
// selected mode, not a fallback: an unconfigured deployment announces
// itself at startup, and a configured-but-dead database fails closed with
// a 503 on the first query (invariant 9: portability, fail closed, loud).
import { MemoryAgentRepository, MemoryCompromiseRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryAccountRepository, MemoryReviewRepository, MemoryObservedKeyRepository } from './memory.js';
import { PrismaAgentRepository, PrismaCompromiseRepository, PrismaCredentialRepository, PrismaJobRepository, PrismaAccountRepository, PrismaReviewRepository, PrismaObservedKeyRepository } from './prisma.js';
import type { AgentRepository, CompromiseRepository, CredentialRepository, JobRepository, AccountRepository, ReviewRepository, ObservedKeyRepository } from './types.js';

export function createAccountRepository(): AccountRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaAccountRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryAccountRepository();
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

// D2 (task t_8a82c865): the durable half of identity resolution. Same
// selection stance as every repository above: Prisma when configured,
// in-memory (with the same restart-does-not-survive warning) otherwise.
export function createObservedKeyRepository(): ObservedKeyRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaObservedKeyRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryObservedKeyRepository();
}
