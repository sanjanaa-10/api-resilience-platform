declare global {
  namespace Express {
    interface Request {
      /** Correlation id — reused from X-Request-ID or freshly generated. */
      requestId: string;
      /** Where the correlation id came from: client header or gateway. */
      requestIdSource?: 'client' | 'gateway';
    }
  }
}

export {};
