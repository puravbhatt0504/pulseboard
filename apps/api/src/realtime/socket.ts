import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Deps } from "../app.js";
import { verifyAccess } from "../auth/jwt.js";
import { requireRole } from "../boards/service.js";
import { room, type IO } from "./events.js";
import { addPresence, colorFor, listPresence, removePresence } from "./presence.js";

export const CURSOR_MAX_PER_S = 20;

export function attachRealtime(server: HttpServer, deps: Omit<Deps, "io">): IO {
  const { prisma, redis } = deps;
  const io: IO = new Server(server, {
    cors: { origin: process.env.WEB_ORIGIN ?? "http://localhost:3000", credentials: true },
  });
  const sub = redis.duplicate();
  sub.on("error", (err) => console.error("redis (adapter sub):", err.message));
  io.adapter(createAdapter(redis, sub));

  io.use((socket, next) => {
    try {
      socket.data.userId = verifyAccess(String(socket.handshake.auth?.token ?? "")).userId;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  const broadcastPresence = async (boardId: string) =>
    io.to(room(boardId)).emit("presence:update", { users: await listPresence(redis, boardId) });

  async function leave(socketId: string, boardId: string) {
    await removePresence(redis, boardId, socketId);
    await broadcastPresence(boardId);
  }

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    const sent: number[] = []; // send times of the last CURSOR_MAX_PER_S relayed cursors

    async function join(p: { boardId: string }) {
      const boardId = typeof p?.boardId === "string" ? p.boardId : "";
      try {
        await requireRole(deps, boardId, userId, false);
      } catch {
        return void socket.emit("error", { code: "forbidden" });
      }
      const prev = socket.data.boardId;
      if (prev && prev !== boardId) {
        socket.leave(room(prev));
        await leave(socket.id, prev);
      }
      socket.data.boardId = boardId;
      socket.join(room(boardId));
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
      await addPresence(redis, boardId, socket.id, { id: userId, name: user?.email.split("@")[0] ?? "?", color: colorFor(userId) });
      await broadcastPresence(boardId);
    }
    socket.on("join_board", (p) => void join(p).catch(console.error));

    socket.on("cursor", (p) => {
      const { boardId } = socket.data;
      if (!boardId || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return;
      // Sliding window: relay only if fewer than 20 went out in the last 1000 ms; drop the rest.
      const now = Date.now();
      if (sent.length === CURSOR_MAX_PER_S && now - sent[0] < 1000) return;
      sent.push(now);
      if (sent.length > CURSOR_MAX_PER_S) sent.shift();
      socket.to(room(boardId)).volatile.emit("cursor", { userId, x: p.x, y: p.y });
    });

    socket.on("disconnect", () => {
      if (socket.data.boardId) void leave(socket.id, socket.data.boardId).catch(console.error);
    });
  });

  return io;
}
