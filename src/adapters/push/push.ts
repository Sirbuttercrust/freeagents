// HT1 Part B (STEER item 4, 2026-09-25): "add browser Web Push: the
// standard Push API with VAPID keys generated locally and stored in
// env... using the web-push npm package." web-push (web-push-libs,
// MPL-2.0, see this repository's PR body for the dependency
// justification CLAUDE.md requires) wraps the Web Push Protocol
// (RFC 8030) and VAPID (RFC 8292) so this adapter never hand-rolls the
// aes128gcm payload encryption. This is the only file in the repository
// that imports web-push, mirroring how src/adapters/github/github.ts is
// the only file that knows GitHub's REST shape exists.
//
// https://github.com/web-push-libs/web-push -- setVapidDetails(subject,
// publicKey, privateKey) once, then sendNotification(subscription,
// payload) per push. Keys are generated ONCE, locally, with
// `npx web-push generate-vapid-keys` (the package's own documented CLI)
// and stored as FREEAGENTS_VAPID_PUBLIC_KEY / FREEAGENTS_VAPID_PRIVATE_KEY
// env vars -- never in code, never committed (CLAUDE.md's secrets rule).
//
// FIX-SW4a (SW4-08): the platform never sends a push to a private,
// loopback or link-local address, or to anything that is not https. send()
// first asks the domain rule (isOutboundDestinationAllowed) about the stored
// endpoint, which stops a row stored before that rule existed and any
// IP-literal host, and then hands sendNotification the guarded agent (the
// `agent` option, which web-push requires to be an https.Agent). That agent
// refuses an endpoint host NAME that resolves to an internal address
// (public-only-agent.ts). web-push uses https.request, which follows no
// redirect.
import type { Agent } from 'node:https';
import webpush from 'web-push';
import type { PushSubscription as StoredPushSubscription } from '../../domain/notification.js';
import { isOutboundDestinationAllowed } from '../../domain/outbound-destination.js';
import { createPublicOnlyAgent } from '../outbound/public-only-agent.js';

export interface PushSender {
  // Fire-and-forget, same stance as the webhook sender: a push failure
  // (an expired subscription, a network error) never propagates past
  // this call, and never blocks the request that triggered it.
  //
  // FIX-B56 (B56): jobId names the job the notification is
  // about, so the site's service worker can open that job's conversation
  // when the notification is clicked. Message text never rides here
  // (title and body are the fixed per-event-type sentences notify()
  // already sends, never the message body itself): a push can sit on
  // a lock screen, and the hire thread is readable only by the two
  // parties (MISSION.md's hire loop, line 78 to 81), never broadcast
  // past it.
  send(subscription: StoredPushSubscription, payload: { readonly title: string; readonly body: string; readonly jobId: string }): Promise<void>;
  readonly publicKey: string | null;
}

export interface VapidConfig {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

// FREEAGENTS_VAPID_SUBJECT/_PUBLIC_KEY/_PRIVATE_KEY: an unconfigured
// deployment gets a sender that silently no-ops (the same "still
// functions, announces itself once" stance webhookSigningSecretFromEnv
// takes) rather than a startup crash -- push is an enhancement, not a
// dependency the rest of the notification feature needs to function.
export function vapidConfigFromEnv(): VapidConfig | null {
  const publicKey = process.env.FREEAGENTS_VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.FREEAGENTS_VAPID_PRIVATE_KEY || '';
  const subject = process.env.FREEAGENTS_VAPID_SUBJECT || 'mailto:admin@example.com';
  if (publicKey === '' || privateKey === '') {
    console.warn(
      'push: FREEAGENTS_VAPID_PUBLIC_KEY/FREEAGENTS_VAPID_PRIVATE_KEY are not set; ' +
        'browser Web Push will be disabled until configured.',
    );
    return null;
  }
  return { subject, publicKey, privateKey };
}

// `options.agent` is for tests: they inject an agent with their own resolver.
export function createPushSender(
  config: VapidConfig | null = vapidConfigFromEnv(),
  options?: { readonly agent?: Agent },
): PushSender {
  const agent = options?.agent ?? createPublicOnlyAgent();
  if (config !== null) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }
  return {
    publicKey: config?.publicKey ?? null,
    async send(subscription, payload): Promise<void> {
      if (config === null) return;
      if (!isOutboundDestinationAllowed(subscription.endpoint)) return;
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(payload),
          { agent },
        );
      } catch {
        // Fire-and-forget: an expired subscription (410 Gone), a
        // malformed endpoint, or a network error never propagates.
        // A caller that wants to prune dead subscriptions does so
        // through PushSubscriptionRepository.removeForAccount
        // separately; this method's job is only "try to deliver".
      }
    },
  };
}
