export function withTimeout(promise, durationMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), durationMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isDatabaseIntegrityError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code.startsWith("XX") || /unexpected (?:data beyond EOF|zero page)|invalid page in block|could not read block/i.test(message);
}
