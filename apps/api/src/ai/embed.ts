import { createHash } from "node:crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { Deps } from "../app.js";
import { HttpError } from "../http.js";
import { enqueue } from "../jobs/relayq.js";
import { injectTrace } from "../tracing.js";

// EMBED_BEDROCK_MODEL set (amazon.titan-embed-text-v2:0) → embed in-process on Amazon Bedrock with the AWS
// credential chain (task role in prod): no key, no RelayQ. Otherwise Voyage through RelayQ.
const bedrockEmbedModel = () => process.env.EMBED_BEDROCK_MODEL;
/** The model whose vectors are current; stored per row so vectors from different models are never compared. */
export const embedModel = () => bedrockEmbedModel() ?? "voyage-3.5";
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
  if (!process.env.RELAYQ_URL && !bedrockEmbedModel()) return;
  if (!(await deps.redis.set(`embed:pending:${cardId}`, "1", "PX", EMBED_DEBOUNCE_MS, "NX"))) return;
  setTimeout(() => void embedIfChanged(deps, cardId).catch((e) => console.error("embed:", e.message)), EMBED_DEBOUNCE_MS).unref();
}

/** Re-embeds unless the stored embedding is of exactly this text by the current model. Returns whether it did. */
export async function embedIfChanged({ prisma }: Pick<Deps, "prisma">, cardId: string): Promise<boolean> {
  const card = await prisma.card.findUnique({ where: { id: cardId }, select: { title: true, description: true } });
  if (!card) return false;
  const text = cardText(card);
  const hash = textHash(text);
  const stored = await prisma.cardEmbedding.findUnique({ where: { cardId }, select: { contentHash: true, model: true } });
  if (stored?.contentHash === hash && stored.model === embedModel()) return false;
  if (bedrockEmbedModel()) {
    const [embedding] = (await embedNow([text])) ?? [];
    if (!embedding) throw new Error("Bedrock embedding failed");
    await storeEmbeddings({ prisma }, [{ id: `${cardId}:${hash}`, embedding }]);
    return true;
  }
  // id carries the hash, so the callback can tell a stale result (text changed since) from a current one.
  await enqueue("embed.batch", { items: [{ id: `${cardId}:${hash}`, text }], model: embedModel(), callbackUrl: callbackUrl() }, `embed:${cardId}:${hash}`);
  return true;
}

/**
 * Embeds every card with no vector from the current Bedrock model (cards from before a model switch), one at a time.
 * Runs on API boot; with everything embedded it's one query. Returns how many it embedded.
 * ponytail: both api tasks run it at once and may embed the same card twice (harmless upsert); add a Redis lock if that costs.
 */
export async function backfillEmbeddings({ prisma }: Pick<Deps, "prisma">): Promise<number> {
  if (!bedrockEmbedModel()) return 0;
  const missing = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "Card" c LEFT JOIN "CardEmbedding" e ON e."cardId" = c."id" AND e."model" = ${embedModel()}
    WHERE e."cardId" IS NULL`;
  let done = 0;
  for (const { id } of missing) if (await embedIfChanged({ prisma }, id).catch((e) => (console.error("backfill:", e.message), false))) done++;
  return done;
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
      SELECT ${cardId}, ${vectorLiteral(it.embedding)}::vector, ${hash}, ${embedModel()}, now() FROM "Card" WHERE "id" = ${cardId}
      ON CONFLICT ("cardId") DO UPDATE SET "embedding" = EXCLUDED."embedding", "contentHash" = EXCLUDED."contentHash",
        "model" = EXCLUDED."model", "updatedAt" = now()`;
  }
  return stored;
}

let bedrock: BedrockRuntimeClient | undefined;

/** Titan v2 takes one text per call: 1024-dim, normalized (cosine-ready). Sequential: parallel calls get throttled. */
async function bedrockEmbed(modelId: string, texts: string[]) {
  bedrock ??= new BedrockRuntimeClient({ maxAttempts: 6 });
  const out: unknown[] = [];
  for (const inputText of texts) {
    const res = await bedrock.send(
      new InvokeModelCommand({ modelId, contentType: "application/json", body: JSON.stringify({ inputText, dimensions: EMBED_DIMS, normalize: true }) }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    out.push(JSON.parse(new TextDecoder().decode(res.body)).embedding);
  }
  return out;
}

/**
 * Interactive embeddings (search query, duplicate check): Bedrock in-process, else RelayQ's synchronous POST /embed.
 * null when the provider is unavailable: callers fall back to full-text only.
 */
export async function embedNow(texts: string[]): Promise<number[][] | null> {
  const model = bedrockEmbedModel();
  if (model) {
    const vectors = await bedrockEmbed(model, texts).catch((e) => (console.error("embed:", e.message), null));
    return vectors?.every(isVector) ? (vectors as number[][]) : null;
  }
  const base = process.env.RELAYQ_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/embed`, {
      method: "POST",
      headers: injectTrace({ "content-type": "application/json", authorization: `Bearer ${process.env.RELAYQ_API_KEY ?? ""}` }),
      body: JSON.stringify({ texts, model: embedModel() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const { embeddings } = (await res.json()) as { embeddings: unknown[] };
    return embeddings.every(isVector) ? (embeddings as number[][]) : null;
  } catch {
    return null;
  }
}
