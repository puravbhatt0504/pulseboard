import { inject } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { createApp } from "../app.js";

// REDIS_URL set (CI) → real Redis; otherwise an in-process mock.
export function makeTestApp() {
  const prisma = new PrismaClient({ datasourceUrl: inject("databaseUrl") });
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : (new RedisMock() as unknown as Redis);
  return { app: createApp({ prisma, redis }), prisma, redis };
}

export const uniqueEmail = () => `u${Date.now()}${Math.random().toString(36).slice(2, 8)}@test.dev`;
