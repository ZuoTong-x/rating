import { once } from "node:events";
import type { Writable } from "node:stream";

export function placeholders(length: number) {
  return Array.from({ length }, () => "?").join(",");
}

export function reportCompletionRate(completed: number, total: number) {
  return total ? completed / total : 0;
}

export async function writeResponseChunk(stream: Writable, chunk: string) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

export async function endResponseStream(stream: Writable, chunk = "") {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      stream.off("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    stream.once("finish", onFinish);
    stream.end(chunk);
  });
}

export function parseQueryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => parseQueryList(item));
  if (value == null) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseBooleanFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item: unknown) => parseBooleanFlag(item));
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}
