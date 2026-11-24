export function withTimeout<T>(promise: Promise<T>, durationMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), durationMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isDatabaseIntegrityError(error: unknown): boolean {
  const detail = error as { code?: unknown; message?: unknown } | null;
  const code = String(detail?.code || "");
  const message = String(detail?.message || "");
  return code.startsWith("XX") || /unexpected (?:data beyond EOF|zero page)|invalid page in block|could not read block/i.test(message);
}
