import type { Request } from "express";

export type AuthenticatedUser = {
  id: string;
  username: string;
  role: string;
};

export function requestUser(req: Request): AuthenticatedUser {
  return (req as Request & { auth: AuthenticatedUser }).auth;
}
