import { asyncRoute } from "./async-route.js";

export function registerPublicAuthRoutes(app, auth) {
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

export function registerSessionAuthRoutes(app, auth) {
  app.get("/api/auth/session", (req, res) => {
    res.json({ user: req.auth });
  });

  app.post("/api/auth/change-password", asyncRoute(async (req, res) => {
    const user = await auth.changeOwnPassword(req.auth.id, req.body);
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
