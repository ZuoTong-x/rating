import type { Express, Request, Response } from "express";
import type { db as database } from "../postgres.ts";
import { asyncRoute } from "./async-route.ts";
import { requestUser } from "./authenticated-request.ts";

type SessionUser = { id: string; username?: string; role?: string };
type PublicAuthRoutes = {
  loginUser(body: unknown, context: { ip: string }): Promise<SessionUser>;
  loginRequestIp(req: Request): string;
  createSession(user: SessionUser): Promise<{ token: string; expiresAt: string }>;
  setSessionCookie(res: Response, token: string, expiresAt: string): void;
  createLoginCaptcha(): Promise<{ id: string; image: string; expiresAt: string }>;
};
type SessionAuthRoutes = {
  changeOwnPassword(id: string, body: unknown): Promise<unknown>;
  cookieValue(cookie: string | undefined, name: string): string | null;
  sessionTokenHash(token: string): string;
  deleteSessionStmt: ReturnType<typeof database.prepare>;
  sessionSeenWriteAt: Map<string, unknown>;
  clearSessionCookie(res: Response): void;
};

export function registerPublicAuthRoutes(app: Express, auth: PublicAuthRoutes) {
  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const user = await auth.loginUser(req.body, { ip: auth.loginRequestIp(req) });
    const session = await auth.createSession(user);
    auth.setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user });
  }));

  app.post("/api/auth/captcha", asyncRoute(async (_req, res) => {
    const captcha = await auth.createLoginCaptcha();
    res.json({ captchaId: captcha.id, image: captcha.image, expiresAt: captcha.expiresAt });
  }));
}

export function registerSessionAuthRoutes(app: Express, auth: SessionAuthRoutes) {
  app.get("/api/auth/session", (req, res) => {
    res.json({ user: requestUser(req) });
  });

  app.post("/api/auth/change-password", asyncRoute(async (req, res) => {
    const user = await auth.changeOwnPassword(requestUser(req).id, req.body);
    res.json({ user });
  }));

  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    const token = auth.cookieValue(req.headers.cookie, "image_rating_session");
    if (token) {
      const tokenHash = auth.sessionTokenHash(token);
      await auth.deleteSessionStmt.run(tokenHash);
      auth.sessionSeenWriteAt.delete(tokenHash);
    }
    auth.clearSessionCookie(res);
    res.status(204).end();
  }));
}
