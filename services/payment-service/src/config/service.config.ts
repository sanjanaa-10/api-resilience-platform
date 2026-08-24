import type { ServiceDefinition } from '../../../shared/src/types';
import { buildPaymentPayload } from '../services/payment.service';
import type { PaymentResult } from '../types/payment.types';

export const paymentServiceDefinition: ServiceDefinition<PaymentResult> = {
  name: 'payment-service',
  port: 4101,
  testEndpointPath: '/api/payments/test',
  defaultLatencyMs: 120,
  buildPayload: buildPaymentPayload,
};
