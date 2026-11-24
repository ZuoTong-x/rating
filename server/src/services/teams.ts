import crypto from "node:crypto";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type TeamDependencies = {
  db: typeof database;
  httpError: (status: number, message: string) => Error;
  nowIso: () => string;
  teamDto: (row: Record<string, unknown> | null | undefined) => unknown;
  isUniqueConstraintError: (error: unknown) => boolean;
  selectTeamByIdStmt: Statement;
  selectTeamByNameStmt: Statement;
  insertTeamStmt: Statement;
  selectTeamsStmt: Statement;
  updateTeamStmt: Statement;
  deleteTeamStmt: Statement;
  selectTeamUsageStmt: Statement;
  deleteUserTeamsStmt: Statement;
  insertUserTeamStmt: Statement;
  deleteProjectTeamsStmt: Statement;
  insertProjectTeamStmt: Statement;
};

export function createTeamService({
  db, httpError, nowIso, teamDto, isUniqueConstraintError,
  selectTeamByIdStmt, selectTeamByNameStmt, insertTeamStmt,
  selectTeamsStmt, updateTeamStmt, deleteTeamStmt, selectTeamUsageStmt,
  deleteUserTeamsStmt, insertUserTeamStmt, deleteProjectTeamsStmt,
  insertProjectTeamStmt,
}: TeamDependencies) {
function normalizeTeamNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > 20) throw httpError(400, "每个账号最多关联 20 个团队");
  return names;
}

async function normalizeTeamIds(value: unknown, { required = false, enabledOnly = false }: { required?: boolean; enabledOnly?: boolean } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw httpError(400, "请选择标注团队");
    return [];
  }
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (required && !ids.length) throw httpError(400, "请选择标注团队");
  if (ids.length > 20) throw httpError(400, "最多选择 20 个团队");
  const teams = await Promise.all(ids.map(async id => await selectTeamByIdStmt.get(id)));
  const missing = ids.filter((_, index) => !teams[index]);
  if (missing.length) throw httpError(400, "存在已删除的团队，请刷新后重试");
  const disabled = teams.filter((team) => team.status === "disabled");
  if (enabledOnly && disabled.length) {
    throw httpError(
      400,
      `以下团队已禁用：${disabled.map((team) => team.name).join("、")}`,
    );
  }
  return ids;
}

async function ensureTeams(teamNames: string[], now: string) {
  return await Promise.all(teamNames.map(async name => {
    let team = await selectTeamByNameStmt.get(name);
    if (!team) {
      const id = crypto.randomUUID();
      await insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
      team = await selectTeamByIdStmt.get(id);
    }
    return team.id;
  }));
}

function parseEnabledStatus(value: unknown, label: string, { optional = false }: { optional?: boolean } = {}) {
  if ((value === undefined || value === null || value === "") && optional) {
    return null;
  }
  const status = String(value ?? "").trim();
  if (status !== "enabled" && status !== "disabled") {
    throw httpError(400, `${label}状态不正确`);
  }
  return status;
}

function parseTeamName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "请输入团队名称");
  if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
  return name;
}

async function listTeams(query: { status?: unknown } = {}) {
  const status = parseEnabledStatus(query.status, "团队", { optional: true });
  if (!status) return (await selectTeamsStmt.all()).map(teamDto);

  return (await db
    .prepare(
      `SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
              COUNT(DISTINCT user_teams.userId) AS userCount,
              COUNT(DISTINCT project_teams.projectId) AS projectCount
       FROM teams
       LEFT JOIN user_teams ON user_teams.teamId = teams.id
       LEFT JOIN project_teams ON project_teams.teamId = teams.id
       WHERE teams.status = ?
       GROUP BY teams.id
       ORDER BY LOWER(teams.name) ASC, teams.name ASC`,
    )
    .all(status))
    .map(teamDto);
}

async function createTeam(body: { name?: unknown } = {}) {
  const name = parseTeamName(body.name);
  const now = nowIso();
  const id = crypto.randomUUID();
  try {
    await insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(await selectTeamByIdStmt.get(id));
}

async function updateTeam(id: unknown, body: { name?: unknown; status?: unknown } = {}) {
  const team = await selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const name = Object.hasOwn(body, "name") ? parseTeamName(body.name) : null;
  const status = parseEnabledStatus(body.status, "团队", { optional: true });
  if (!name && !status) return teamDto(await selectTeamByIdStmt.get(team.id));

  try {
    await updateTeamStmt.run({
      id: team.id,
      name,
      status,
      updatedAt: nowIso(),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(await selectTeamByIdStmt.get(team.id));
}

async function syncUserTeams(userId: string, teamNames: string[], now: string) {
  const teamIds = await ensureTeams(teamNames, now);
  await deleteUserTeamsStmt.run(userId);
  await Promise.all(teamIds.map(async teamId => {
    await insertUserTeamStmt.run({ userId, teamId, createdAt: now });
  }));
}

async function syncProjectTeams(projectId: string, teamIds: string[], now: string) {
  await deleteProjectTeamsStmt.run(projectId);
  await Promise.all(teamIds.map(async teamId => {
    await insertProjectTeamStmt.run({ projectId, teamId, createdAt: now });
  }));
}

async function deleteTeam(id: unknown) {
  const team = await selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const usage = await selectTeamUsageStmt.get(team.id, team.id);
  if (Number(usage.userCount) > 0 || Number(usage.projectCount) > 0) {
    throw httpError(409, "团队仍有关联账号或项目，不能删除");
  }
  await deleteTeamStmt.run(team.id);
  return { deleted: true };
}
  return {
    normalizeTeamNames, normalizeTeamIds, ensureTeams, parseEnabledStatus,
    parseTeamName, listTeams, createTeam, updateTeam,
    syncUserTeams, syncProjectTeams, deleteTeam,
  };
}
