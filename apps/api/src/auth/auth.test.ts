import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { makeTestApp, uniqueEmail } from "../test/harness.js";
import { requireAuth } from "./middleware.js";
import { signAccess } from "./jwt.js";

const { app, prisma, redis } = makeTestApp();
const PW = "correct-horse";

beforeEach(() => redis.flushall());
afterAll(() => prisma.$disconnect());

const register = (email: string, password = PW) => request(app).post("/auth/register").send({ email, password });
const login = (email: string, password = PW) => request(app).post("/auth/login").send({ email, password });
const refreshCookie = (res: request.Response) =>
  ([res.headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith("refresh="))!.split(";")[0];

describe("register", () => {
  it("201 with user", async () => {
    const email = uniqueEmail();
    const res = await register(email);
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(String), email });
  });
  it("409 on duplicate email", async () => {
    const email = uniqueEmail();
    await register(email);
    expect((await register(email)).status).toBe(409);
  });
  it("400 on password < 8 chars", async () => {
    expect((await register(uniqueEmail(), "short")).status).toBe(400);
  });
});

describe("login", () => {
  it("200 with access token and HttpOnly SameSite=Strict refresh cookie", async () => {
    const email = uniqueEmail();
    await register(email);
    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const cookie = ([res.headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith("refresh="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });
  it("401 with identical body for wrong password and unknown email", async () => {
    const email = uniqueEmail();
    await register(email);
    const wrongPw = await login(email, "wrong-password");
    const unknown = await login(uniqueEmail());
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body).toEqual(unknown.body);
  });
  it("6th attempt in window → 429", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(uniqueEmail())).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("refresh", () => {
  it("rotates: new access token + new cookie, old cookie no longer valid", async () => {
    const email = uniqueEmail();
    await register(email);
    const c1 = refreshCookie(await login(email));

    const r1 = await request(app).post("/auth/refresh").set("Cookie", c1);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toEqual(expect.any(String));
    const c2 = refreshCookie(r1);
    expect(c2).not.toBe(c1);

    const r2 = await request(app).post("/auth/refresh").set("Cookie", c2);
    expect(r2.status).toBe(200);
  });

  it("reusing an old token → 401 and revokes all the user's tokens", async () => {
    const email = uniqueEmail();
    const { body } = await register(email);
    const c1 = refreshCookie(await login(email));
    const otherSession = refreshCookie(await login(email));
    const c2 = refreshCookie(await request(app).post("/auth/refresh").set("Cookie", c1));

    expect((await request(app).post("/auth/refresh").set("Cookie", c1)).status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { userId: body.user.id, revokedAt: null } })).toBe(0);
    expect((await request(app).post("/auth/refresh").set("Cookie", c2)).status).toBe(401);
    expect((await request(app).post("/auth/refresh").set("Cookie", otherSession)).status).toBe(401);
  });

  it("401 without cookie", async () => {
    expect((await request(app).post("/auth/refresh")).status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the current refresh token", async () => {
    const email = uniqueEmail();
    await register(email);
    const c = refreshCookie(await login(email));
    expect((await request(app).post("/auth/logout").set("Cookie", c)).status).toBe(204);
    expect((await request(app).post("/auth/refresh").set("Cookie", c)).status).toBe(401);
  });
});

describe("requireAuth", () => {
  const guarded = express().get("/x", requireAuth, (req, res) => res.json({ userId: req.userId }));
  it("200 with valid token", async () => {
    const res = await request(guarded).get("/x").set("Authorization", `Bearer ${signAccess({ userId: "u1" })}`);
    expect(res.body).toEqual({ userId: "u1" });
  });
  it("401 when missing", async () => {
    expect((await request(guarded).get("/x")).status).toBe(401);
  });
  it("401 when expired", async () => {
    const expired = jwt.sign({ sub: "u1" }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -10 });
    expect((await request(guarded).get("/x").set("Authorization", `Bearer ${expired}`)).status).toBe(401);
  });
});
