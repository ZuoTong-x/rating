const retryableCodes = new Set(["40001", "40P01", "55P03"]);

export async function retryTaskStatsRefresh(callback, onRetry, wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 3) throw error;
      onRetry?.(error, attempt + 1);
      await wait(150 * (2 ** attempt));
    }
  }
}
