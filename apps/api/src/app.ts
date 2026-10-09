import { createServer as createHttpServer } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { HttpError } from "./http.js";
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
  app.use(express.json(), cookieParser());
  app.use("/auth", authRouter(deps));
  app.use(boardsRouter(deps), cardsRouter(deps));

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
