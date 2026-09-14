export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public submissionUncertain = false,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
