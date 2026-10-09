import type { Redis } from "ioredis";
import type { PresenceUser } from "./events.js";

// Hash presence:{boardId}, field = socket id (a user may have several tabs), value = user JSON.
// Lives in Redis so every API instance sees the same set.
// ponytail: entries of a crashed instance linger until the board's next leave/join cycle; add per-instance TTL keys if that bites.
const key = (boardId: string) => `presence:${boardId}`;

export async function addPresence(redis: Redis, boardId: string, socketId: string, user: PresenceUser) {
  await redis.hset(key(boardId), socketId, JSON.stringify(user));
}

export async function removePresence(redis: Redis, boardId: string, socketId: string) {
  await redis.hdel(key(boardId), socketId);
}

export async function listPresence(redis: Redis, boardId: string): Promise<PresenceUser[]> {
  const byId = new Map<string, PresenceUser>();
  for (const v of Object.values(await redis.hgetall(key(boardId)))) {
    const u = JSON.parse(v) as PresenceUser;
    byId.set(u.id, u);
  }
  return [...byId.values()];
}

export function colorFor(userId: string) {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 70% 50%)`;
}
