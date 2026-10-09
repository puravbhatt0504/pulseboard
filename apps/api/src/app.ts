import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { authRouter } from "./auth/routes.js";

export type Deps = { prisma: PrismaClient; redis: Redis };

export function createApp(deps: Deps) {
  const app = express();
  // Behind the ALB req.ip must be the client, not the LB, or the login rate limit is global.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.use(express.json(), cookieParser());
  app.use("/auth", authRouter(deps));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "internal" });
  };
  app.use(onError);
  return app;
}
