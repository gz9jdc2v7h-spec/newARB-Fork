import { ethers } from "ethers";

/**
 * Runs an array of async tasks with bounded concurrency.
 */
export async function pLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]!();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  );
  return results;
}

/**
 * Retries an async fn up to `maxAttempts` with exponential back-off.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 100
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts a raw BigInt amount to a human-readable float.
 */
export function toFloat(amount: bigint, decimals: number): number {
  return Number(ethers.formatUnits(amount, decimals));
}

/**
 * Converts a human-readable float to a raw BigInt amount.
 */
export function toBigInt(amount: number, decimals: number): bigint {
  return ethers.parseUnits(amount.toFixed(decimals), decimals);
}

/**
 * Returns the current block timestamp in seconds.
 */
export function deadline(offsetSeconds = 120): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}
