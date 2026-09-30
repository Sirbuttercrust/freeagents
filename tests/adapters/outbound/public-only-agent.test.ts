// FIX-SW4a (bugs.md SW4-01, SW4-08): the webhook sender and the push sender
// never open a connection to an internal address, whether the host is a
// literal or a name that resolves to one. A plain TCP server on the loopback
// interface counts connections; TLS never completes and does not need to,
// because the count is taken at accept time. Each "0 connections" pin has a
// positive control (d) proving the same sender reaches the server when the
// address rule allows it, so a sender that failed for some other reason
// cannot pass (a) to (c) by accident.
import { createECDH, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';

import { createPublicOnlyAgent, type OutboundResolver } from '../../../src/adapters/outbound/public-only-agent.js';
import { createPushSender } from '../../../src/adapters/push/push.js';
import { createWebhookSender } from '../../../src/adapters/webhook/webhook.js';
import type { Notification, PushSubscription as StoredPushSubscription } from '../../../src/domain/notification.js';

let server: Server;
let port: number;
let connections: number;

beforeEach(async () => {
  connections = 0;
  server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const HOST = 'destination.test';

function answers(...addresses: string[]): OutboundResolver {
  return async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

const notification: Notification = {
  id: 'n-1',
  accountDid: 'did:key:z6MkExample',
  jobId: 'job-1',
  eventType: 'quote_changed',
  createdAt: new Date('2026-09-30T00:00:00Z'),
  readAt: null,
};

const vapid = webpush.generateVAPIDKeys();

function pushSubscription(endpoint: string): StoredPushSubscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    id: 'ps-1',
    accountDid: 'did:key:z6MkExample',
    endpoint,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    createdAt: new Date('2026-09-30T00:00:00Z'),
  };
}

function pushSenderWith(agent: ReturnType<typeof createPublicOnlyAgent>): ReturnType<typeof createPushSender> {
  return createPushSender({ subject: 'mailto:ops@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, { agent });
}

function webhookSenderWith(agent: ReturnType<typeof createPublicOnlyAgent>): ReturnType<typeof createWebhookSender> {
  return createWebhookSender({ secret: null, agent, timeoutMs: 3_000 });
}

async function sendWebhook(url: string, agent: ReturnType<typeof createPublicOnlyAgent>): Promise<void> {
  await webhookSenderWith(agent).send(url, notification);
}

async function sendPush(url: string, agent: ReturnType<typeof createPublicOnlyAgent>): Promise<void> {
  await pushSenderWith(agent).send(pushSubscription(url), { title: 't', body: 'b', jobId: 'job-1' });
}

const SENDERS: ReadonlyArray<readonly [string, (url: string, agent: ReturnType<typeof createPublicOnlyAgent>) => Promise<void>]> = [
  ['webhook sender', sendWebhook],
  ['push sender', sendPush],
];

describe.each(SENDERS)('FIX-SW4a: the %s never connects to an internal address', (_name, send) => {
  it('(a) a host the resolver maps to 127.0.0.1 opens 0 connections', async () => {
    await send(`https://${HOST}:${port}/x`, createPublicOnlyAgent({ resolve: answers('127.0.0.1') }));
    expect(connections).toBe(0);
  });

  it('(a) a host the resolver maps to ::1 opens 0 connections', async () => {
    await send(`https://${HOST}:${port}/x`, createPublicOnlyAgent({ resolve: answers('::1') }));
    expect(connections).toBe(0);
  });

  it('(b) a resolver answering one public and then one internal address opens 0 connections', async () => {
    await send(`https://${HOST}:${port}/x`, createPublicOnlyAgent({ resolve: answers('8.8.8.8', '127.0.0.1') }));
    expect(connections).toBe(0);
  });

  it('(b) a resolver answering one internal and then one public address opens 0 connections', async () => {
    await send(`https://${HOST}:${port}/x`, createPublicOnlyAgent({ resolve: answers('127.0.0.1', '8.8.8.8') }));
    expect(connections).toBe(0);
  });

  it('(c) a stored literal https://127.0.0.1:<port>/ sent directly opens 0 connections', async () => {
    await send(`https://127.0.0.1:${port}/x`, createPublicOnlyAgent({ resolve: answers('8.8.8.8') }));
    expect(connections).toBe(0);
  });

  it('(c) a stored plain http:// address on the loopback interface opens 0 connections', async () => {
    await send(`http://127.0.0.1:${port}/x`, createPublicOnlyAgent({ resolve: answers('8.8.8.8') }));
    expect(connections).toBe(0);
  });

  it('(d) positive control: the same host with an address rule that allows 127.0.0.1 opens exactly 1 connection', async () => {
    await send(`https://${HOST}:${port}/x`, createPublicOnlyAgent({ resolve: answers('127.0.0.1'), isRefusedAddress: () => false }));
    expect(connections).toBe(1);
  });
});

describe('FIX-SW4a: the guarded agent names the host it refused', () => {
  it('rejects the lookup with an error that names the host and carries no partial answer', async () => {
    const agent = createPublicOnlyAgent({ resolve: answers('8.8.8.8', ['10', '0', '0', '5'].join('.')) });
    const lookup = (agent.options as { lookup: (h: string, o: object, cb: (e: Error | null, ...rest: unknown[]) => void) => void }).lookup;
    const result = await new Promise<{ error: Error | null; rest: unknown[] }>((resolve) => {
      lookup(HOST, { all: true }, (error, ...rest) => resolve({ error, rest }));
    });
    expect(result.error?.message).toBe(`refusing to connect to ${HOST}: it resolves to an internal address`);
    expect(result.rest.filter((value) => value !== undefined)).toEqual([]);
  });
});
