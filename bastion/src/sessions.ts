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
// Rolling (sliding) session: the TTL is a MAX-IDLE window, not a hard cap from
// login. As long as the user is active, the cookie is periodically re-issued
// (see shouldRefreshSession), so an active session never expires mid-work.
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours of inactivity
/** Session lifetime in ms — also the window the user's container is kept alive
 *  after their last activity (the idle-stop tracks session expiry). */
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
// Re-issue once the token passes this fraction of its lifetime, bounding how
// often we re-sign (at most ~once per TTL/2 per active user) while keeping a
// wide safety margin before expiry.
const SESSION_REFRESH_AFTER = 0.5;

function signToken(payload: SessionPayload, cfg: Config): string {
  return jwt.sign(
    { username: payload.username, isAdmin: payload.isAdmin },
    cfg.jwtSecret,
    { expiresIn: SESSION_TTL_SECONDS },
  );
}

export function issueSession(res: Response, payload: SessionPayload, cfg: Config): void {
  res.cookie(COOKIE_NAME, signToken(payload, cfg), {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

/** Build the raw Set-Cookie header value for a fresh session token. Used on the
 *  proxy path where Express's res.cookie() would be dropped by the proxied
 *  response — the value is injected into the upstream response's Set-Cookie
 *  headers instead. Attributes match issueSession(). */
export function sessionSetCookie(payload: SessionPayload, cfg: Config): string {
  return `${COOKIE_NAME}=${signToken(payload, cfg)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Strict`;
}

/** True once the token is past SESSION_REFRESH_AFTER of its lifetime, i.e. it
 *  should be re-issued to keep an active session rolling. */
export function shouldRefreshSession(payload: SessionPayload): boolean {
  if (!payload.iat) return false;
  const now = Math.floor(Date.now() / 1000);
  return now - payload.iat >= SESSION_TTL_SECONDS * SESSION_REFRESH_AFTER;
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
