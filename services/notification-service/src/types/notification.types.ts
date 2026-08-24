export interface NotificationReceipt {
  channel: 'email' | 'sms' | 'push';
  recipient: string;
  messageId: string;
  priority: 'normal' | 'high';
  queuedAt: string;
}
