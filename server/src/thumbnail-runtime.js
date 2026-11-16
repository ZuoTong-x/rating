export function withTimeout(promise, durationMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), durationMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
