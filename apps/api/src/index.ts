import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { createServer } from "./app.js";

// ECS injects the RDS credentials separately (password from Secrets Manager); the generated password
// excludes URL-reserved characters, so no encoding is needed.
const { DB_HOST, DB_PORT = "5432", DB_NAME, DB_USER, DB_PASSWORD } = process.env;
if (!process.env.DATABASE_URL && DB_HOST) {
  process.env.DATABASE_URL = `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
redis.on("error", (err) => console.error("redis:", err.message));
const port = Number(process.env.PORT ?? 4000);

const { server, collab } = createServer({ prisma, redis });
server.listen(port, () => console.log(`api on :${port}`));
// Deploys send SIGTERM: write open card docs before exiting (clients would resync them anyway on reconnect).
process.once("SIGTERM", () => void collab.flush().finally(() => process.exit(0)));
