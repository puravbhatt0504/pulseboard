import type { PrismaClient } from "@prisma/client";
import { enqueue } from "./relayq.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// One email.digest per user: what *other* members did on their boards in the last 24 h.
// Idempotency key = user + UTC date, so a re-run (or two scheduler firings) never double-sends.
export async function enqueueDigests(prisma: PrismaClient, now = new Date()) {
  const activities = await prisma.activity.findMany({
    where: { createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    include: {
      user: { select: { email: true } },
      board: { select: { id: true, title: true, members: { select: { user: { select: { id: true, email: true } } } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  const web = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const byRecipient = new Map<string, { email: string; items: { title: string; url: string }[] }>();
  for (const a of activities) {
    for (const { user } of a.board.members) {
      if (user.id === a.userId) continue;
      const entry = byRecipient.get(user.id) ?? { email: user.email, items: [] };
      entry.items.push({ title: `${a.board.title}: ${a.user.email.split("@")[0]} ${a.type.replace("card.", "")} a card`, url: `${web}/boards/${a.board.id}` });
      byRecipient.set(user.id, entry);
    }
  }

  const day = now.toISOString().slice(0, 10);
  const jobs = [];
  for (const [userId, { email, items }] of byRecipient) {
    jobs.push(await enqueue("email.digest", { to: email, userName: email.split("@")[0], items }, `digest:${userId}:${day}`));
  }
  return jobs;
}
