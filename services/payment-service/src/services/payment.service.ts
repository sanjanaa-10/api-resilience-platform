import type { PayloadContext } from '../../../shared/src/types';
import type { PaymentResult } from '../types/payment.types';

const CURRENCIES: readonly string[] = ['USD', 'EUR', 'GBP'];
const METHODS = ['card', 'bank_transfer', 'wallet'] as const;

/** Generates a realistic randomized payment confirmation payload. */
export function buildPaymentPayload(context: PayloadContext): PaymentResult {
  const currency = CURRENCIES[Math.floor(Math.random() * CURRENCIES.length)] ?? 'USD';
  const method = METHODS[Math.floor(Math.random() * METHODS.length)] ?? 'card';

  return {
    transactionId: `txn_${context.requestId.replaceAll('-', '').slice(0, 12)}`,
    amount: Number((Math.random() * 499 + 1).toFixed(2)),
    currency,
    method,
    status: 'captured',
    processedAt: new Date().toISOString(),
  };
}
