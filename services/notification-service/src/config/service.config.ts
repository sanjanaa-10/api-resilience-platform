import type { ServiceDefinition } from '../../../shared/src/types';
import { buildNotificationPayload } from '../services/notification.service';
import type { NotificationReceipt } from '../types/notification.types';

export const notificationServiceDefinition: ServiceDefinition<NotificationReceipt> = {
  name: 'notification-service',
  port: 4103,
  testEndpointPath: '/api/notifications/test',
  defaultLatencyMs: 250,
  buildPayload: buildNotificationPayload,
};
