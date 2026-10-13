import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { h, HttpError, requireString } from "../http.js";
import { between } from "../cards/position.js";
import { getBoard, invalidateBoard, requireRole } from "./service.js";
import { enqueue, isRelayqService, verifyRelayqSignature } from "../jobs/relayq.js";
import { room } from "../realtime/events.js";

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

  r.get(
    "/boards/:id",
    // RelayQ's export worker reads boards with a service token instead of a user JWT.
    h(async (req, res, next) => {
      if (!isRelayqService(req.headers.authorization)) return next();
      const board = await getBoard(deps, req.params.id);
      if (!board) throw new HttpError(404, "board not found");
      res.json(board);
    }),
    requireAuth,
    h(async (req, res) => {
      await requireRole(deps, req.params.id, req.userId, false);
      res.json(await getBoard(deps, req.params.id));
    }),
  );

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
    const { jobId } = await enqueue("board.export", { boardId, format, callbackUrl });
    await prisma.export.create({ data: { jobId, boardId, requestedBy: req.userId, format } });
    res.status(202).json({ jobId });
  }));

  // Called by RelayQ (no user session): trust comes only from the HMAC signature. RelayQ retries until 2xx,
  // so a repeat delivery must succeed without changing anything.
  r.post("/boards/:id/export/callback", h(async (req, res) => {
    if (!verifyRelayqSignature(req.rawBody, req.headers["x-relayq-signature"])) throw new HttpError(401, "bad signature");
    const { jobId, url } = req.body ?? {};
    if (typeof jobId !== "string" || typeof url !== "string") throw new HttpError(400, "jobId and url required");
    const updated = await prisma.export.updateMany({ where: { jobId, boardId: req.params.id }, data: { status: "ready", url } });
    if (updated.count === 0) throw new HttpError(404, "export not found");
    deps.io?.to(room(req.params.id)).emit("export:ready", { jobId, url });
    res.status(204).end();
  }));

  r.get("/boards/:id/exports/:jobId", requireAuth, h(async (req, res) => {
    await requireRole(deps, req.params.id, req.userId, false);
    const exp = await prisma.export.findFirst({ where: { jobId: req.params.jobId, boardId: req.params.id } });
    if (!exp) throw new HttpError(404, "export not found");
    res.json({ jobId: exp.jobId, format: exp.format, status: exp.status, url: exp.url });
  }));

  return r;
}
