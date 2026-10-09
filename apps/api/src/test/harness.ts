import { inject } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { createApp } from "../app.js";

// REDIS_URL set (CI) → real Redis; otherwise an in-process mock (instances share data and pub/sub).
const makeRedis = () => (process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : (new RedisMock() as unknown as Redis));

export const makeDeps = () => ({ prisma: new PrismaClient({ datasourceUrl: inject("databaseUrl") }), redis: makeRedis() });

export function makeTestApp() {
  const deps = makeDeps();
  return { app: createApp(deps), ...deps };
}

export const uniqueEmail = () => `u${Date.now()}${Math.random().toString(36).slice(2, 8)}@test.dev`;
