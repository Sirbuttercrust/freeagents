// Factory that picks the storage driver from the environment. This is a
// selected mode, not a fallback: an unconfigured deployment announces
// itself at startup, and a configured-but-dead database fails closed with
// a 503 on the first query (invariant 9: portability, fail closed, loud).
import { MemoryAgentRepository, MemoryCompromiseRepository, MemoryCredentialRepository, MemoryJobRepository, MemoryAccountRepository, MemoryReviewRepository, MemoryObservedKeyRepository, MemoryAttestationRepository, MemorySettlementRepository, MemoryMessageRepository, MemoryThreadReadStateRepository, MemoryNotificationRepository, MemoryAttachmentRepository, MemoryPushSubscriptionRepository } from './memory.js';
import { PrismaAgentRepository, PrismaCompromiseRepository, PrismaCredentialRepository, PrismaJobRepository, PrismaAccountRepository, PrismaReviewRepository, PrismaObservedKeyRepository, PrismaAttestationRepository, PrismaSettlementRepository, PrismaMessageRepository, PrismaThreadReadStateRepository, PrismaNotificationRepository, PrismaAttachmentRepository, PrismaPushSubscriptionRepository } from './prisma.js';
import type { AgentRepository, CompromiseRepository, CredentialRepository, JobRepository, AccountRepository, ReviewRepository, ObservedKeyRepository, AttestationRepository, SettlementRepository, MessageRepository, ThreadReadStateRepository, NotificationRepository, AttachmentRepository, PushSubscriptionRepository } from './types.js';

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

// P5: the attestation repository (design record, 2026-09-01). Same
// selection stance as every repository above: Prisma when configured,
// in-memory (with the same restart-does-not-survive warning) otherwise.
export function createAttestationRepository(): AttestationRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaAttestationRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryAttestationRepository();
}

// P10: the observed settlement record (payment surface brief, scope item
// 1). Same selection stance as every repository above: Prisma when
// configured, in-memory (with the same restart-does-not-survive warning)
// otherwise.
export function createSettlementRepository(): SettlementRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaSettlementRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemorySettlementRepository();
}

// HT1 Part B: the hire thread's message store. Same selection stance as
// every repository above.
export function createMessageRepository(): MessageRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaMessageRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryMessageRepository();
}

// HT1 Part B: read receipts. Same selection stance as every repository
// above.
export function createThreadReadStateRepository(): ThreadReadStateRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaThreadReadStateRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryThreadReadStateRepository();
}

// HT1 Part B (STEER item 4): the per-account notification store. Same
// selection stance as every repository above.
export function createNotificationRepository(): NotificationRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaNotificationRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryNotificationRepository();
}

// HT1 Part B (attachments STEER): one stored attachment per uploaded
// file. Same selection stance as every repository above.
export function createAttachmentRepository(): AttachmentRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaAttachmentRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryAttachmentRepository();
}

// HT1 Part B (STEER item 4): browser Push API subscriptions. Same
// selection stance as every repository above.
export function createPushSubscriptionRepository(): PushSubscriptionRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaPushSubscriptionRepository();
  }
  console.warn(
    'storage: DATABASE_URL is not set; using in-memory storage. ' +
      'Data does not survive a restart. This is a dev/test mode, not production storage.'
  );
  return new MemoryPushSubscriptionRepository();
}
