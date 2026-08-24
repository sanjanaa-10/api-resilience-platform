import type { SimulationConfigPatch } from '../types';

export type ValidationResult =
  | { ok: true; patch: SimulationConfigPatch }
  | { ok: false; errors: string[] };

/** Upper sanity bound so a typo cannot freeze every socket on the machine. */
const MAX_LATENCY_MS = 60_000;

/**
 * Strictly validates a partial simulation config patch.
 * Unknown fields are ignored; known fields must match their exact type and
 * range. Never throws — callers receive a list of human-readable errors and
 * decide how to respond (the controller turns them into a 400 envelope).
 */
export function validateSimulationPatch(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['Request body must be a JSON object.'] };
  }

  const record = input as Record<string, unknown>;
  const patch: SimulationConfigPatch = {};
  const errors: string[] = [];

  if ('online' in record) {
    if (typeof record['online'] === 'boolean') {
      patch.online = record['online'];
    } else {
      errors.push('"online" must be a boolean.');
    }
  }

  if ('latencyMs' in record) {
    const value = record['latencyMs'];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LATENCY_MS) {
      patch.latencyMs = value;
    } else {
      errors.push(`"latencyMs" must be an integer between 0 and ${MAX_LATENCY_MS}.`);
    }
  }

  if ('failureRate' in record) {
    const value = record['failureRate'];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
      patch.failureRate = value;
    } else {
      errors.push('"failureRate" must be a number between 0 and 100.');
    }
  }

  if ('failureStatus' in record) {
    const value = record['failureStatus'];
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 400 &&
      value <= 599
    ) {
      patch.failureStatus = value;
    } else {
      errors.push('"failureStatus" must be an integer between 400 and 599.');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch };
}
