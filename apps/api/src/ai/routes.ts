import { Router } from "express";
import type { Deps } from "../app.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../boards/service.js";
import { h, HttpError } from "../http.js";
import { verifyRelayqSignature } from "../jobs/relayq.js";
import { ask, ASK_LIMIT_PER_HOUR, claudeConfigured } from "./ask.js";
import { storeEmbeddings } from "./embed.js";
import { findSimilar, searchBoard } from "./search.js";

const text = (v: unknown, field: string, max: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, `${field} must be 1-${max} chars`);
  return v;
};

export function aiRouter(deps: Deps) {
  const r = Router();

  // Non-members get 404 (requireRole), as for every other board route.
  r.get("/boards/:id/search", requireAuth, h(async (req, res) => {
    await requireRole(deps, req.params.id, req.userId, false);
    res.json(await searchBoard(deps, req.params.id, text(req.query.q, "q", 500)));
  }));

  r.post("/boards/:id/cards/similar", requireAuth, h(async (req, res) => {
    await requireRole(deps, req.params.id, req.userId, false);
    const title = text(req.body?.title, "title", 200);
    const description = typeof req.body?.description === "string" ? req.body.description.slice(0, 10_000) : "";
    res.json(await findSimilar(deps, req.params.id, `${title}\n${description}`));
  }));

  // "Ask the board": SSE stream of `token` {text} events, then `done` {citations} (or `error`).
  r.post("/boards/:id/ask", requireAuth, h(async (req, res) => {
    await requireRole(deps, req.params.id, req.userId, false);
    const question = text(req.body?.question, "question", 500);
    if (!claudeConfigured()) throw new HttpError(503, "ask is not configured");
    const key = `ratelimit:ask:${req.userId}`;
    const used = await deps.redis.incr(key);
    if (used === 1) await deps.redis.expire(key, 3600);
    if (used > ASK_LIMIT_PER_HOUR) throw new HttpError(429, "ask limit reached, try again later");

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    const abort = new AbortController();
    res.on("close", () => abort.abort()); // client went away: stop paying for tokens
    try {
      const result = await ask(deps, req.params.id, question, (t) => send("token", { text: t }), abort.signal);
      send("done", { citations: result.citations, refused: result.refused });
    } catch (e) {
      if (!abort.signal.aborted) console.error("ask failed", e);
      send("error", { error: "could not answer, try again" });
    }
    res.end();
  }));

  // RelayQ embed.batch callback; trust comes only from the HMAC signature.
  r.post("/ai/embeddings/callback", h(async (req, res) => {
    if (!verifyRelayqSignature(req.rawBody, req.headers["x-relayq-signature"])) throw new HttpError(401, "bad signature");
    await storeEmbeddings(deps, req.body?.items);
    res.status(204).end();
  }));

  return r;
}
