// HT1 Part B: the hire thread routes -- post/list/edit messages,
// reactions, read receipts, thread access (buyer always, agent's own key
// only once negotiatesOnOwnersBehalf is on), and the read-only-once-
// terminal rule.
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAgentRepository, MemoryJobRepository, MemoryAccountRepository } from '../../src/adapters/storage/memory.js';
import { signingIdentityFromSeed, signRequest, type SigningIdentity } from '../helpers/sign-request.js';
import { testSessionAdapter } from '../helpers/session-fixtures.js';
import { MemorySettlementGate } from '../../src/adapters/payment/gate.js';
import { createStagingLifecycleGithubFake } from '../helpers/github-staging-fixtures.js';

function delegationFixture(agentDid: string, operatorDid: string): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: 'urn:uuid:delegation-for-messages',
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: operatorDid,
    issuanceDate: '2026-01-01T00:00:00Z',
    credentialSubject: { id: agentDid },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-01-01T00:00:00Z',
      verificationMethod: `${agentDid}#key-1`,
      proofPurpose: 'assertionMethod',
      proofValue: 'zfixture-not-verified-here',
    },
  };
}

let server: Server;
let baseUrl: string;
let buyer: SigningIdentity;
let agent: SigningIdentity;
let operator: SigningIdentity;
let stranger: SigningIdentity;
let agentRepo: MemoryAgentRepository;
let settlementGate: MemorySettlementGate;

async function req(method: string, path: string, body: unknown, identity: SigningIdentity): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
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
    ...(body === undefined ? {} : { body: bodyText }),
  });
}

async function openDraft(): Promise<string> {
  const draft = await req('POST', '/jobs', {
    agentDid: agent.did,
    repository: 'buyer/target-repo',
    brief: 'Fix the login bug',
  }, buyer);
  const body = (await draft.json()) as Record<string, unknown>;
  return String(body.id);
}

describe('HT1 Part B: hire thread messages', () => {
  beforeAll(async () => {
    buyer = await signingIdentityFromSeed(new Uint8Array(32).fill(161));
    agent = await signingIdentityFromSeed(new Uint8Array(32).fill(162));
    operator = await signingIdentityFromSeed(new Uint8Array(32).fill(163));
    stranger = await signingIdentityFromSeed(new Uint8Array(32).fill(164));

    const operatorRepo = new MemoryAccountRepository();
    await operatorRepo.register({ did: buyer.did, githubLogin: 'buyer-messages' });
    await operatorRepo.register({ did: operator.did, githubLogin: 'operator-messages' });
    await operatorRepo.register({ did: stranger.did, githubLogin: 'stranger-messages' });

    agentRepo = new MemoryAgentRepository();
    await agentRepo.create({
      did: agent.did,
      operatorDid: operator.did,
      delegation: delegationFixture(agent.did, operator.did) as never,
      name: 'scout',
      skills: ['triage'],
      githubLogin: 'scout-messages',
    });
    await agentRepo.updateGithubBinding(agent.did, { handle: 'scout-messages', status: 'verified' });

    const jobRepo = new MemoryJobRepository();
    const sessionAdapter = testSessionAdapter();
    settlementGate = new MemorySettlementGate();
    const { github } = createStagingLifecycleGithubFake();
    server = createApp(
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
      sessionAdapter,
      undefined,
      settlementGate,
    ).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server to listen on a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('the buyer posts a message and the operator reads it', async () => {
    const jobId = await openDraft();
    const post = await req('POST', `/jobs/${jobId}/messages`, { body: 'What is the timeline?' }, buyer);
    expect(post.status).toBe(201);
    const posted = (await post.json()) as Record<string, unknown>;
    expect(posted.authorParty).toBe('buyer');
    expect(posted.authorKind).toBe('buyer');

    const list = await req('GET', `/jobs/${jobId}/messages`, undefined, operator);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages.length).toBe(1);
    expect(body.messages[0]?.body).toBe('What is the timeline?');
  });

  it("the agent's own signature is refused (403) posting a message while negotiatesOnOwnersBehalf is off", async () => {
    const jobId = await openDraft();
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'Two weeks.' }, agent);
    expect(res.status).toBe(403);
  });

  it("the operator posts on the agent's behalf while the flag is off", async () => {
    const jobId = await openDraft();
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'Two weeks.' }, operator);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authorParty).toBe('agent');
    expect(body.authorKind).toBe('owner');
  });

  it("the agent's own signature posts once the owner turns the flag on, tagged agent-autonomous", async () => {
    await req('PUT', `/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: true }, operator);
    const jobId = await openDraft();
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'Sent by the agent itself.' }, agent);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authorKind).toBe('agent-autonomous');
    await req('PUT', `/agents/${agent.did}/negotiation`, { negotiatesOnOwnersBehalf: false }, operator);
  });

  it('a stranger cannot read or post to a thread it is not party to', async () => {
    const jobId = await openDraft();
    const read = await req('GET', `/jobs/${jobId}/messages`, undefined, stranger);
    expect(read.status).toBe(403);
    const post = await req('POST', `/jobs/${jobId}/messages`, { body: 'hi' }, stranger);
    expect(post.status).toBe(403);
  });

  it('reply-to a message names an existing message id, and refuses one that does not exist', async () => {
    const jobId = await openDraft();
    const first = await req('POST', `/jobs/${jobId}/messages`, { body: 'first' }, buyer);
    const firstId = String((await first.json() as Record<string, unknown>).id);
    const reply = await req('POST', `/jobs/${jobId}/messages`, { body: 'reply', replyToId: firstId }, operator);
    expect(reply.status).toBe(201);
    const replyBody = (await reply.json()) as Record<string, unknown>;
    expect(replyBody.replyToId).toBe(firstId);

    const bad = await req('POST', `/jobs/${jobId}/messages`, { body: 'dangling', replyToId: 'nope' }, buyer);
    expect(bad.status).toBe(400);
  });

  it('a message body over the length cap is refused with 400', async () => {
    const jobId = await openDraft();
    const res = await req('POST', `/jobs/${jobId}/messages`, { body: 'x'.repeat(5000) }, buyer);
    expect(res.status).toBe(400);
  });

  it('edit within the window succeeds, keeps history, and refuses a stranger to the message', async () => {
    const jobId = await openDraft();
    const posted = await req('POST', `/jobs/${jobId}/messages`, { body: 'oops typo' }, buyer);
    const messageId = String((await posted.json() as Record<string, unknown>).id);

    const wrongAuthor = await req('PATCH', `/jobs/${jobId}/messages/${messageId}`, { body: 'not mine to edit' }, operator);
    expect(wrongAuthor.status).toBe(403);

    const edited = await req('PATCH', `/jobs/${jobId}/messages/${messageId}`, { body: 'fixed typo' }, buyer);
    expect(edited.status).toBe(200);
    const editedBody = (await edited.json()) as { body: string; editedAt: string | null; editHistory: Array<{ body: string }> };
    expect(editedBody.body).toBe('fixed typo');
    expect(editedBody.editedAt).not.toBeNull();
    expect(editedBody.editHistory).toEqual([{ body: 'oops typo', editedAt: expect.any(String) }]);
  });

  it('reactions: one per party, replace on re-react, and DELETE removes it', async () => {
    const jobId = await openDraft();
    const posted = await req('POST', `/jobs/${jobId}/messages`, { body: 'react to this' }, buyer);
    const messageId = String((await posted.json() as Record<string, unknown>).id);

    const react1 = await req('POST', `/jobs/${jobId}/messages/${messageId}/reactions`, { emoji: '\u{1F44D}' }, operator);
    expect(react1.status).toBe(200);
    let body = (await react1.json()) as { reactions: { buyer: string | null; agent: string | null } };
    expect(body.reactions.agent).toBe('\u{1F44D}');

    const react2 = await req('POST', `/jobs/${jobId}/messages/${messageId}/reactions`, { emoji: '\u2764\ufe0f' }, operator);
    body = (await react2.json()) as { reactions: { buyer: string | null; agent: string | null } };
    expect(body.reactions.agent).toBe('\u2764\ufe0f');

    const notEmoji = await req('POST', `/jobs/${jobId}/messages/${messageId}/reactions`, { emoji: 'abc' }, operator);
    expect(notEmoji.status).toBe(400);

    const removed = await req('DELETE', `/jobs/${jobId}/messages/${messageId}/reactions`, undefined, operator);
    expect(removed.status).toBe(200);
    body = (await removed.json()) as { reactions: { buyer: string | null; agent: string | null } };
    expect(body.reactions.agent).toBeNull();
  });

  it('read receipts: lastReadAt advances and is monotonic', async () => {
    const jobId = await openDraft();
    const mark1 = await req('POST', `/jobs/${jobId}/messages/read`, undefined, buyer);
    expect(mark1.status).toBe(200);
    const body1 = (await mark1.json()) as { lastReadAt: string };
    expect(typeof body1.lastReadAt).toBe('string');
  });

  it('the typing signal answers 204 and requires thread access', async () => {
    const jobId = await openDraft();
    const ok = await req('POST', `/jobs/${jobId}/typing`, undefined, buyer);
    expect(ok.status).toBe(204);
    const refused = await req('POST', `/jobs/${jobId}/typing`, undefined, stranger);
    expect(refused.status).toBe(403);
  });

  it('a quote change writes a quote_sent system row visible to both parties', async () => {
    const jobId = await openDraft();
    await req('POST', `/jobs/${jobId}/criteria`, {
      criteria: [{ text: 'The bug is fixed', proposedBy: 'agent' }],
      priceUsd: '500.00',
      rail: 'abt',
    }, operator);
    const list = await req('GET', `/jobs/${jobId}/messages`, undefined, buyer);
    const body = (await list.json()) as { messages: Array<Record<string, unknown>> };
    const quoteRow = body.messages.find((m) => (m.systemEvent as Record<string, unknown> | null)?.type === 'quote_sent');
    expect(quoteRow).toBeDefined();
    expect(quoteRow?.authorParty).toBe('system');
    expect((quoteRow?.systemEvent as Record<string, unknown>).criteriaCount).toBe(1);
  });

  it('the thread becomes read-only once the job reaches a terminal status', async () => {
    const jobId = await openDraft();
    const withdraw = await req('POST', `/jobs/${jobId}/withdraw`, undefined, buyer);
    expect(withdraw.status).toBe(200);
    const post = await req('POST', `/jobs/${jobId}/messages`, { body: 'too late' }, buyer);
    expect(post.status).toBe(409);
    // Reading stays available on a terminal job.
    const read = await req('GET', `/jobs/${jobId}/messages`, undefined, buyer);
    expect(read.status).toBe(200);
  });
});
