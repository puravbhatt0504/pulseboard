import { createServer as createHttpServer } from "node:http";
import express, { Router, type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { apiBasePath, h, HttpError, proxyTo } from "./http.js";
import { authRouter } from "./auth/routes.js";
import { boardsRouter } from "./boards/routes.js";
import { cardsRouter } from "./cards/routes.js";
import { attachRealtime } from "./realtime/socket.js";
import type { IO } from "./realtime/events.js";

export type Deps = { prisma: PrismaClient; redis: Redis; io?: IO };

export function createApp(deps: Deps) {
  const app = express();
  // Behind the ALB req.ip must be the client, not the LB, or the login rate limit is global.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0));
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": webOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
      Vary: "Origin",
    });
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });
  // Before body parsing, so proxied requests stream through untouched. /socket.io never reaches Express.
  const webUpstream = process.env.WEB_UPSTREAM;
  if (webUpstream) {
    const proxy = proxyTo(webUpstream);
    app.use((req, res, next) => (req.path.startsWith(`${apiBasePath()}/`) ? next() : proxy(req, res, next)));
  }
  // Keep the raw bytes: RelayQ signs the exact body, and re-serialised JSON wouldn't match.
  // ponytail: 5mb so RelayQ callbacks can carry an inline data: export; set EXPORT_BUCKET on RelayQ if boards outgrow it.
  app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => void ((req as express.Request).rawBody = buf) }), cookieParser());
  // Prod serves web and API on one CloudFront host, so the API lives under /api there; "" locally.
  const api = Router();
  api.get("/health", h(async (_req, res) => {
    const [db, redis] = await Promise.all([
      deps.prisma.$queryRaw`SELECT 1`.then(() => "ok", () => "down"),
      deps.redis.ping().then(() => "ok", () => "down"),
    ]);
    res.status(db === "ok" && redis === "ok" ? 200 : 503).json({ db, redis });
  }));
  api.use("/auth", authRouter(deps));
  api.use(boardsRouter(deps), cardsRouter(deps));
  app.use(apiBasePath() || "/", api);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal" });
  };
  app.use(onError);
  return app;
}

// HTTP + Socket.io on one port. Socket.io must attach after the app's request listener so it can
// claim /socket.io/* first; routes read `withIo.io` per request, so filling it in afterwards works.
export function createServer(deps: Omit<Deps, "io">) {
  const withIo: Deps = { ...deps };
  const server = createHttpServer(createApp(withIo));
  const io = attachRealtime(server, deps);
  withIo.io = io;
  return { server, io };
}
