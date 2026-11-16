import { asyncRoute } from "./async-route.js";

export function registerAdminAccountRoutes(app, accounts, requireAdmin) {
  app.get("/api/users/scorers", asyncRoute(async (req, res) => {
    res.json(await accounts.listScorerUsers(req.query));
  }));
  app.post("/api/users/scorers", asyncRoute(async (req, res) => {
    res.status(201).json({ user: await accounts.createScorerUser(req.body) });
  }));
  app.post("/api/users/scorers/batch", asyncRoute(async (req, res) => {
    res.status(201).json(await accounts.createScorerUsers(req.body));
  }));
  app.patch("/api/users/scorers/:id", asyncRoute(async (req, res) => {
    res.json({ user: await accounts.updateScorerUser(req.params.id, req.body) });
  }));

  app.get("/api/teams", requireAdmin, asyncRoute(async (req, res) => {
    res.json(await accounts.listTeams(req.query));
  }));
  app.post("/api/teams", requireAdmin, asyncRoute(async (req, res) => {
    res.status(201).json({ team: await accounts.createTeam(req.body) });
  }));
  app.get("/api/teams/scorers", requireAdmin, asyncRoute(async (req, res) => {
    const rawTeamIds = String(req.query.teamIds || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const teamIds = await accounts.normalizeTeamIds(rawTeamIds, {
      required: true,
      enabledOnly: true,
    });
    const teamMatchMode = accounts.normalizeTeamMatchMode(req.query.teamMatchMode);
    res.json({ users: await accounts.listScorersByTeamIds(teamIds, teamMatchMode) });
  }));
  app.patch("/api/teams/:id", requireAdmin, asyncRoute(async (req, res) => {
    res.json({ team: await accounts.updateTeam(req.params.id, req.body) });
  }));
  app.delete("/api/teams/:id", requireAdmin, asyncRoute(async (req, res) => {
    res.json(await accounts.deleteTeam(req.params.id));
  }));
  app.delete("/api/users/scorers/:id", asyncRoute(async (req, res) => {
    res.json(await accounts.deleteScorerUser(req.params.id));
  }));
}
