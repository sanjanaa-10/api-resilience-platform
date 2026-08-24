import type { ServiceDefinition } from '../../../shared/src/types';
import { buildAiPayload } from '../services/ai.service';
import type { AiCompletionResult } from '../types/ai.types';

export const aiServiceDefinition: ServiceDefinition<AiCompletionResult> = {
  name: 'ai-service',
  port: 4102,
  testEndpointPath: '/api/ai/test',
  defaultLatencyMs: 800,
  buildPayload: buildAiPayload,
};
