import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { h, HttpError, requireString } from "../http.js";
import { between } from "../cards/position.js";
import { getBoard, invalidateBoard, requireRole } from "./service.js";
import { enqueue } from "../jobs/relayq.js";

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

  // Owner-only invite by email. Re-inviting an existing member changes their role.
  r.post("/boards/:id/members", requireAuth, h(async (req, res) => {
    const boardId = req.params.id;
    if ((await requireRole(deps, boardId, req.userId, true)) !== "owner") throw new HttpError(403, "owner only");
    const { email, role } = req.body ?? {};
    if (typeof email !== "string" || (role !== "editor" && role !== "viewer")) {
      throw new HttpError(400, "email and role (editor|viewer) required");
    }
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) throw new HttpError(404, "user not found");
    if (user.id === req.userId) throw new HttpError(400, "owner cannot change own role");
    await prisma.boardMember.upsert({
      where: { boardId_userId: { boardId, userId: user.id } },
      create: { boardId, userId: user.id, role },
      update: { role },
    });
    res.status(201).json({ userId: user.id, email: user.email, role });
  }));

  // Any member may export. RelayQ fetches the board and POSTs {jobId, url} to callbackUrl when done.
  r.post("/boards/:id/export", requireAuth, h(async (req, res) => {
    const boardId = req.params.id;
    await requireRole(deps, boardId, req.userId, false);
    const format = req.body?.format ?? "json";
    if (format !== "json" && format !== "csv") throw new HttpError(400, "format must be json or csv");
    const callbackUrl = `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/boards/${boardId}/export/callback`;
    res.status(202).json(await enqueue("board.export", { boardId, format, callbackUrl }));
  }));

  return r;
}
