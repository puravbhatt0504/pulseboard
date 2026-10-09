import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { h, HttpError, requireString } from "../http.js";
import { createCard, updateCard } from "./service.js";
import { emitCard } from "../realtime/events.js";

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
    res.status(201).json(card);
  }));

  r.patch("/cards/:id", requireAuth, h(async (req, res) => {
    const b = req.body ?? {};
    const { card, boardId, moved } = await updateCard(deps, req.userId, req.params.id, {
      title: optional(b.title, "title", 200),
      description: description(b.description),
      columnId: optional(b.columnId, "columnId", 64),
      before: optional(b.before, "before", 64),
      after: optional(b.after, "after", 64),
    });
    emitCard(deps.io, boardId, moved ? "card:moved" : "card:updated", card, req.userId);
    res.json(card);
  }));

  return r;
}
