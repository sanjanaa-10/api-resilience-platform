export interface AiCompletionResult {
  model: string;
  promptTokens: number;
  completionTokens: number;
  completion: string;
  finishReason: 'stop';
}
