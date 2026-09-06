// P6: GET /v1/credentials/:credentialId/status is a question only a
// CompletedHireCredential can pose (its own signedBy/mergedAt pair). A
// deemed-completion credential carries neither, so the route must guard
// against it (isCompletedHireCredential) rather than reading `.hire` off a
// document that has no such field -- the same shape of defect ENT-8.3
// already rules out for the dispute status itself.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { createCredentialsAdapter } from '../../src/adapters/credentials/credentials.js';
import { MemoryAgentRepository, MemoryCompromiseRepository, MemoryCredentialRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';

const ISSUER_DID = 'did:abt:test-platform-issuer-status-guard';
const ISSUER_SEED = new Uint8Array(32).fill(19);

describe('GET /v1/credentials/:credentialId/status guards non-hire documents (P6)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const credentialRepo = new MemoryCredentialRepository();
    const credentials = createCredentialsAdapter({ did: ISSUER_DID, seed: ISSUER_SEED }, credentialRepo);
    const deemed = await credentials.issueDeemedCompletionCredential('did:example:agent', {
      jobId: 'job-status-guard-deemed',
      stagedCommit: 'commit-sha-status-guard',
      buyerDid: 'did:example:buyer',
    });
    await credentialRepo.save({
      completedJobId: 'job-status-guard-deemed',
      subjectDid: 'did:example:agent',
      document: deemed,
    });
    const app = createApp(
      new MemoryAccountRepository(),
      new MemoryAgentRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      new MemoryCompromiseRepository(),
      credentialRepo,
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => server.close());

  it('404s a deemed-completion credential id: no signed-work status to report', async () => {
    const res = await fetch(`${baseUrl}/v1/credentials/job-status-guard-deemed/status`);
    expect(res.status).toBe(404);
  });
});
