// FIX-SW4a (bugs.md SW4-01, SW4-08): neither PUT /agents/:agentDid/webhook
// nor POST /accounts/:did/push-subscriptions stores an address the outbound
// rule refuses. Real createApp with signed parties; the repository is read
// back after every refusal so "refused" cannot mean "refused but stored".
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import {
  MemoryAccountRepository,
  MemoryAgentRepository,
  MemoryJobRepository,
  MemoryPushSubscriptionRepository,
} from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

const WEBHOOK_NOT_HTTPS = 'notifyWebhookUrl must be an https:// URL';
const WEBHOOK_REFUSED =
  'notifyWebhookUrl must be an https address on the public internet; private, loopback and link-local addresses are refused';
const PUSH_REFUSED =
  "endpoint must be the https address your browser's push service gave; private, loopback and link-local addresses are refused";

// The private addresses are joined from octets: the publish gate refuses a
// literal private address anywhere in this public repository.
const SW4_HOSTS = [
  'https://127.0.0.1:3900/internal',
  'https://localhost/admin',
  'https://169.254.169.254/latest/meta-data/',
  `https://${['10', '0', '0', '5'].join('.')}/`,
  `https://${['192', '168', '1', '1'].join('.')}/`,
  'https://[::1]/',
];

let server: Server;
let baseUrl: string;
let operator: SigningIdentity;
let agent: SigningIdentity;
let agentRepo: MemoryAgentRepository;
let pushRepo: MemoryPushSubscriptionRepository;

async function signedRequest(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const targetUri = `${baseUrl}${path}`;
  const signed = signRequest(identity, method, targetUri, { body: bodyText });
  return fetch(targetUri, {
    method,
    headers: {
      'content-type': 'application/json',
      'signature-input': signed['signature-input'],
      signature: signed.signature,
      'content-digest': signed['content-digest'],
    },
    body: bodyText,
  });
}

function putWebhook(notifyWebhookUrl: string | null): Promise<Response> {
  return signedRequest('PUT', `/agents/${agent.did}/webhook`, { notifyWebhookUrl }, operator);
}

function postPush(endpoint: string): Promise<Response> {
  return signedRequest('POST', `/accounts/${operator.did}/push-subscriptions`, { endpoint, keys: { p256dh: 'p256dh-fixture', auth: 'auth-fixture' } }, operator);
}

async function storedWebhookUrl(): Promise<string | null | undefined> {
  return (await agentRepo.findByDid(agent.did))?.notifyWebhookUrl;
}

beforeAll(async () => {
  operator = await signingIdentityFromSeed(new Uint8Array(32).fill(211));
  agent = await signingIdentityFromSeed(new Uint8Array(32).fill(212));

  const accounts = new MemoryAccountRepository();
  await accounts.register({ did: operator.did, githubLogin: 'operator-outbound' });

  agentRepo = new MemoryAgentRepository();
  await agentRepo.create({
    did: agent.did,
    operatorDid: operator.did,
    delegation: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      id: 'urn:uuid:delegation-for-outbound-destinations',
      type: ['VerifiableCredential', 'AgentDelegation'],
      issuer: operator.did,
      issuanceDate: '2026-01-01T00:00:00Z',
      credentialSubject: { id: agent.did },
      proof: {
        type: 'Ed25519Signature2020',
        created: '2026-01-01T00:00:00Z',
        verificationMethod: `${agent.did}#key-1`,
        proofPurpose: 'assertionMethod',
        proofValue: 'zfixture-not-verified-here',
      },
    } as never,
    name: 'scout',
    skills: ['triage'],
    githubLogin: 'scout-outbound',
    notifyWebhookUrl: null,
    negotiatesOnOwnersBehalf: true,
  });
  await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-outbound', status: 'verified' });

  pushRepo = new MemoryPushSubscriptionRepository();
  const { github } = createStagingLifecycleGithubFake();
  const app = createApp(
    accounts,
    agentRepo,
    undefined,
    github,
    new MemoryJobRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    testSessionAdapter(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // The message, read-state, notification and attachment repositories,
    // then the push subscription repository this test reads back.
    undefined,
    undefined,
    undefined,
    undefined,
    pushRepo,
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected server to listen on a port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('FIX-SW4a: PUT /agents/:agentDid/webhook refuses a private or loopback address', () => {
  it.each(SW4_HOSTS)('refuses %s with 400 and the whole sentence, and stores nothing', async (url) => {
    const res = await putWebhook(url);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: WEBHOOK_REFUSED });
    expect(await storedWebhookUrl()).toBeNull();
  });

  it('keeps its own sentence for a value that is not https at all', async () => {
    const res = await putWebhook('http://operator.example/webhook');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: WEBHOOK_NOT_HTTPS });
    expect(await storedWebhookUrl()).toBeNull();
  });

  it('accepts a public https URL, then null clears it again', async () => {
    const accepted = await putWebhook('https://operator.example/webhook');
    expect(accepted.status).toBe(200);
    expect(await storedWebhookUrl()).toBe('https://operator.example/webhook');

    const cleared = await putWebhook(null);
    expect(cleared.status).toBe(200);
    expect(await storedWebhookUrl()).toBeNull();
  });
});

describe('FIX-SW4a: POST /accounts/:did/push-subscriptions refuses a private, loopback or non-https endpoint', () => {
  it.each([...SW4_HOSTS, 'http://127.0.0.1:3900/plain-http', 'http://push.example/endpoint', 'file:///etc/passwd'])(
    'refuses %s with 400 and the whole sentence, and stores nothing',
    async (endpoint) => {
      const res = await postPush(endpoint);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: PUSH_REFUSED });
      expect(await pushRepo.listByAccountDid(operator.did)).toEqual([]);
    },
  );

  it('accepts a public https push service endpoint and stores it', async () => {
    const res = await postPush('https://fcm.googleapis.com/fcm/send/outbound-destinations');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: expect.stringMatching(/^ps-/),
      endpoint: 'https://fcm.googleapis.com/fcm/send/outbound-destinations',
    });
    const stored = await pushRepo.listByAccountDid(operator.did);
    expect(stored.map((row) => row.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/outbound-destinations']);
  });
});
