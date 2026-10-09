import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { h, requireString } from "../http.js";
import { between } from "../cards/position.js";
import { getBoard, invalidateBoard, requireRole } from "./service.js";

export function boardsRouter(deps: Deps) {
  const { prisma } = deps;
  const r = Router();

  r.get("/boards", requireAuth, h(async (req, res) => {
    const memberships = await prisma.boardMember.findMany({
      where: { userId: req.userId },
      include: { board: { select: { id: true, title: true } } },
      orderBy: { board: { createdAt: "asc" } },
    });
    res.json(memberships.map((m) => ({ ...m.board, role: m.role })));
  }));

  r.post("/boards", requireAuth, h(async (req, res) => {
    const title = requireString(req.body?.title, "title");
    const board = await prisma.board.create({
      data: { title, members: { create: { userId: req.userId, role: "owner" } } },
      select: { id: true, title: true },
    });
    res.status(201).json({ ...board, role: "owner" });
  }));

  r.get("/boards/:id", requireAuth, h(async (req, res) => {
    await requireRole(deps, req.params.id, req.userId, false);
    res.json(await getBoard(deps, req.params.id));
  }));

  r.post("/boards/:id/columns", requireAuth, h(async (req, res) => {
    const boardId = req.params.id;
    await requireRole(deps, boardId, req.userId, true);
    const title = requireString(req.body?.title, "title");
    const last = await prisma.column.findFirst({ where: { boardId }, orderBy: { position: "desc" } });
    const column = await prisma.column.create({ data: { boardId, title, position: between(last?.position ?? null, null) } });
    await invalidateBoard(deps, boardId);
    res.status(201).json(column);
  }));

  return r;
}
