type Statement = ReturnType<typeof import("../postgres.ts").db.prepare>;
type LoginUser = {
  id: string; username: string; password: string;
  lockedUntil?: string | Date | null; role: string; status?: string | null;
};
type SessionUser = { id: string; username: string; role: string };

export function createLoginService({
  httpError, nowIso, normalizeUsername, parseUserPassword,
  verifyPassword, hashPassword, userDto, scorerAvailabilityError,
  consumeLoginCaptcha, authLockError, loginCaptchaRequired,
  loginFailureWarning, recordLoginFailure, clearLoginFailures,
  authAccountLockMs, selectUserAuthByUsernameStmt,
  selectScorerByUsernameStmt, selectUserByIdStmt, updateOwnPasswordStmt,
  deleteAuthLoginAttemptsForUsernameStmt, db,
}: {
  httpError: (status: number, message: string, publicCode?: string) => Error;
  nowIso: () => string;
  normalizeUsername: (value: unknown) => string;
  parseUserPassword: (value: unknown) => string;
  verifyPassword: (password: string, stored: unknown) => boolean;
  hashPassword: (password: string) => string;
  userDto: (row: LoginUser | null | undefined) => Promise<SessionUser | null>;
  scorerAvailabilityError: (user: LoginUser | null) => Promise<Error | null>;
  consumeLoginCaptcha: (id: string, answer: string) => Promise<boolean>;
  authLockError: (message: string, retryAfter: number, code: string) => Error;
  loginCaptchaRequired: (username: string, user: LoginUser | null, now: string) => Promise<boolean>;
  loginFailureWarning: (user: LoginUser | null, count?: number) => string;
  recordLoginFailure: (username: string, ip: string, user: LoginUser | null, now: string) => Promise<{ accountLockedUntil?: string | null; accountFailureCount: number }>;
  clearLoginFailures: (user: LoginUser, username: string) => Promise<unknown>;
  authAccountLockMs: number;
  selectUserAuthByUsernameStmt: Statement;
  selectScorerByUsernameStmt: Statement;
  selectUserByIdStmt: Statement;
  updateOwnPasswordStmt: Statement;
  deleteAuthLoginAttemptsForUsernameStmt: Statement;
  db: typeof import("../postgres.ts").db;
}) {
async function loginUser(body: Record<string, unknown> = {}, { ip = "unknown" }: { ip?: string } = {}) {
  // When a captcha is submitted, validate it before looking up the account or
  // checking the password. Invalid captcha attempts must not affect account
  // failure counters.
  const captchaId = String(body.captchaId ?? "").trim();
  const captchaAnswer = String(body.captchaAnswer ?? "").trim();
  const captchaProvided = Boolean(captchaId || captchaAnswer);
  if (captchaProvided) {
    const validCaptcha = captchaId && captchaAnswer
      ? await consumeLoginCaptcha(captchaId, captchaAnswer)
      : false;
    if (!validCaptcha) {
      throw httpError(401, "图形验证码不正确", "CAPTCHA_INVALID");
    }
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password ?? "");

  const now = nowIso();

  const user = (username === "admin"
    ? await selectUserAuthByUsernameStmt.get(username)
    : await selectScorerByUsernameStmt.get(username)) as LoginUser | undefined;
  if (user?.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    const retryAfterSeconds = Math.max(1, (new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
    throw authLockError("登录失败次数过多，请 10 分钟后重试", retryAfterSeconds, "LOGIN_LOCKED");
  }

  const captchaRequired = await loginCaptchaRequired(username, user || null, now);
  if (captchaRequired && !captchaProvided) {
    const warning = loginFailureWarning(user || null);
    throw httpError(
      428,
      warning ? `请先完成图形验证码。${warning}` : "请先完成图形验证码",
      "CAPTCHA_REQUIRED",
    );
  }

  if (!user || !verifyPassword(password, user.password)) {
    const failure = await recordLoginFailure(username, ip, user || null, now);
    if (failure.accountLockedUntil) {
      throw authLockError("登录失败次数过多，请 10 分钟后重试", authAccountLockMs / 1000, "LOGIN_LOCKED");
    }
    const warning = loginFailureWarning(user || null, failure.accountFailureCount);
    throw httpError(
      401,
      warning ? `用户名或密码不正确。${warning}` : "用户名或密码不正确",
      failure.accountFailureCount >= 1 ? "CAPTCHA_REQUIRED" : "INVALID_CREDENTIALS",
    );
  }

  const availabilityError = await scorerAvailabilityError(user);
  if (availabilityError) throw availabilityError;
  await clearLoginFailures(user, username);
  const loggedInUser = await userDto(await selectUserByIdStmt.get(user.id) as LoginUser | undefined);
  if (!loggedInUser) throw httpError(500, "登录账号不存在");
  return loggedInUser;
}

async function changeOwnPassword(userId: string, body: Record<string, unknown> = {}) {
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = parseUserPassword(body.newPassword);
  const user = await db
    .prepare("SELECT id, username, password, role FROM users WHERE id = ?")
    .get(userId) as LoginUser | undefined;
  if (!user || !verifyPassword(currentPassword, user.password)) {
    throw httpError(401, "当前密码不正确", "CURRENT_PASSWORD_INVALID");
  }
  if (currentPassword === newPassword) {
    throw httpError(400, "新密码不能与当前密码相同", "PASSWORD_REUSED");
  }
  await updateOwnPasswordStmt.run({
    id: user.id,
    password: hashPassword(newPassword),
    updatedAt: nowIso(),
  });
  await deleteAuthLoginAttemptsForUsernameStmt.run(user.username);
  return await userDto(await selectUserByIdStmt.get(user.id) as LoginUser | undefined);
}
  return { loginUser, changeOwnPassword };
}
