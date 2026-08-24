export interface PaymentResult {
  transactionId: string;
  amount: number;
  currency: string;
  method: 'card' | 'bank_transfer' | 'wallet';
  status: 'captured';
  processedAt: string;
}
