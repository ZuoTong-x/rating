type AssignmentBody = {
  teamIds?: unknown;
  teamMatchMode?: unknown;
  backtestRatio?: unknown;
  allocations?: Array<{ scorer?: unknown; taskCount?: unknown }>;
};

type AssignmentDependencies = {
  normalizeTeamIds(value: unknown, options: { required: boolean; enabledOnly: boolean }): Promise<string[]>;
  normalizeTeamMatchMode(value: unknown): string;
  parseBacktestRatio(value: unknown): number;
  listScorersByTeamIds(teamIds: string[], matchMode: string): Promise<Array<{ username: string }>>;
  normalizeUsername(value: unknown): string;
  httpError(status: number, message: string): Error;
};

export async function parseTaskGenerationAssignees(body: AssignmentBody = {}, {
  normalizeTeamIds, normalizeTeamMatchMode, parseBacktestRatio,
  listScorersByTeamIds, normalizeUsername, httpError,
}: AssignmentDependencies) {
  const teamIds = await normalizeTeamIds(body.teamIds, {
    required: true,
    enabledOnly: true,
  });
  const teamMatchMode = normalizeTeamMatchMode(body.teamMatchMode);
  const backtestRatio = parseBacktestRatio(body.backtestRatio);
  const availableUsers = await listScorersByTeamIds(teamIds, teamMatchMode);
  if (!availableUsers.length) throw httpError(400, "所选团队没有可用的打分账号");
  if (!Array.isArray(body.allocations)) throw httpError(400, "请设置打分人任务数量");

  const availableNames = new Set(availableUsers.map((user) => user.username));
  const allocations: Array<{ scorer: string; taskCount: number }> = [];
  const seen = new Set<string>();
  for (const item of body.allocations) {
    const scorer = normalizeUsername(item?.scorer);
    const taskCount = Number(item?.taskCount);
    if (seen.has(scorer)) throw httpError(400, `打分人 ${scorer} 重复设置`);
    seen.add(scorer);
    if (!availableNames.has(scorer)) throw httpError(400, `打分人 ${scorer} 不属于所选团队`);
    if (!Number.isInteger(taskCount) || taskCount < 0) {
      throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
    }
    if (taskCount > 0) allocations.push({ scorer, taskCount });
  }
  return { teamIds, teamMatchMode, allocations, backtestRatio };
}
