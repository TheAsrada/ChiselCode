import { RuntimeError } from "../../src/runtime/errors.js";

/** Only initial provisioning may retry: assertions, activation and protocol errors must fail. */
export async function withLspPreparationRetry<T>(
  operation: () => Promise<T>,
  reset: (error: RuntimeError) => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      !(error instanceof RuntimeError) ||
      error.code !== "WEB_HTTP_ERROR" ||
      error.details?.retryable !== true ||
      ![502, 503, 504].includes(Number(error.details.status))
    )
      throw error;
    await reset(error);
    await Bun.sleep(1000);
    // One more attempt, outside the catch: a persistent refusal remains a failure.
    return operation();
  }
}
