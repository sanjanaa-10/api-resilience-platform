import type { PayloadContext } from '../../../shared/src/types';
import type { AiCompletionResult } from '../types/ai.types';

const MODELS: readonly string[] = ['rf-mini-v2', 'rf-flash-1', 'rf-summarize-3'];
const COMPLETIONS: readonly string[] = [
  'The request has been processed successfully.',
  'Summary: upstream systems are operating normally.',
  'Analysis complete — no anomalies detected in the provided payload.',
  'Here is the generated answer based on the supplied context.',
];

/** Generates a realistic randomized AI completion payload. */
export function buildAiPayload(_context: PayloadContext): AiCompletionResult {
  const model = MODELS[Math.floor(Math.random() * MODELS.length)] ?? 'rf-mini-v2';
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
