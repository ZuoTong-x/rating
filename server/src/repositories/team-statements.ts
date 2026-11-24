import type { db as database } from "../postgres.ts";

export function createTeamStatements(db: typeof database) {
const selectTeamByIdStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE id = ?",
);
const selectTeamByNameStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE LOWER(name) = LOWER(?)",
);
const selectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
         COUNT(DISTINCT user_teams.userId) AS userCount,
         COUNT(DISTINCT project_teams.projectId) AS projectCount
  FROM teams
  LEFT JOIN user_teams ON user_teams.teamId = teams.id
  LEFT JOIN project_teams ON project_teams.teamId = teams.id
  GROUP BY teams.id
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const insertTeamStmt = db.prepare(`
  INSERT INTO teams (id, name, status, createdAt, updatedAt)
  VALUES (@id, @name, 'enabled', @createdAt, @updatedAt)
`);
const updateTeamStmt = db.prepare(`
  UPDATE teams
  SET name = COALESCE(@name, name),
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
`);
const deleteTeamStmt = db.prepare("DELETE FROM teams WHERE id = ?");
const selectTeamUsageStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM user_teams WHERE teamId = ?) AS userCount,
    (SELECT COUNT(*) FROM project_teams WHERE teamId = ?) AS projectCount
`);
const selectUserTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const selectDisabledTeamForUserStmt = db.prepare(`
  SELECT teams.id, teams.name
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
    AND teams.status = 'disabled'
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
  LIMIT 1
`);
const deleteUserTeamsStmt = db.prepare("DELETE FROM user_teams WHERE userId = ?");
const insertUserTeamStmt = db.prepare(`
  INSERT INTO user_teams (userId, teamId, createdAt)
  VALUES (@userId, @teamId, @createdAt)
  ON CONFLICT DO NOTHING
`);
const selectProjectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM project_teams
  JOIN teams ON teams.id = project_teams.teamId
  WHERE project_teams.projectId = ?
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const deleteProjectTeamsStmt = db.prepare("DELETE FROM project_teams WHERE projectId = ?");
const insertProjectTeamStmt = db.prepare(`
  INSERT INTO project_teams (projectId, teamId, createdAt)
  VALUES (@projectId, @teamId, @createdAt)
  ON CONFLICT DO NOTHING
`);
  return { selectTeamByIdStmt, selectTeamByNameStmt, selectTeamsStmt, insertTeamStmt, updateTeamStmt, deleteTeamStmt, selectTeamUsageStmt, selectUserTeamsStmt, selectDisabledTeamForUserStmt, deleteUserTeamsStmt, insertUserTeamStmt, selectProjectTeamsStmt, deleteProjectTeamsStmt, insertProjectTeamStmt };
}
