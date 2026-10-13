import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { h, HttpError, requireString } from "../http.js";
import { cardBoard, createCard, updateCard } from "./service.js";
import { presignAttachment } from "../uploads/s3.js";
import { emitCard } from "../realtime/events.js";
import { scheduleEmbed } from "../ai/embed.js";

const optional = (v: unknown, field: string, max: number) => (v === undefined ? undefined : requireString(v, field, max));

function description(v: unknown) {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > 10_000) throw new HttpError(400, "description must be a string up to 10000 chars");
  return v;
}

export function cardsRouter(deps: Deps) {
  const r = Router();

  r.post("/columns/:id/cards", requireAuth, h(async (req, res) => {
    const title = requireString(req.body?.title, "title");
    const { card, boardId } = await createCard(deps, req.userId, req.params.id, title, description(req.body?.description));
    emitCard(deps.io, boardId, "card:created", card, req.userId);
    void scheduleEmbed(deps, card.id).catch(console.error);
    res.status(201).json(card);
  }));

  r.patch("/cards/:id", requireAuth, h(async (req, res) => {
    const b = req.body ?? {};
    // Once a card has a collaborative doc, its description is the doc's projection; a REST write would be lost
    // on the next persist, so refuse it.
    if (b.description !== undefined && (await deps.prisma.cardDoc.findUnique({ where: { cardId: req.params.id }, select: { cardId: true } }))) {
      throw new HttpError(409, "description is collaborative: edit it through the card doc");
    }
    const { card, boardId, moved } = await updateCard(deps, req.userId, req.params.id, {
      title: optional(b.title, "title", 200),
      description: description(b.description),
      columnId: optional(b.columnId, "columnId", 64),
      before: optional(b.before, "before", 64),
      after: optional(b.after, "after", 64),
    });
    emitCard(deps.io, boardId, moved ? "card:moved" : "card:updated", card, req.userId);
    if (b.title !== undefined || b.description !== undefined) void scheduleEmbed(deps, card.id).catch(console.error);
    res.json(card);
  }));

  r.post("/cards/:id/attachments/presign", requireAuth, h(async (req, res) => {
    await cardBoard(deps, req.userId, req.params.id, true);
    const { filename, contentType, size } = req.body ?? {};
    res.json(await presignAttachment(req.params.id, filename, contentType, size));
  }));

  return r;
}
