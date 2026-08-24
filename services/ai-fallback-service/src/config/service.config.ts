import type { ServiceDefinition } from '../../../shared/src/types';
import { buildFallbackAiPayload } from '../services/fallbackAi.service';
import type { AiCompletionResult } from '../types/ai.types';

/**
 * Secondary provider of the "ai" failover group. Exposes the SAME endpoint
 * contract as the primary (/api/ai/test) so the gateway can swap providers
 * transparently — only the payload's model id reveals who served.
 */
export const aiFallbackServiceDefinition: ServiceDefinition<AiCompletionResult> = {
  name: 'ai-fallback-service',
  port: 4104,
  testEndpointPath: '/api/ai/test',
  defaultLatencyMs: 800,
  buildPayload: buildFallbackAiPayload,
};
