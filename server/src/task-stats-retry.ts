const retryableCodes = new Set(["40001", "40P01", "55P03"]);

export async function retryTaskStatsRefresh<T>(
  callback: () => Promise<T>,
  onRetry?: (error: unknown, attempt: number) => void,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (!code || !retryableCodes.has(code) || attempt === 3) throw error;
      onRetry?.(error, attempt + 1);
      await wait(150 * (2 ** attempt));
    }
  }
  throw new Error("Task statistics refresh exhausted retries");
}
