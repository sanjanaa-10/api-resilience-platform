type ErrorDetails = Record<string, unknown> | undefined;

/**
 * Application-level error carrying an HTTP status code.
 * `isOperational` separates expected failures (bad input, simulated offline)
 * from programmer errors (bugs).
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly details: ErrorDetails;

  constructor(statusCode: number, message: string, details?: ErrorDetails, isOperational = true) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;

    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Bad request.', details?: ErrorDetails): ApiError {
    return new ApiError(400, message, details);
  }

  static notFound(message = 'Resource not found.'): ApiError {
    return new ApiError(404, message);
  }
}
