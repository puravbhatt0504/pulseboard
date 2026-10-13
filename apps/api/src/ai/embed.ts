import { createHash } from "node:crypto";
import type { Deps } from "../app.js";
import { HttpError } from "../http.js";
import { enqueue } from "../jobs/relayq.js";
import { injectTrace } from "../tracing.js";

export const EMBED_MODEL = "voyage-3.5";
export const EMBED_DIMS = 1024;
export const EMBED_DEBOUNCE_MS = 5000;
const MAX_CHARS = 8000; // ≈ 2,000 tokens at ~4 chars/token

/** What gets embedded. cardText({title: "Bug", description: "x"}) → "Bug\nx". (No comments: cards don't have them yet.) */
export const cardText = (c: { title: string; description: string }) => `${c.title}\n${c.description}`.slice(0, MAX_CHARS);
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
const callbackUrl = () => `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/ai/embeddings/callback`;

/**
 * Card text changed (create, title/description edit, collab persist): re-embed within 5 s. Debounced per card
 * across instances: the first change in a window sets the Redis key and schedules one check, which reads the card
 * then, so later changes in the window are included. Off when RelayQ isn't configured.
 * ponytail: the check lives in this process's timer; if it dies inside the window that change isn't indexed
 * until the card's next edit. A backfill (embedIfChanged over all cards) fixes it if that matters.
 */
export async function scheduleEmbed(deps: Deps, cardId: string) {
  if (!process.env.RELAYQ_URL) return;
  if (!(await deps.redis.set(`embed:pending:${cardId}`, "1", "PX", EMBED_DEBOUNCE_MS, "NX"))) return;
  setTimeout(() => void embedIfChanged(deps, cardId).catch((e) => console.error("embed:", e.message)), EMBED_DEBOUNCE_MS).unref();
}

/** Enqueues embed.batch unless the stored embedding is of exactly this text. Returns whether it enqueued. */
export async function embedIfChanged({ prisma }: Pick<Deps, "prisma">, cardId: string): Promise<boolean> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { title: true, description: true } });
  if (!card) return false;
  const text = cardText(card);
  const hash = textHash(text);
  const stored = await prisma.cardEmbedding.findUnique({ where: { cardId }, select: { contentHash: true } });
  if (stored?.contentHash === hash) return false;
  // id carries the hash, so the callback can tell a stale result (text changed since) from a current one.
  await enqueue("embed.batch", { items: [{ id: `${cardId}:${hash}`, text }], model: EMBED_MODEL, callbackUrl: callbackUrl() }, `embed:${cardId}:${hash}`);
  return true;
}

const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === EMBED_DIMS && v.every(Number.isFinite);
export const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

/**
 * embed.batch callback items: store each vector if it is still of the card's current text. Stale or deleted → skipped
 * (and still 2xx, so RelayQ doesn't retry something that can never apply). Returns how many were stored.
 */
export async function storeEmbeddings({ prisma }: Pick<Deps, "prisma">, items: unknown): Promise<number> {
  if (!Array.isArray(items)) throw new HttpError(400, "items required");
  let stored = 0;
  for (const it of items as { id?: unknown; embedding?: unknown }[]) {
    if (typeof it?.id !== "string" || !isVector(it.embedding)) throw new HttpError(400, "each item needs id and a 1024-number embedding");
    const [cardId, hash] = it.id.split(":");
    const card = await prisma.card.findUnique({ where: { id: cardId }, select: { title: true, description: true } });
    if (!card || textHash(cardText(card)) !== hash) continue;
    // INSERT … SELECT: a card deleted since the check inserts nothing instead of failing the foreign key.
    stored += await prisma.$executeRaw`
      INSERT INTO "CardEmbedding" ("cardId", "embedding", "contentHash", "model", "updatedAt")
      SELECT ${cardId}, ${vectorLiteral(it.embedding)}::vector, ${hash}, ${EMBED_MODEL}, now() FROM "Card" WHERE "id" = ${cardId}
      ON CONFLICT ("cardId") DO UPDATE SET "embedding" = EXCLUDED."embedding", "contentHash" = EXCLUDED."contentHash",
        "model" = EXCLUDED."model", "updatedAt" = now()`;
  }
  return stored;
}

/**
 * Interactive embeddings (search query, duplicate check) via RelayQ's synchronous POST /embed.
 * null when RelayQ or the provider is unavailable: callers fall back to full-text only.
 */
export async function embedNow(texts: string[]): Promise<number[][] | null> {
  const base = process.env.RELAYQ_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/embed`, {
      method: "POST",
      headers: injectTrace({ "content-type": "application/json", authorization: `Bearer ${process.env.RELAYQ_API_KEY ?? ""}` }),
      body: JSON.stringify({ texts, model: EMBED_MODEL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const { embeddings } = (await res.json()) as { embeddings: unknown[] };
    return embeddings.every(isVector) ? (embeddings as number[][]) : null;
  } catch {
    return null;
  }
}
