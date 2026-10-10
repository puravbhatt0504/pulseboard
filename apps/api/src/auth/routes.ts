import { Router, type Response } from "express";
import { Prisma } from "@prisma/client";
import type { Deps } from "../app.js";
import { apiBasePath, h } from "../http.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccess, signRefresh, verifyRefresh, REFRESH_TTL_MS } from "./jwt.js";

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_S = 15 * 60;
const COOKIE = "refresh";

// Verified against on unknown email so both 401 paths cost the same.
const dummyHash = hashPassword("timing-equaliser");

export function authRouter({ prisma, redis }: Deps) {
  const r = Router();
  const cookieOpts = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: `${apiBasePath()}/auth`,
  };

  async function issueRefresh(res: Response, userId: string) {
    const row = await prisma.refreshToken.create({
      data: { userId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    res.cookie(COOKIE, signRefresh({ userId, tokenId: row.id }), { ...cookieOpts, maxAge: REFRESH_TTL_MS });
  }

  r.post("/register", h(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || !email.includes("@") || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "email and password (min 8 chars) required" });
    }
    try {
      const user = await prisma.user.create({
        data: { email: email.toLowerCase(), passwordHash: await hashPassword(password) },
      });
      res.status(201).json({ user: { id: user.id, email: user.email } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return res.status(409).json({ error: "email already registered" });
      }
      throw e;
    }
  }));

  r.post("/login", h(async (req, res) => {
    const key = `ratelimit:login:${req.ip}`;
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, LOGIN_WINDOW_S);
    if (attempts > LOGIN_LIMIT) return res.status(429).json({ error: "too many attempts" });

    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "invalid credentials" });
    }
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const ok = user ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await dummyHash, password), false);
    if (!user || !ok) return res.status(401).json({ error: "invalid credentials" });

    await issueRefresh(res, user.id);
    res.json({ accessToken: signAccess({ userId: user.id }) });
  }));

  r.post("/refresh", h(async (req, res) => {
    let claims;
    try {
      claims = verifyRefresh(req.cookies?.[COOKIE] ?? "");
    } catch {
      return res.status(401).json({ error: "unauthorized" });
    }
    // Atomic revoke: exactly one caller can consume a given token.
    const consumed = await prisma.refreshToken.updateMany({
      where: { id: claims.tokenId, userId: claims.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (consumed.count !== 1) {
      // Reuse of a rotated/revoked token: assume theft, kill every session for this user.
      await prisma.refreshToken.updateMany({
        where: { userId: claims.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.clearCookie(COOKIE, cookieOpts);
      return res.status(401).json({ error: "unauthorized" });
    }
    await issueRefresh(res, claims.userId);
    res.json({ accessToken: signAccess({ userId: claims.userId }) });
  }));

  r.post("/logout", h(async (req, res) => {
    try {
      const { tokenId } = verifyRefresh(req.cookies?.[COOKIE] ?? "");
      await prisma.refreshToken.updateMany({ where: { id: tokenId, revokedAt: null }, data: { revokedAt: new Date() } });
    } catch {
      // invalid/missing cookie: nothing to revoke
    }
    res.clearCookie(COOKIE, cookieOpts);
    res.status(204).end();
  }));

  return r;
}
