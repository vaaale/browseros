import jwt from "jsonwebtoken";
import type { Request, Response } from "express";
import type { Config } from "./config";

export interface SessionPayload {
  username: string;
  isAdmin: boolean;
  iat?: number;
  exp?: number;
}

const COOKIE_NAME = "bos_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export function issueSession(res: Response, payload: SessionPayload, cfg: Config): void {
  const token = jwt.sign(
    { username: payload.username, isAdmin: payload.isAdmin },
    cfg.jwtSecret,
    { expiresIn: SESSION_TTL_SECONDS },
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

export function verifySession(req: Request, cfg: Config): SessionPayload | null {
  const token = (req.cookies as Record<string, string | undefined>)[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, cfg.jwtSecret) as SessionPayload;
    return payload;
  } catch {
    return null;
  }
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}
