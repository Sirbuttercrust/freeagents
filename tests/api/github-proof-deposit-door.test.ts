// FIX-B47b2, Tests (b): the deposit door's login gate, before and after
// the one-click proof (FIX-B47b brief test (b), this card's own
// adjustment: "drive one deposit start door before and after... refused
// on the login step before the proof, past it after"). Red against
// 153af84: no route calls beginGitHubProofOAuth/completeGitHubProofOAuth
// yet, so the door's login refusal can never clear.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromRandom } from '@ocap/wallet';

import { createApp } from '../../src/api/app.js';
import { createIdentityAdapter } from '../../src/adapters/identity/identity.js';
import { createKnownKeyStore } from '../../src/adapters/identity/did-abt-resolver.js';
import { createSessionAdapter } from '../../src/adapters/identity/session-github-passkey.js';
import { fakeGitHubConfig, fakeGitHubFetch } from '../helpers/session-fixtures.js';
import { MemoryAgentRepository, MemoryAccountRepository, MemoryJobRepository, MemorySettlementRepository } from '../../src/adapters/storage/memory.js';
import { PrismaSettlementGate } from '../../src/adapters/payment/gate.js';
import { createUsdcPaymentRail, type UsdcChainClient } from '../../src/adapters/payment/usdc.js';
import { createAbtPaymentRail, type AbtChainClient } from '../../src/adapters/payment/abt.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';
import { anyCommitStagingObserver } from '../helpers/staging-fixtures.js';
import { signingIdentityFromWallet, signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { reservePort, withEnv, pureTxEncoder, abtEnv } from '../helpers/abt-fixtures.js';
import type { UsdcSpentTransferRow, UsdcSpentTransferStorage } from '../../src/adapters/payment/usdc-spent-transfer-storage-types.js';
import type { CreateGistInput, CreateGistResult, DeleteGistInput, DeleteGrantInput, Gist, GithubAdapter } from '../../src/adapters/github/types.js';
import { GistNotFoundError } from '../../src/adapters/github/types.js';

const USDC_TOKEN = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const USDC_FEE_ADDRESS = '0xFeeAddress000000000000000000000000000';
const USDC_OPERATOR_ADDRESS = '0xOperator000000000000000000000000000000';
const USDC_CHAIN_ID = 421614;
const FAKE_TOKEN = 'fake-access-token'; // fakeGitHubFetch's own hard-coded exchanged token.

function usdcEnvVars(): Record<string, string> {
  return {
    FREEAGENTS_USDC_RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
    FREEAGENTS_USDC_TOKEN_CONTRACT: USDC_TOKEN,
    FREEAGENTS_USDC_CHAIN_ID: String(USDC_CHAIN_ID),
    FREEAGENTS_USDC_FEE_ADDRESS: USDC_FEE_ADDRESS,
  };
}
function fakeUsdcChainClient(): UsdcChainClient {
  return { decimals: async () => 6, getTransactionReceipt: async () => null };
}
function fakeSpentTransferStorage(): UsdcSpentTransferStorage {
  const rows = new Map<string, UsdcSpentTransferRow>();
  return {
    async record(row) { rows.set(row.hash, { ...row }); },
    async findByHash(hash) { return rows.get(hash) ?? null; },
  };
}
function fakeAbtChainClientNoop(): AbtChainClient {
  return { getTransaction: async () => null } as unknown as AbtChainClient;
}

async function postSigned(baseUrl: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, 'POST', targetUri, { body: bodyText });
  return fetch(targetUri, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'signature-input': signed['signature-input'], signature: signed.signature, 'content-digest': signed['content-digest'] },
    body: bodyText,
  });
}

const twoLineProposal = [
  { text: 'The login bug is fixed', proposedBy: 'agent' },
  { text: 'Checkout e2e test passes', proposedBy: 'agent' },
];

// Layers the proof callback's own three calls (createGist, deleteGist,
// deleteGrant) and getPublicGist on top of the working staging fixture, so
// ONE github adapter instance serves both the deposit door's ready-
// repository reads and the proof callback's gist round trip.
function fakeGithubWithProof(login: string): { readonly github: GithubAdapter; readonly createGistCalls: CreateGistInput[] } {
  const staging = createStagingLifecycleGithubFake();
  const gists = new Map<string, Gist>();
  const createGistCalls: CreateGistInput[] = [];
  const github: GithubAdapter = {
    ...staging.github,
    getPublicGist: (ref) => {
      const gist = gists.get(ref.id);
      if (gist === undefined) return Promise.reject(new GistNotFoundError(ref.id));
      return Promise.resolve(gist);
    },
    createGist: (input: CreateGistInput): Promise<CreateGistResult> => {
      createGistCalls.push(input);
      const id = `fake-gist-${randomUUID()}`;
      const owner = input.token === FAKE_TOKEN ? login : null;
      gists.set(id, { id, owner, files: { [input.filename]: input.content } });
      return Promise.resolve({ id });
    },
    deleteGist: (input: DeleteGistInput): Promise<void> => {
      gists.delete(input.id);
      return Promise.resolve();
    },
    deleteGrant: (_input: DeleteGrantInput): Promise<void> => Promise.resolve(),
  };
  return { github, createGistCalls };
}

describe('FIX-B47b2 test (b): a deposit-start door refuses the login step before the one-click proof, and passes it after', () => {
  it('POST /jobs/:jobId/payments/deposit/usdc/start: refuses on the login step before the proof, past it once the agent verifies', async () => {
    const savedSeed = process.env.FREEAGENTS_PLATFORM_SEED;
    process.env.FREEAGENTS_PLATFORM_SEED = 'b47b2d00'.padEnd(64, '0');
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = 'octo-deposit-door-proof';
    const { github, createGistCalls } = fakeGithubWithProof(login);

    try {
      await withEnv({ ...usdcEnvVars(), ...abtEnv(baseUrl, fromRandom(), fromRandom().address, fromRandom().address) }, async () => {
        const buyerWallet = fromRandom();
        const buyer = await signingIdentityFromWallet(buyerWallet);
        // The agent's operator is a SEPARATE account from the buyer, so
        // the job's agreement can be signed on both sides for real and
        // the one-click proof's own operator gate is exercised as the
        // agent's real operator, not a self-hire shortcut.
        const agentOperator = await signingIdentityFromSeed(new Uint8Array(32).fill(233));
        const identity = createIdentityAdapter(createKnownKeyStore());
        const usdcRail = createUsdcPaymentRail({
          chainClient: fakeUsdcChainClient(),
          rateSource: async () => '1',
          halfPaidStorage: { record: async () => {}, read: async () => null, clear: async () => {} },
          spentTransferStorage: fakeSpentTransferStorage(),
        });
        const abtRail = createAbtPaymentRail({
          chainClient: fakeAbtChainClientNoop(),
          rateSource: async () => '1',
          spentTransferStorage: { async record() {}, async findByHash() { return null; } },
        });

        const operatorRepo = new MemoryAccountRepository();
        await operatorRepo.register({ did: buyer.did, githubLogin: `buyer-deposit-door-proof-${Math.random()}` });
        await operatorRepo.setOperatorAddressEvm(buyer.did, USDC_OPERATOR_ADDRESS);
        await operatorRepo.register({ did: agentOperator.did, githubLogin: `agent-operator-deposit-door-proof-${Math.random()}` });
        await operatorRepo.setOperatorAddressEvm(agentOperator.did, `0xAgentOperator${String(Math.floor(Math.random() * 1e9)).padStart(24, '0')}`);

        const agentRepo = new MemoryAgentRepository();
        const credentialId = `urn:uuid:${randomUUID()}`;
        const derived = await identity.createAgentDid(agentOperator.did, credentialId);
        const agentDid = derived.did;
        await agentRepo.create({
          did: agentDid,
          operatorDid: agentOperator.did,
          delegation: {
            '@context': ['https://www.w3.org/2018/credentials/v1'],
            id: credentialId,
            type: ['VerifiableCredential', 'AgentDelegation'],
            issuer: agentOperator.did,
            issuanceDate: '2026-01-01T00:00:00Z',
            credentialSubject: { id: agentDid, delegationSignedBy: 'platform' },
            proof: {
              type: 'Ed25519Signature2020',
              created: '2026-01-01T00:00:00Z',
              verificationMethod: `${agentOperator.did}#zPlatformKeyHash`,
              proofPurpose: 'assertionMethod',
              proofValue: 'zfixture-not-verified-here',
            },
          },
          name: 'scout',
          skills: ['triage'],
          githubLogin: null,
          negotiatesOnOwnersBehalf: true,
        });

        const jobRepo = new MemoryJobRepository();
        const settlementRepo = new MemorySettlementRepository();
        const gate = new PrismaSettlementGate(settlementRepo);
        const sessionAdapter = createSessionAdapter({ github: fakeGitHubConfig(), fetchImpl: fakeGitHubFetch({ login, id: 77001 }) });

        const app = createApp(
          operatorRepo, agentRepo, identity, github, jobRepo, undefined, undefined, undefined, undefined, undefined, undefined,
          sessionAdapter, undefined, gate, anyCommitStagingObserver(), undefined, abtRail, usdcRail, settlementRepo, pureTxEncoder,
        );
        const server = app.listen(port, '127.0.0.1');
        await new Promise<void>((resolve) => server.once('listening', resolve));

        try {
          const created = await postSigned(baseUrl, '/jobs', { buyerDid: buyer.did, agentDid, repository: 'buyer/target-repo', brief: 'Fix the login bug' }, buyer);
          expect(created.status).toBe(201);
          const jobId = String(((await created.json()) as Record<string, unknown>).id);

          // Walk the job all the way to fully signed (both parties, both
          // criteria lines and the price), so the ONLY thing standing
          // between this job and its deposit door is the login gate.
          await postSigned(baseUrl, `/jobs/${jobId}/criteria`, { criteria: twoLineProposal, priceUsd: '500.00', rail: 'usdc' }, agentOperator);
          await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, buyer);
          await postSigned(baseUrl, `/jobs/${jobId}/criteria/0/accept`, {}, agentOperator);
          await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, buyer);
          await postSigned(baseUrl, `/jobs/${jobId}/criteria/1/accept`, {}, agentOperator);
          await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, buyer);
          await postSigned(baseUrl, `/jobs/${jobId}/price/accept`, {}, agentOperator);

          // BEFORE the proof: the deposit door's own login-unverified 409.
          const beforeRes = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
          expect(beforeRes.status).toBe(409);
          const beforeBody = (await beforeRes.json()) as { error: string };
          expect(beforeBody.error).toContain('has not verified its GitHub account yet');

          // The one-click proof: the AGENT's OPERATOR starts it, then the
          // callback completes it.
          const startRes = await postSigned(baseUrl, `/agents/${agentDid}/github-proof/start`, {}, agentOperator);
          expect(startRes.status).toBe(200);
          const { redirectUrl } = (await startRes.json()) as { redirectUrl: string };
          const state = new URL(redirectUrl).searchParams.get('state')!;
          const callbackRes = await fetch(`${baseUrl}/auth/github/callback?code=any-code&state=${encodeURIComponent(state)}`);
          expect(callbackRes.status).toBe(200);
          expect(await callbackRes.json()).toEqual({ outcome: 'verified', agentDid });
          expect(createGistCalls).toHaveLength(1);
          expect(createGistCalls[0]!.token).toBe(FAKE_TOKEN);

          // AFTER the proof: the deposit door passes the login step. It
          // may still refuse for a different reason (repository facts,
          // real chain wiring in this fake harness), but never for the
          // login sentence.
          const afterRes = await postSigned(baseUrl, `/jobs/${jobId}/payments/deposit/usdc/start`, {}, buyer);
          if (afterRes.status === 409) {
            const afterBody = (await afterRes.json()) as { error: string };
            expect(afterBody.error).not.toContain('has not verified its GitHub account yet');
          } else {
            expect(afterRes.status).toBeLessThan(400);
          }
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    } finally {
      if (savedSeed === undefined) delete process.env.FREEAGENTS_PLATFORM_SEED;
      else process.env.FREEAGENTS_PLATFORM_SEED = savedSeed;
    }
  });
});
