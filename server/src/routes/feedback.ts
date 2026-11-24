import type { Express, Request, RequestHandler, Response } from "express";
import { asyncRoute } from "./async-route.ts";
import { requestUser, type AuthenticatedUser } from "./authenticated-request.ts";

type FeedbackService = {
  listFeedbacks(query: Request["query"]): Promise<unknown>;
  createFeedback(user: AuthenticatedUser, body: unknown, files: unknown): Promise<unknown>;
  addFeedbackMessage(id: string, body: unknown, user: AuthenticatedUser): Promise<unknown>;
  updateFeedbackStatus(id: string, status: unknown, user: AuthenticatedUser): Promise<unknown>;
};

export function registerFeedbackRoutes(app: Express, feedback: FeedbackService, {
  requireScorer, requireAdmin, feedbackUpload, setShortApiCache,
}: {
  requireScorer: RequestHandler;
  requireAdmin: RequestHandler;
  feedbackUpload: { array(fieldName: string, maxCount: number): RequestHandler };
  setShortApiCache: (res: Response) => void;
}) {
  app.get("/api/feedbacks", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await feedback.listFeedbacks(req.query));
  }));
  app.post("/api/feedbacks", requireScorer, feedbackUpload.array("images", 5), asyncRoute(async (req, res) => {
    res.status(201).json({ feedback: await feedback.createFeedback(requestUser(req), req.body, req.files || []) });
  }));
  app.put("/api/feedbacks/:id/reply", requireAdmin, asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.addFeedbackMessage(req.params.id, req.body, requestUser(req)) });
  }));
  app.post("/api/feedbacks/:id/messages", requireScorer, asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.addFeedbackMessage(req.params.id, req.body, requestUser(req)) });
  }));
  app.put("/api/feedbacks/:id/status", asyncRoute(async (req, res) => {
    res.json({ feedback: await feedback.updateFeedbackStatus(req.params.id, req.body?.status, requestUser(req)) });
  }));
}
