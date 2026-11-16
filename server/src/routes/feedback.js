import { asyncRoute } from "./async-route.js";

export function registerFeedbackRoutes(app, feedback, { requireScorer, requireAdmin, feedbackUpload, setShortApiCache }) {
  app.get("/api/feedbacks", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await feedback.listFeedbacks(req.query));
  }));
  app.post("/api/feedbacks", requireScorer, feedbackUpload.array("images", 5), asyncRoute(async (req, res) => {
    res.status(201).json({ feedback: await feedback.createFeedback(req.auth, req.body, req.files || []) });
  }));
  app.put("/api/feedbacks/:id/reply", requireAdmin, asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.addFeedbackMessage(req.params.id, req.body, req.auth) });
  }));
  app.post("/api/feedbacks/:id/messages", requireScorer, asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.addFeedbackMessage(req.params.id, req.body, req.auth) });
  }));
  app.put("/api/feedbacks/:id/status", asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.updateFeedbackStatus(req.params.id, req.body?.status, req.auth) });
  }));
}
