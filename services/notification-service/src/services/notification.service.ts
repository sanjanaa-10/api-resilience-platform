import type { PayloadContext } from '../../../shared/src/types';
import type { NotificationReceipt } from '../types/notification.types';

const CHANNELS = ['email', 'sms', 'push'] as const;
const DOMAINS: readonly string[] = ['example.com', 'test.org', 'mail.dev'];

/** Generates a realistic randomized notification receipt payload. */
export function buildNotificationPayload(context: PayloadContext): NotificationReceipt {
  const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)] ?? 'email';
  const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)] ?? 'example.com';

  const lastDigits = String(Math.floor(Math.random() * 9000 + 1000));
  const recipient =
    channel === 'sms'
      ? `+1-555-***-${lastDigits}`
      : `${context.requestId.slice(0, 1)}user***@${domain}`;

  return {
    channel,
    recipient,
    messageId: `ntf_${context.requestId.replaceAll('-', '').slice(0, 12)}`,
    priority: Math.random() < 0.2 ? 'high' : 'normal',
    queuedAt: new Date().toISOString(),
  };
}
