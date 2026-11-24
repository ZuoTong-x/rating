import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type UserRow = {
  id: string;
  username: string;
  role: string;
  status?: string | null;
  failedLoginAttempts?: number | null;
  failedLoginWindowStart?: string | null;
};
type SessionUser = { id: string; username: string; role: string; mustChangePassword?: boolean };
type AuthedRequest = Request & { auth?: SessionUser | null };
type AuthError = Error & { retryAfterSeconds?: number };

type AuthSessionDependencies = {
  httpError: (status: number, message: string, code?: string) => Error;
  nowIso: () => string;
  userDto: (user: UserRow) => Promise<SessionUser | null>;
  scorerAvailabilityError: (user: UserRow) => Promise<Error | null>;
  authAccountFailureLimit: number;
  authCaptchaSecret: string;
  authCaptchaTtlMs: number;
  authFailureWindowMs: number;
  authAccountLockMs: number;
  sessionDurationMs: number;
  sessionSeenWriteAt: Map<string, number>;
  sessionSeenWriteIntervalMs: number;
  deleteExpiredCaptchaChallengesStmt: Statement;
  insertCaptchaChallengeStmt: Statement;
  selectCaptchaChallengeStmt: Statement;
  markCaptchaChallengeUsedStmt: Statement;
  selectAuthUsernameFailureCountStmt: Statement;
  insertAuthLoginAttemptStmt: Statement;
  updateUserLoginFailureStmt: Statement;
  clearUserLoginFailureStmt: Statement;
  deleteAuthLoginAttemptsForUsernameStmt: Statement;
  deleteExpiredSessionsStmt: Statement;
  insertSessionStmt: Statement;
  updateSessionSeenStmt: Statement;
  selectSessionUserStmt: Statement;
  deleteSessionStmt: Statement;
};

export function createAuthSessionService({
  httpError, nowIso, userDto, scorerAvailabilityError,
  authAccountFailureLimit, authCaptchaSecret, authCaptchaTtlMs,
  authFailureWindowMs, authAccountLockMs, sessionDurationMs,
  sessionSeenWriteAt, sessionSeenWriteIntervalMs,
  deleteExpiredCaptchaChallengesStmt, insertCaptchaChallengeStmt,
  selectCaptchaChallengeStmt, markCaptchaChallengeUsedStmt,
  selectAuthUsernameFailureCountStmt, insertAuthLoginAttemptStmt,
  updateUserLoginFailureStmt, clearUserLoginFailureStmt,
  deleteAuthLoginAttemptsForUsernameStmt, deleteExpiredSessionsStmt,
  insertSessionStmt, updateSessionSeenStmt, selectSessionUserStmt,
  deleteSessionStmt,
}: AuthSessionDependencies) {
function cookieValue(header: unknown, name: string) {
  const prefix = `${name}=`;
  const entry = String(header || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null;
  }
}

function sessionTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function loginRequestIp(req: Request) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 255);
}

function authCutoff(now: string, durationMs: number) {
  return new Date(new Date(now).getTime() - durationMs).toISOString();
}

function authLockError(message: string, retryAfterSeconds: number, code: string) {
  const error = httpError(429, message, code) as AuthError;
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return error;
}

function loginFailureWarning(user: UserRow | null | undefined, failedCount = Number(user?.failedLoginAttempts || 0)) {
  if (!user?.id || failedCount <= 0) return "";
  const remaining = Math.max(0, authAccountFailureLimit - failedCount);
  return `当前账号已失败 ${failedCount} 次，再失败 ${remaining} 次将锁定 10 分钟`;
}

function captchaHash(challengeId: string, answer: string) {
  return crypto
    .createHmac("sha256", authCaptchaSecret)
    .update(`${challengeId}:${String(answer).toUpperCase()}`)
    .digest("hex");
}

function randomCaptchaText() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

function escapeXml(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function captchaSvg(text: string) {
  const lines = Array.from({ length: 6 }, () => {
    const x1 = crypto.randomInt(0, 180);
    const y1 = crypto.randomInt(8, 52);
    const x2 = crypto.randomInt(0, 180);
    const y2 = crypto.randomInt(8, 52);
    const color = ["#64748b", "#94a3b8", "#475569", "#c2410c"][crypto.randomInt(4)];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.2"/>`;
  }).join("");
  const chars = [...text].map((char, index) => {
    const x = 18 + index * 32;
    const y = crypto.randomInt(35, 45);
    const rotate = crypto.randomInt(-16, 17);
    const color = ["#0f172a", "#1d4ed8", "#9a3412", "#166534"][crypto.randomInt(4)];
    return `<text x="${x}" y="${y}" fill="${color}" transform="rotate(${rotate} ${x} ${y})">${escapeXml(char)}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="56" viewBox="0 0 180 56"><rect width="180" height="56" rx="6" fill="#f8fafc"/>${lines}${chars}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function createLoginCaptcha() {
  const now = nowIso();
  await deleteExpiredCaptchaChallengesStmt.run(now);
  const id = crypto.randomUUID();
  const answer = randomCaptchaText();
  const expiresAt = new Date(Date.now() + authCaptchaTtlMs).toISOString();
  await insertCaptchaChallengeStmt.run({
    id,
    answerHash: captchaHash(id, answer),
    expiresAt,
    createdAt: now,
  });
  return { id, image: captchaSvg(answer), expiresAt };
}

async function consumeLoginCaptcha(challengeId: unknown, answer: unknown) {
  const id = String(challengeId || "").trim();
  const value = String(answer || "").trim().toUpperCase();
  if (!id || !value) return false;
  const challenge = await selectCaptchaChallengeStmt.get(id);
  if (!challenge || challenge.usedAt || new Date(String(challenge.expiresAt)).getTime() <= Date.now()) {
    return false;
  }
  const used = await markCaptchaChallengeUsedStmt.run(nowIso(), id);
  if (used.changes !== 1) return false;
  const expected = Buffer.from(String(challenge.answerHash || ""), "hex");
  const actual = Buffer.from(captchaHash(id, value), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function loginCaptchaRequired(username: string, user: UserRow | null | undefined, now: string) {
  const windowStart = authCutoff(now, authFailureWindowMs);
  if (
    user &&
    Number(user.failedLoginAttempts || 0) >= 1 &&
    user.failedLoginWindowStart &&
    new Date(user.failedLoginWindowStart).getTime() >= new Date(windowStart).getTime()
  ) {
    return true;
  }
  if (user) return false;
  const row = await selectAuthUsernameFailureCountStmt.get(username, windowStart);
  return Number(row?.failedCount || 0) >= 1;
}

async function recordLoginFailure(username: string, ip: string, user: UserRow | null | undefined, now: string) {
  const windowStart = authCutoff(now, authFailureWindowMs);
  await insertAuthLoginAttemptStmt.run({
    id: crypto.randomUUID(),
    username,
    ip,
    succeeded: false,
    createdAt: now,
  });

  let accountFailureCount = 0;
  let accountLockedUntil = null;
  if (user?.id) {
    const updated = await updateUserLoginFailureStmt.get({
      id: user.id,
      windowStart,
      lockedUntil: new Date(Date.now() + authAccountLockMs).toISOString(),
      now,
    });
    accountFailureCount = Number(updated?.failedLoginAttempts || 0);
    accountLockedUntil = updated?.lockedUntil ? String(updated.lockedUntil) : null;
  } else {
    const count = await selectAuthUsernameFailureCountStmt.get(username, windowStart);
    accountFailureCount = Number(count?.failedCount || 0);
  }

  return { accountFailureCount, accountLockedUntil };
}

async function clearLoginFailures(user: UserRow, username: string) {
  await clearUserLoginFailureStmt.run({
    id: user.id,
    lastLoginAt: nowIso(),
    updatedAt: nowIso(),
  });
  await deleteAuthLoginAttemptsForUsernameStmt.run(username);
}

async function createSession(user: { id: string }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  await deleteExpiredSessionsStmt.run(createdAt);
  await insertSessionStmt.run({
    tokenHash: sessionTokenHash(token),
    userId: user.id,
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
  });
  return { token, expiresAt };
}

function setSessionCookie(res: Response, token: string, expiresAt: string) {
  res.cookie("image_rating_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: sessionDurationMs,
    expires: new Date(expiresAt),
    path: "/",
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie("image_rating_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
  });
}

async function touchSessionSeenAt(tokenHash: string) {
  const now = Date.now();
  const lastWriteAt = sessionSeenWriteAt.get(tokenHash) || 0;
  if (now - lastWriteAt < sessionSeenWriteIntervalMs) return;

  await updateSessionSeenStmt.run(new Date(now).toISOString(), tokenHash);
  sessionSeenWriteAt.set(tokenHash, now);

  if (sessionSeenWriteAt.size > 10000) {
    for (const [hash, seenAt] of sessionSeenWriteAt) {
      if (now - seenAt >= sessionSeenWriteIntervalMs) {
        sessionSeenWriteAt.delete(hash);
      }
    }
  }
}

async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    if (req.method === "OPTIONS") return next();
    const token = cookieValue(req.headers.cookie, "image_rating_session");
    if (!token) return next(httpError(401, "请先登录"));

    const tokenHash = sessionTokenHash(token);
    const user = await selectSessionUserStmt.get(tokenHash, nowIso()) as UserRow | undefined;
    if (!user) {
      await deleteSessionStmt.run(tokenHash);
      sessionSeenWriteAt.delete(tokenHash);
      return next(httpError(401, "登录已过期，请重新登录"));
    }
    const availabilityError = await scorerAvailabilityError(user);
    if (availabilityError) {
      await deleteSessionStmt.run(tokenHash);
      sessionSeenWriteAt.delete(tokenHash);
      return next(availabilityError);
    }

    await touchSessionSeenAt(tokenHash);
    (req as AuthedRequest).auth = await userDto(user);
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return next();
  if ((req as AuthedRequest).auth?.role !== "admin") return next(httpError(403, "需要管理员权限"));
  return next();
}

function requireScorer(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return next();
  if ((req as AuthedRequest).auth?.role !== "scorer")
    return next(httpError(403, "需要打分账号权限"));
  return next();
}

function requirePasswordChanged(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "OPTIONS") return next();
  if ((req as AuthedRequest).auth?.mustChangePassword) {
    return next(httpError(403, "请先修改密码", "PASSWORD_CHANGE_REQUIRED"));
  }
  return next();
}
  return {
    cookieValue, sessionTokenHash, loginRequestIp, authCutoff, authLockError,
    loginFailureWarning, createLoginCaptcha, consumeLoginCaptcha,
    loginCaptchaRequired, recordLoginFailure, clearLoginFailures,
    createSession, setSessionCookie, clearSessionCookie,
    requireAuth, requireAdmin, requireScorer, requirePasswordChanged,
  };
}
