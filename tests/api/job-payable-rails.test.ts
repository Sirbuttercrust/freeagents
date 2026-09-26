// FIX-B39 (bugs.md B39), rule 6: GET /jobs/:jobId carries ONE new
// top-level key, payableRails, while the job is 'proposed' and has a
// price. Rule 2: the pinned currency if a quote pinned it, otherwise
// every currency the hired agent's owner has a payout address for.
// Rule 3: once a deposit has settled, only that deposit's currency.
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

interface Setup {
  readonly server: Server;
  readonly baseUrl: string;
  readonly buyer: SigningIdentity;
  readonly agent: SigningIdentity;
  readonly settlementRepo: MemorySettlementRepository;
}

async function startApp(
  operatorAddresses: { readonly abt?: string; readonly evm?: string } = {},
): Promise<Setup> {
  const buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(Math.floor(Math.random() * 200) + 1));
  const agent = await signingIdentityFromSeed(new Uint8Array(32).fill(Math.floor(Math.random() * 200) + 1));
  const operatorRepo = new MemoryAccountRepository();
  await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-payable-rails-${Math.random()}` });
  const operatorDid = `did:abt:op-payable-rails-${Math.random()}`;
  await operatorRepo.register({ did: operatorDid, githubLogin: `operator-payable-rails-${Math.random()}` });
  if (operatorAddresses.abt !== undefined) {
    await operatorRepo.setOperatorAddressAbt(operatorDid, operatorAddresses.abt);
  }
  if (operatorAddresses.evm !== undefined) {
    await operatorRepo.setOperatorAddressEvm(operatorDid, operatorAddresses.evm);
  }
  const agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid,
    delegation: { fixture: true } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-payable-rails',
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-payable-rails', status: 'verified' });
  const jobRepo = new MemoryJobRepository();
  const settlementRepo = new MemorySettlementRepository();
  const { github } = createStagingLifecycleGithubFake();
  const server = createApp(
    operatorRepo,
    agentRepo,
    undefined,
    github,
    jobRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    settlementRepo,
  ).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, buyer, agent, settlementRepo };
}

async function openDraft(baseUrl: string, buyer: SigningIdentity, agent: SigningIdentity): Promise<string> {
  const created = await postSigned(baseUrl, '/jobs', {
    buyerDid: buyer.did,
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  return String(((await created.json()) as Record<string, unknown>).id);
}

describe('payableRails: both addresses on record, open quote', () => {
  it('answers ["abt","usdc"] for an open (no-rail) quote, on GET /jobs/:jobId only', async () => {
    const setup = await startApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      const proposed = await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
      }, setup.agent);
      expect(proposed.status).toBe(200);
      // Rule 6: payableRails rides ONLY GET /jobs/:jobId, the same
      // conditional stance githubAccessNeeded already takes on that one
      // route, never the criteria route's own mutation response.
      const proposedBody = (await proposed.json()) as Record<string, unknown>;
      expect(proposedBody.payableRails).toBeUndefined();

      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const readBack = (await read.json()) as Record<string, unknown>;
      expect(readBack.payableRails).toEqual(['abt', 'usdc']);
    } finally {
      setup.server.close();
    }
  });
});

describe('payableRails: a pinned quote reports only the pinned currency, even with both addresses set', () => {
  it('answers ["usdc"] for a quote naming usdc', async () => {
    const setup = await startApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
        rail: 'usdc',
      }, setup.agent);
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.payableRails).toEqual(['usdc']);
    } finally {
      setup.server.close();
    }
  });
});

describe('payableRails: filtered by which payout address the owner actually has', () => {
  it('answers ["abt"] when only operatorAddressAbt is set', async () => {
    const setup = await startApp({ abt: 'z1OperatorAbt' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
      }, setup.agent);
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.payableRails).toEqual(['abt']);
    } finally {
      setup.server.close();
    }
  });

  it('answers ["usdc"] when only operatorAddressEvm is set', async () => {
    const setup = await startApp({ evm: '0xOperatorEvm00000000000000000000000000' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
      }, setup.agent);
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.payableRails).toEqual(['usdc']);
    } finally {
      setup.server.close();
    }
  });

  it('answers [] when neither address is set', async () => {
    const setup = await startApp({});
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
      }, setup.agent);
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.payableRails).toEqual([]);
    } finally {
      setup.server.close();
    }
  });
});

describe('payableRails: once a deposit has settled, only that deposit\'s currency, even before confirm runs', () => {
  it('an open quote reports only the settled deposit\'s rail while still proposed', async () => {
    const setup = await startApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      await postSigned(setup.baseUrl, `/jobs/${jobId}/criteria`, {
        criteria: [{ text: 'The login bug is fixed', proposedBy: 'agent' }],
        priceUsd: '500.00',
      }, setup.agent);
      // Settle the deposit directly on the repo (the same shortcut this
      // suite's other fixtures take), without driving the full wallet
      // protocol: this test is about the projection, not the settlement
      // mechanics.
      await setup.settlementRepo.record({
        jobId,
        leg: 'deposit',
        rail: 'usdc',
        hash: 'hash-deposit-1',
        secondaryHash: null,
        operatorAddress: '0xOperatorEvm00000000000000000000000000',
        feeAddress: '0xFee',
        amountUsd: '125.00',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.status).toBe('proposed');
      expect(body.payableRails).toEqual(['usdc']);
    } finally {
      setup.server.close();
    }
  });
});

describe('payableRails: omitted before a price exists, per the same conditional stance githubAccessNeeded takes', () => {
  it('a draft with no price carries no payableRails key', async () => {
    const setup = await startApp({ abt: 'z1OperatorAbt', evm: '0xOperatorEvm00000000000000000000000000' });
    try {
      const jobId = await openDraft(setup.baseUrl, setup.buyer, setup.agent);
      const read = await fetch(`${setup.baseUrl}/jobs/${jobId}`);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body.payableRails).toBeUndefined();
    } finally {
      setup.server.close();
    }
  });
});
