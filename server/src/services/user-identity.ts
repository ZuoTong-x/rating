import crypto from "node:crypto";

type Statement = ReturnType<typeof import("../postgres.ts").db.prepare>;

type UserRow = {
  id: string;
  username: string;
  role: string;
  status?: string | null;
  mustChangePassword?: boolean | null;
  lastLoginAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export function createUserIdentityService({
  httpError, selectUserTeamsStmt, selectDisabledTeamForUserStmt, teamDto,
}: {
  httpError: (status: number, message: string, publicCode?: string) => Error;
  selectUserTeamsStmt: Statement;
  selectDisabledTeamForUserStmt: Statement;
  teamDto: (row: Record<string, unknown>) => unknown;
}) {
async function userDto(row: UserRow | null | undefined) {
  return row
    ? {
        id: row.id,
        username: row.username,
        role: row.role,
        teams: row.role === "scorer" ? (await selectUserTeamsStmt.all(row.id)).map(teamDto) : [],
        status: row.status || "enabled",
        mustChangePassword: Boolean(row.mustChangePassword),
        disabledByTeam: row.role === "scorer"
          ? Boolean(await selectDisabledTeamForUserStmt.get(row.id))
          : false,
        lastLoginAt: row.lastLoginAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function normalizeUsername(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, "请输入用户名");
  if (text.length > 100) throw httpError(400, "用户名不能超过 100 字");
  return text;
}

function parseUserPassword(value: unknown) {
  const text = String(value ?? "");
  if (!text) throw httpError(400, "密码不能为空", "PASSWORD_REQUIRED");
  if (text.length < 8) throw httpError(400, "密码至少需要 8 位", "PASSWORD_TOO_WEAK");
  if (text.length > 100) throw httpError(400, "密码不能超过 100 字", "PASSWORD_TOO_WEAK");
  if (!/[a-z]/.test(text)) throw httpError(400, "密码必须包含小写字母", "PASSWORD_TOO_WEAK");
  if (!/[A-Z]/.test(text)) throw httpError(400, "密码必须包含大写字母", "PASSWORD_TOO_WEAK");
  if (!/[^A-Za-z0-9]/.test(text)) throw httpError(400, "密码必须包含特殊字符", "PASSWORD_TOO_WEAK");
  return text;
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, storedPassword: unknown) {
  const value = String(storedPassword || "");
  const parts = value.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const expected = Buffer.from(parts[2], "hex");
  if (!expected.length) return false;
  const actual = crypto.scryptSync(password, parts[1], expected.length);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

async function scorerAvailabilityError(user: UserRow | null | undefined) {
  if (!user || user.role !== "scorer") return null;
  if ((user.status || "enabled") !== "enabled") {
    return httpError(403, "账号已禁用，请联系管理员");
  }
  const disabledTeam = await selectDisabledTeamForUserStmt.get(user.id);
  if (disabledTeam) {
    return httpError(403, `所属团队“${disabledTeam.name}”已禁用，无法登录`);
  }
  return null;
}

async function assertScorerAssignable(user: UserRow | null | undefined, scorerName = user?.username) {
  const error = await scorerAvailabilityError(user);
  if (!error) return;
  const message = String(error.message || "账号不可用").replace("，无法登录", "");
  throw httpError(400, `打分人 ${scorerName || ""}${message ? `：${message}` : "不可用"}`);
}
  return {
    userDto, normalizeUsername, parseUserPassword, hashPassword,
    verifyPassword, scorerAvailabilityError, assertScorerAssignable,
  };
}
