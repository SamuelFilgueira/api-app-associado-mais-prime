export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const hasNextAttempt = attempt < attempts;

      if (!hasNextAttempt || !shouldRetry(error)) {
        throw error;
      }

      const nextDelayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(error, attempt, nextDelayMs);
      await sleep(nextDelayMs);
    }
  }

  throw lastError;
}
