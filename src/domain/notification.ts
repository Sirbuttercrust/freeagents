// HT1 Part B (STEER item 4, 2026-09-25): "every new brief, message, quote
// change and sibling withdrawal notifies the agent's operator... Store a
// per-account notification row plus an unread count." Plain domain: a
// notification names WHO it is for (accountDid, the operator or the
// buyer), WHICH job it concerns, and WHAT happened (eventType), never the
// message body itself (the webhook's own "never the message body" rule,
// restated here for the stored notification row too -- a notification is
// a pointer the recipient follows back to the thread, not a copy of it).
export type NotificationEventType =
  | 'new_brief'
  | 'new_message'
  | 'quote_changed'
  | 'sibling_withdrawn';

export interface Notification {
  readonly id: string;
  // The account this notification is FOR: the agent's operator by
  // default (STEER: "the first line of communication... goes to the
  // owner"), or the buyer on the buyer's own threads (STEER: "and for
  // the buyer on the buyer's own threads").
  readonly accountDid: string;
  readonly jobId: string;
  readonly eventType: NotificationEventType;
  readonly createdAt: Date;
  // null until read. Monotonic, like ThreadReadState: marking read never
  // un-reads a notification already marked.
  readonly readAt: Date | null;
}

export class NotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationError';
  }
}

export function createNotification(input: {
  readonly id: string;
  readonly accountDid: string;
  readonly jobId: string;
  readonly eventType: NotificationEventType;
}, now: Date): Notification {
  if (input.accountDid.length === 0) {
    throw new NotificationError('a notification needs an accountDid');
  }
  return {
    id: input.id,
    accountDid: input.accountDid,
    jobId: input.jobId,
    eventType: input.eventType,
    createdAt: now,
    readAt: null,
  };
}

export function markNotificationRead(notification: Notification, now: Date): Notification {
  if (notification.readAt !== null) return notification;
  return { ...notification, readAt: now };
}

export function unreadCountOf(notifications: readonly Notification[]): number {
  return notifications.filter((n) => n.readAt === null).length;
}

// The one small signed JSON body a webhook call ever carries (STEER item
// 4: "call it with a small signed JSON event (job id, event type, time;
// never the message body)"). Pure shape, no signing here: signing is an
// adapter concern (src/adapters/webhook/webhook.ts), since it needs the
// platform's own key material.
export interface WebhookEventPayload {
  readonly jobId: string;
  readonly eventType: NotificationEventType;
  readonly at: string;
}

export function webhookPayloadFor(notification: Notification): WebhookEventPayload {
  return {
    jobId: notification.jobId,
    eventType: notification.eventType,
    at: notification.createdAt.toISOString(),
  };
}

// STEER item 4: "validate the URL as https-only." Total: any string in,
// one boolean out, never throws -- a malformed URL is simply not https,
// not a crash the caller has to catch.
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// HT1 Part B (STEER item 4): one browser Push API subscription, the
// standard shape a browser's own PushManager.subscribe() returns
// (endpoint plus the p256dh/auth key pair), recorded server-side so a
// later push can target it. Never the VAPID private key -- that is a
// deployment secret (FREEAGENTS_VAPID_PRIVATE_KEY), never stored per
// subscription.
export interface PushSubscription {
  readonly id: string;
  readonly accountDid: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly createdAt: Date;
}

