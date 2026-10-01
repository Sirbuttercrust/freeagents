// HT1 Part B (STEER item 4, 2026-09-25): "call it with a small signed
// JSON event (job id, event type, time; never the message body),
// fire-and-forget with a short timeout." node:crypto only, no new
// dependency: the signature is an HMAC-SHA256 over the exact JSON bytes
// sent, keyed by a deployment secret, in the same header shape GitHub's
// and Stripe's own webhook signatures use (`sha256=<hex>`) so a
// receiving operator can verify the call came from this platform with
// off-the-shelf tooling on their end, no FreeAgents-specific library
// required.
//
// FAIL-CLOSED, FIRE-AND-FORGET: a delivery failure (network error,
// non-2xx, timeout) is swallowed here -- this is a best-effort notify,
// never a step a job's own state machine waits on. The caller never
// awaits a retry; there is exactly one attempt per event.
//
// FIX-SW4a (SW4-01): the platform never posts to a private,
// loopback or link-local address. send() first asks the domain rule
// (isOutboundDestinationAllowed) about the stored URL, which stops an
// address stored before that rule existed and any IP-literal host, and then
// posts with node:https through the guarded agent, which refuses a host
// NAME that resolves to an internal address (public-only-agent.ts). fetch
// is not used: Node's global fetch ignores an `agent` option, so the
// resolve-time check would never run. node:https never follows a redirect,
// so a public URL cannot bounce the request to an internal one; a 3xx
// answer is read like any other response and dropped.
import { createHmac } from 'node:crypto';
import { request, type Agent } from 'node:https';
import { webhookPayloadFor, type Notification } from '../../domain/notification.js';
import { isOutboundDestinationAllowed } from '../../domain/outbound-destination.js';
import { createPublicOnlyAgent } from '../outbound/public-only-agent.js';

const DELIVERY_TIMEOUT_MS = 5_000;

export interface WebhookSender {
  send(url: string, notification: Notification): Promise<void>;
}

function signaturePrefix(): string {
  return 'sha256=';
}

// Exported for the test suite: computes the identical HMAC a real
// deployment would, over the identical canonical JSON string, so a test
// can assert the header without duplicating the signing logic by hand.
export function signWebhookBody(secret: string, body: string): string {
  return signaturePrefix() + createHmac('sha256', secret).update(body).digest('hex');
}

// FREEAGENTS_WEBHOOK_SIGNING_SECRET: a deployment secret, never in code
// (CLAUDE.md, "secrets never enter code"). An unconfigured deployment
// still delivers the event, unsigned, with a console.warn -- the same
// "still functions, announces itself" stance platformIssuerFromEnv
// takes on FREEAGENTS_PLATFORM_SEED, since withholding the whole
// notification feature over a missing signing secret would be a worse
// failure than delivering an unsigned one during early setup.
export function webhookSigningSecretFromEnv(): string | null {
  const secret = process.env.FREEAGENTS_WEBHOOK_SIGNING_SECRET || '';
  if (secret === '') {
    console.warn(
      'webhook: FREEAGENTS_WEBHOOK_SIGNING_SECRET is not set; outgoing webhook events will be sent unsigned.',
    );
    return null;
  }
  return secret;
}

export function createWebhookSender(options?: {
  readonly secret?: string | null;
  // Tests inject an agent with their own resolver; production builds the
  // guarded agent that resolves with dns.lookup and the domain's rule.
  readonly agent?: Agent;
  readonly timeoutMs?: number;
}): WebhookSender {
  const secret = options?.secret ?? webhookSigningSecretFromEnv();
  const agent = options?.agent ?? createPublicOnlyAgent();
  const timeoutMs = options?.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return {
    // Total: never throws or rejects past this method's own boundary.
    // The brief's own words: "fire-and-forget with a short timeout" --
    // this call site is not on any request's critical path, and a
    // caller's operator-controlled webhook endpoint being slow or down
    // must never slow down or fail the job action that triggered it.
    async send(url: string, notification: Notification): Promise<void> {
      if (!isOutboundDestinationAllowed(url)) return;
      const body = JSON.stringify(webhookPayloadFor(notification));
      const headers: Record<string, string | number> = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      };
      if (secret !== null) {
        headers['x-freeagents-signature'] = signWebhookBody(secret, body);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await new Promise<void>((resolve, reject) => {
          const outgoing = request(url, { method: 'POST', headers, agent, signal: controller.signal }, (response) => {
            // The status is deliberately not inspected; the body is drained
            // so the socket is released.
            response.on('error', reject);
            response.on('end', resolve);
            response.resume();
          });
          outgoing.on('error', reject);
          outgoing.end(body);
        });
      } catch {
        // Fire-and-forget: a refused address, a network error, a timeout,
        // or a non-2xx response (deliberately not inspected here) never
        // propagates.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
