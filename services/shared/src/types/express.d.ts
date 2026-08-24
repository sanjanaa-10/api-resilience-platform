declare global {
  namespace Express {
    interface Request {
      /** Correlation id assigned by the request logger middleware. */
      requestId: string;
    }
  }
}

export {};
