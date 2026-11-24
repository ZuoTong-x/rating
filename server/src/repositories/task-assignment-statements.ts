import type { db as database } from "../postgres.ts";

export function createTaskAssignmentStatements({ db, userSelectColumns }: {
  db: typeof database;
  userSelectColumns: string;
}) {
const selectPendingProjectTaskIdsStmt = db.prepare(`
  SELECT id, taskType
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
    AND NOT isBacktest
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectSubjectScorerNamesStmt = db.prepare(`
  SELECT DISTINCT scorer
  FROM rating_tasks
  WHERE projectId = ?
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
`);
const selectSubjectAssignedScorerCountsStmt = db.prepare(`
  SELECT scorer, COUNT(*) AS taskCount
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
  GROUP BY scorer
  ORDER BY LOWER(scorer) ASC, scorer ASC
`);
const selectAvailableSubjectScorersStmt = db.prepare(`
  SELECT ${userSelectColumns}
  FROM users
  WHERE role = 'scorer'
    AND status = 'enabled'
    AND NOT EXISTS (
      SELECT 1
      FROM rating_tasks
      WHERE rating_tasks.projectId = ?
        AND rating_tasks.scorer = users.username
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_teams
      JOIN teams ON teams.id = user_teams.teamId
      WHERE user_teams.userId = users.id
        AND teams.status = 'disabled'
    )
  ORDER BY LOWER(username) ASC, username ASC
`);
const selectReassignableTaskIdsStmt = db.prepare(`
  SELECT id, taskType
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectReassignableTaskIdsByScorerStmt = db.prepare(`
  SELECT id, taskType
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer = ?
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const reassignTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'assigned'
`);
const assignUnassignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      status = 'assigned',
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'pending'
    AND scorer IS NULL
`);
  return { selectPendingProjectTaskIdsStmt, selectSubjectScorerNamesStmt, selectSubjectAssignedScorerCountsStmt, selectAvailableSubjectScorersStmt, selectReassignableTaskIdsStmt, selectReassignableTaskIdsByScorerStmt, reassignTaskStmt, assignUnassignedTaskStmt };
}
