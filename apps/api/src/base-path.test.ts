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

it("WEB_UPSTREAM: non-API paths are proxied to the web app, API paths are not", async () => {
  const { createServer } = await import("node:http");
  const seen: string[] = [];
  const web = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { "content-type": "text/html", "x-from": "web" }).end("<html>login</html>");
    });
  });
  await new Promise<void>((r) => web.listen(0, r));
  process.env.WEB_UPSTREAM = `http://127.0.0.1:${(web.address() as import("node:net").AddressInfo).port}`;
  const proxied = createApp(deps);
  try {
    const page = await request(proxied).get("/login?next=%2Fboards");
    expect(page.status).toBe(200);
    expect(page.headers["x-from"]).toBe("web");
    expect(page.text).toBe("<html>login</html>");

    // Bodies stream through unparsed.
    await request(proxied).post("/some/form").set("content-type", "application/json").send('{"a":1}');
    expect(seen).toEqual(["GET /login?next=%2Fboards ", 'POST /some/form {"a":1}']);

    const health = await request(proxied).get("/api/health");
    expect(health.body).toEqual({ db: "ok", redis: "ok" });
    expect(seen).toHaveLength(2);

    process.env.WEB_UPSTREAM = "http://127.0.0.1:1";
    expect((await request(createApp(deps)).get("/login")).status).toBe(502);
  } finally {
    delete process.env.WEB_UPSTREAM;
    web.close();
  }
});
