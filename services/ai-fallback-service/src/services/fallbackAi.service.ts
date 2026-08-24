import type { PayloadContext } from '../../../shared/src/types';
import type { AiCompletionResult } from '../types/ai.types';

/**
 * Distinct model ids make failover externally observable: any response whose
 * model ends in "-fallback" was served by the secondary provider.
 */
const MODELS: readonly string[] = ['rf-mini-v2-fallback', 'rf-flash-1-fallback'];
const COMPLETIONS: readonly string[] = [
  'Served by the fallback provider — primary was unavailable.',
  'Fallback path completed the request successfully.',
];

/** Generates a realistic randomized AI completion payload (fallback flavor). */
export function buildFallbackAiPayload(_context: PayloadContext): AiCompletionResult {
  const model = MODELS[Math.floor(Math.random() * MODELS.length)] ?? MODELS[0] ?? 'rf-mini-v2-fallback';
  const completion =
    COMPLETIONS[Math.floor(Math.random() * COMPLETIONS.length)] ?? COMPLETIONS[0] ?? '';

  return {
    model,
    promptTokens: 12 + Math.floor(Math.random() * 200),
    completionTokens: 8 + Math.floor(Math.random() * 120),
    completion,
    finishReason: 'stop',
  };
}
