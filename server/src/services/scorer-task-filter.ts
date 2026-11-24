type ScorerTaskFilterDependencies = {
  parseScorerName(value: unknown): string | null;
  httpError(status: number, message: string): Error;
  parseProjectId(value: unknown): Promise<string>;
  selectScorerByUsernameStmt: { get(username: string): Promise<unknown> };
  taskVersion: string;
  activeTaskGenerationBySubject: Map<string, unknown>;
  hasActiveTaskGeneration(projectId: string): boolean;
  placeholders(count: number): string;
  taskCriteria: string[];
};

export function createScorerTaskFilterService({
    parseScorerName, httpError, parseProjectId, selectScorerByUsernameStmt,
    taskVersion, activeTaskGenerationBySubject, hasActiveTaskGeneration,
    placeholders, taskCriteria,
}: ScorerTaskFilterDependencies) {
async function scorerTaskScope(query: Record<string, unknown> = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
  if (!(await selectScorerByUsernameStmt.get(scorer)))
    throw httpError(404, "打分账号不存在");
  return { scorer, projectId };
}

async function buildScorerTaskFilter(query: Record<string, unknown> = {}) {
  const { scorer, projectId } = await scorerTaskScope(query);
  const clauses = ["rating_tasks.taskVersion = ?", "rating_tasks.scorer = ?"];
  const params = [taskVersion, scorer];
  const status = String(query.status || "");
  const criterion = String(query.criterion || "");
  const activeGenerationProjectIds = [
    ...activeTaskGenerationBySubject.keys(),
  ].filter((id) => hasActiveTaskGeneration(id));

  if (["assigned", "completed"].includes(status)) {
    clauses.push("rating_tasks.status = ?");
    params.push(status);
  } else {
    clauses.push("rating_tasks.status IN ('assigned', 'completed')");
  }
  clauses.push(`EXISTS (
    SELECT 1 FROM projects
    WHERE projects.id = rating_tasks.projectId
      AND projects.tasksLocked = false
      AND projects.deletionRequestedAt IS NULL
  )`);
  if (projectId) {
    clauses.push("rating_tasks.projectId = ?");
    params.push(projectId);
  }
  if (activeGenerationProjectIds.length) {
    if (projectId && activeGenerationProjectIds.includes(projectId)) {
      clauses.push("1 = 0");
    } else if (!projectId) {
      clauses.push(
        `rating_tasks.projectId NOT IN (${placeholders(activeGenerationProjectIds.length)})`,
      );
      params.push(...activeGenerationProjectIds);
    }
  }
  if (["1", "true", "yes"].includes(String(query.availableOnly ?? "").toLowerCase())) {
    clauses.push("(rating_tasks.claimToken IS NULL OR rating_tasks.claimExpiresAt IS NULL OR rating_tasks.claimExpiresAt <= CURRENT_TIMESTAMP)");
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(rating_tasks.taskType = ? OR rating_tasks.taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }
  const excludeTaskId = String(query.excludeTaskId || "").trim();
  if (excludeTaskId) {
    clauses.push("rating_tasks.id <> ?");
    params.push(excludeTaskId);
  }
  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params,
    scorer,
    projectId,
    status: ["assigned", "completed"].includes(status) ? status : null,
    criterion,
    activeGenerationProjectIds,
  };
}

function taskCriterionOrderSql(column: string) {
  const cases = taskCriteria
    .map((criterion, index) => {
      const taskType = `dimension:${criterion}`;
      return `WHEN ${column} = '${taskType}' OR ${column} LIKE '${taskType}:%' THEN ${index}`;
    })
    .join(" ");
  return `CASE ${cases} ELSE ${taskCriteria.length} END`;
}

  return { scorerTaskScope, buildScorerTaskFilter, taskCriterionOrderSql };
}
