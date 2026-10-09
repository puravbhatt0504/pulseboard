import type { Role } from "@prisma/client";
import type { Deps } from "../app.js";
import { HttpError } from "../http.js";

const CACHE_TTL_S = 60;
export const cacheKey = (boardId: string) => `board:${boardId}`;

// Non-members get 404, not 403: don't leak that the board exists.
export async function requireRole({ prisma }: Deps, boardId: string, userId: string, write: boolean): Promise<Role> {
  const m = await prisma.boardMember.findUnique({ where: { boardId_userId: { boardId, userId } } });
  if (!m) throw new HttpError(404, "board not found");
  if (write && m.role === "viewer") throw new HttpError(403, "read-only member");
  return m.role;
}

export async function getBoard({ prisma, redis }: Deps, boardId: string) {
  const cached = await redis.get(cacheKey(boardId));
  if (cached) return JSON.parse(cached);
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      id: true,
      title: true,
      columns: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          position: true,
          cards: { orderBy: [{ position: "asc" }, { id: "asc" }] },
        },
      },
    },
  });
  const json = JSON.stringify(board);
  await redis.set(cacheKey(boardId), json, "EX", CACHE_TTL_S);
  // Parse back so cache hits and misses return identical shapes (Dates as strings).
  return JSON.parse(json);
}

export const invalidateBoard = ({ redis }: Deps, boardId: string) => redis.del(cacheKey(boardId));
