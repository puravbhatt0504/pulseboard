// Nightly entrypoint (ECS scheduled task / cron): `node dist/jobs/digest-cli.js`.
import { PrismaClient } from "@prisma/client";
import { enqueueDigests } from "./digest.js";

const prisma = new PrismaClient();
try {
  const jobs = await enqueueDigests(prisma);
  console.log(`enqueued ${jobs.length} digests`);
} finally {
  await prisma.$disconnect();
}
