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
import webpush from 'web-push';
import type { PushSubscription as StoredPushSubscription } from '../../domain/notification.js';

export interface PushSender {
  // Fire-and-forget, same stance as the webhook sender: a push failure
  // (an expired subscription, a network error) never propagates past
  // this call, and never blocks the request that triggered it.
  send(subscription: StoredPushSubscription, payload: { readonly title: string; readonly body: string }): Promise<void>;
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

export function createPushSender(config: VapidConfig | null = vapidConfigFromEnv()): PushSender {
  if (config !== null) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }
  return {
    publicKey: config?.publicKey ?? null,
    async send(subscription, payload): Promise<void> {
      if (config === null) return;
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          JSON.stringify(payload),
        );
      } catch {
        // Fire-and-forget: an expired subscription (410 Gone), a
        // malformed endpoint, or a network error never propagates.
        // A caller that wants to prune dead subscriptions does so
        // through PushSubscriptionRepository.removeByEndpoint
        // separately; this method's job is only "try to deliver".
      }
    },
  };
}
