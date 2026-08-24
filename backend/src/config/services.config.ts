import { env } from './env';
import type { ProviderGroup, ServiceRegistration } from '../types';

/**
 * THE single source of truth for upstream topology.
 * Nothing else may hardcode a service URL or path — gateway routes,
 * proxying, health probing and failover groups are all derived here.
 *
 * Adding a new upstream = adding one registration + (optionally) placing
 * it in a provider group. Singleton groups simply list one provider.
 */
export const SERVICE_REGISTRATIONS: readonly ServiceRegistration[] = [
  {
    name: 'payment',
    displayName: 'payment-service',
    baseUrl: env.paymentBaseUrl ?? 'http://localhost:4101',
    healthPath: '/health',
    gatewayPath: '/payment',
    targetPath: '/api/payments/test',
  },
  {
    name: 'ai-primary',
    displayName: 'ai-primary-service',
    baseUrl: env.aiBaseUrl ?? 'http://localhost:4102',
    healthPath: '/health',
    gatewayPath: '/ai',
    targetPath: '/api/ai/test',
  },
  {
    name: 'ai-fallback',
    displayName: 'ai-fallback-service',
    baseUrl: env.aiFallbackBaseUrl ?? 'http://localhost:4104',
    healthPath: '/health',
    gatewayPath: '/ai-fallback',
    targetPath: '/api/ai/test',
  },
  {
    name: 'notification',
    displayName: 'notification-service',
    baseUrl: env.notificationBaseUrl ?? 'http://localhost:4103',
    healthPath: '/health',
    gatewayPath: '/notification',
    targetPath: '/api/notifications/test',
  },
];

function byName(name: string): ServiceRegistration {
  const found = SERVICE_REGISTRATIONS.find((entry) => entry.name === name);
  if (!found) throw new Error(`Unknown provider "${name}" in provider group definition.`);
  return found;
}

/**
 * Failover topology: ordered equivalent providers behind ONE public route.
 * providers[0] is the primary; later entries are fallbacks tried in order,
 * subject to the failover budget, health gate and circuit admission.
 */
export const PROVIDER_GROUPS: readonly ProviderGroup[] = [
  {
    id: 'ai',
    displayName: 'AI provider group',
    gatewayPath: '/ai',
    targetPath: '/api/ai/test',
    providers: [byName('ai-primary'), byName('ai-fallback')],
  },
  {
    id: 'payment',
    displayName: 'Payment provider group',
    gatewayPath: '/payment',
    targetPath: '/api/payments/test',
    providers: [byName('payment')],
  },
  {
    id: 'notification',
    displayName: 'Notification provider group',
    gatewayPath: '/notification',
    targetPath: '/api/notifications/test',
    providers: [byName('notification')],
  },
];
