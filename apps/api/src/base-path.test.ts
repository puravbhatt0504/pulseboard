import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { makeDeps, uniqueEmail } from "./test/harness.js";
import { createApp } from "./app.js";

const deps = makeDeps();
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.API_BASE_PATH = "/api";
  app = createApp(deps);
});
afterEach(() => deps.redis.flushall());
afterAll(async () => {
  delete process.env.API_BASE_PATH;
  await deps.prisma.$disconnect();
});

it("API_BASE_PATH=/api prefixes routes and the refresh cookie path", async () => {
  expect((await request(app).get("/api/health")).status).toBe(200);
  expect((await request(app).get("/health")).status).toBe(404);

  const email = uniqueEmail();
  await request(app).post("/api/auth/register").send({ email, password: "password123" }).expect(201);
  const login = await request(app).post("/api/auth/login").send({ email, password: "password123" });
  expect(login.status).toBe(200);
  const cookie = ([login.headers["set-cookie"]].flat() as string[]).find((c) => c.startsWith("refresh="))!;
  expect(cookie).toMatch(/Path=\/api\/auth/);
});
