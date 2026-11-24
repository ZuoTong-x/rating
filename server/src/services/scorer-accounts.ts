import crypto from "node:crypto";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type Query = Record<string, unknown>;

type ScorerAccountDependencies = {
  db: typeof database;
  httpError: (status: number, message: string, code?: string) => Error;
  nowIso: () => string;
  parseTaskPagination: (query: Query) => { page: number; pageSize: number };
  parseQueryList: (value: unknown) => string[];
  normalizeTeamIds: (ids: string[]) => Promise<string[]>;
  parseOptionalDateFilter: (value: unknown, label: string) => string | null;
  escapeSqlLike: (value: unknown) => string;
  placeholders: (length: number) => string;
  userSelectColumns: string;
  userDto: (row: Record<string, unknown> | undefined) => Promise<unknown>;
  normalizeUsername: (value: unknown) => string;
  parseUserPassword: (value: unknown) => string;
  normalizeTeamNames: (value: unknown) => string[];
  selectUserByUsernameStmt: Statement;
  insertScorerUserStmt: Statement;
  hashPassword: (password: string) => string;
  syncUserTeams: (userId: string, teamNames: string[], now: string) => Promise<void>;
  selectScorerByUsernameStmt: Statement;
  selectUserByIdStmt: Statement;
  isUniqueConstraintError: (error: unknown) => boolean;
  parseEnabledStatus: (value: unknown, label: string, options: { optional: boolean }) => string | null;
  updateScorerUserStmt: Statement;
  selectAssignedTaskCountByScorerStmt: Statement;
  deleteScorerUserStmt: Statement;
};

export function createScorerAccountService({
  db, httpError, nowIso, parseTaskPagination, parseQueryList,
  normalizeTeamIds, parseOptionalDateFilter, escapeSqlLike,
  placeholders, userSelectColumns, userDto, normalizeUsername,
  parseUserPassword, normalizeTeamNames, selectUserByUsernameStmt,
  insertScorerUserStmt, hashPassword, syncUserTeams,
  selectScorerByUsernameStmt, selectUserByIdStmt,
  isUniqueConstraintError, parseEnabledStatus, updateScorerUserStmt,
  selectAssignedTaskCountByScorerStmt, deleteScorerUserStmt,
}: ScorerAccountDependencies) {
async function listScorerUsers(query: Query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const username = String(query.username ?? "").trim();
  const teamIds = await normalizeTeamIds(parseQueryList(query.teamIds ?? query.teamId));
  const lastLoginStart = parseOptionalDateFilter(
    query.lastLoginStart ?? query.loginStart,
    "登录开始日期",
  );
  const lastLoginEnd = parseOptionalDateFilter(
    query.lastLoginEnd ?? query.loginEnd,
    "登录结束日期",
  );
  if (lastLoginStart && lastLoginEnd && lastLoginStart > lastLoginEnd) {
    throw httpError(400, "登录开始日期不能晚于结束日期");
  }

  const clauses = ["users.role = 'scorer'"];
  const params: unknown[] = [];
  if (username) {
    clauses.push("users.username LIKE ? ESCAPE '\\'");
    params.push(`%${escapeSqlLike(username)}%`);
  }
  if (teamIds.length) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM user_teams
        WHERE user_teams.userId = users.id
          AND user_teams.teamId IN (${placeholders(teamIds.length)})
      )`,
    );
    params.push(...teamIds);
  }
  if (lastLoginStart) {
    clauses.push("users.lastLoginAt >= ?");
    params.push(lastLoginStart);
  }
  if (lastLoginEnd) {
    clauses.push("users.lastLoginAt <= ?");
    params.push(lastLoginEnd);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = (await db
    .prepare(`SELECT COUNT(*) AS total FROM users ${where}`)
    .get(...params)).total;
  const rows = await db
    .prepare(
      `SELECT ${userSelectColumns}
       FROM users
       ${where}
       ORDER BY createdAt DESC, LOWER(username) ASC, username ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    users: await Promise.all(rows.map(async user => await userDto(user))),
  };
}

async function createScorerUser(body: Query = {}) {
  const username = normalizeUsername(body.username);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  if (username === "admin") throw httpError(409, "admin 是管理员账号");
  const now = nowIso();
  await db.exec("BEGIN");
  try {
    if (await selectUserByUsernameStmt.get(username)) {
      throw httpError(409, "账号已存在");
    }
    const id = crypto.randomUUID();
    await insertScorerUserStmt.run({
      id,
      username,
      password: hashPassword(password),
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await syncUserTeams(id, teamNames, now);
    const user = await selectScorerByUsernameStmt.get(username);
    await db.exec("COMMIT");
    return await userDto(await selectUserByIdStmt.get(user.id));
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "账号已存在");
    }
    throw error;
  }
}

function normalizeBatchUsernames(value: unknown) {
  if (!Array.isArray(value)) throw httpError(400, "请输入打分人名单");
  const usernames: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const username = normalizeUsername(raw);
    if (username === "admin") continue;
    if (seen.has(username)) continue;
    seen.add(username);
    usernames.push(username);
  }
  if (!usernames.length) throw httpError(400, "请输入至少一个有效的打分人");
  if (usernames.length > 1000) throw httpError(400, "一次最多添加 1000 个账号");
  return usernames;
}

async function createScorerUsers(body: Query = {}) {
  const usernames = normalizeBatchUsernames(body.usernames);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  const skipped: Array<{ username: string; reason: string }> = [];
  const created: unknown[] = [];
  const now = nowIso();

  await db.exec("BEGIN");
  try {
    for (const username of usernames) {
      if (await selectUserByUsernameStmt.get(username)) {
        skipped.push({ username, reason: "账号已存在" });
        continue;
      }

      const id = crypto.randomUUID();
      await insertScorerUserStmt.run({
        id,
        username,
        password: hashPassword(password),
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await syncUserTeams(id, teamNames, now);
      created.push(await userDto(await selectUserByIdStmt.get(id)));
    }
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "账号已存在，请刷新后重试");
    }
    throw error;
  }

  return {
    users: created,
    createdCount: created.length,
    skipped,
    skippedCount: skipped.length,
  };
}

async function updateScorerUser(id: string, body: Query = {}) {
  const user = await selectUserByIdStmt.get(String(id));
  if (!user || user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const passwordValue = body.password == null || body.password === ""
    ? null
    : parseUserPassword(body.password);
  const status = parseEnabledStatus(body.status, "账号", { optional: true });
  const shouldSyncTeams = Object.hasOwn(body, "teamNames");
  const teamNames = shouldSyncTeams ? normalizeTeamNames(body.teamNames) : [];
  const now = nowIso();
  await db.exec("BEGIN");
  try {
    await updateScorerUserStmt.run({
      id: user.id,
      password: passwordValue ? hashPassword(passwordValue) : null,
      status,
      updatedAt: now,
    });
    if (shouldSyncTeams) await syncUserTeams(String(user.id), teamNames, now);
    await db.exec("COMMIT");
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return await userDto(await selectUserByIdStmt.get(user.id));
}

function normalizeTeamMatchMode(value: unknown) {
  const mode = String(value ?? "all").trim().toLowerCase();
  if (mode !== "all" && mode !== "any") {
    throw httpError(400, "团队匹配方式无效");
  }
  return mode;
}

async function listScorersByTeamIds(teamIds: string[], matchMode = "all") {
  if (!teamIds.length) return [];
  const normalizedMatchMode = normalizeTeamMatchMode(matchMode);
  const matchClause = normalizedMatchMode === "all"
    ? `HAVING COUNT(DISTINCT user_teams.teamId) = ?`
    : "";
  const params = normalizedMatchMode === "all"
    ? [...teamIds, teamIds.length]
    : teamIds;
  return (await db
    .prepare(
      `SELECT users.id, users.username
       FROM users
       JOIN user_teams ON user_teams.userId = users.id
       WHERE users.role = 'scorer'
         AND users.status = 'enabled'
         AND user_teams.teamId IN (${placeholders(teamIds.length)})
         AND NOT EXISTS (
           SELECT 1
           FROM user_teams AS disabled_user_teams
           JOIN teams ON teams.id = disabled_user_teams.teamId
           WHERE disabled_user_teams.userId = users.id
             AND teams.status = 'disabled'
         )
       GROUP BY users.id, users.username
       ${matchClause}
       ORDER BY LOWER(users.username) ASC, users.username ASC`,
    )
    .all(...params))
    .map((user) => ({ id: String(user.id), username: String(user.username) }));
}

async function deleteScorerUser(id: string) {
  const user = await selectUserByIdStmt.get(String(id));
  if (!user) throw httpError(404, "打分账号不存在");
  if (user.username === "admin" || user.role === "admin") {
    throw httpError(403, "管理员账号不可删除", "ADMIN_ACCOUNT_PROTECTED");
  }
  if (user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const assignedTaskCount = Number((await selectAssignedTaskCountByScorerStmt.get(user.username)).total);
  if (assignedTaskCount > 0) {
    throw httpError(
      409,
      `该账号仍有 ${assignedTaskCount} 个未完成任务，请先重新分配任务`,
    );
  }
  const result = await deleteScorerUserStmt.run(String(id));
  if (result.changes === 0) throw httpError(404, "打分账号不存在");
  return { deleted: true };
}
  return {
    listScorerUsers, createScorerUser, createScorerUsers,
    updateScorerUser, normalizeTeamMatchMode,
    listScorersByTeamIds, deleteScorerUser,
  };
}
