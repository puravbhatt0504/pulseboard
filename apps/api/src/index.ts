import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { createServer } from "./app.js";

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const port = Number(process.env.PORT ?? 4000);

createServer({ prisma, redis }).server.listen(port, () => console.log(`api on :${port}`));
