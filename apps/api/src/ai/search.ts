import type { Deps } from "../app.js";
import { embedNow, vectorLiteral } from "./embed.js";

export const RRF_K = 60;
export const TOP_K = 10;
/** Cosine similarity at or above which a new card "looks like" an existing one. Tuned by `npm run eval:dup`. */
export const DUP_THRESHOLD = Number(process.env.DUP_THRESHOLD ?? 0.9); // eval:dup on the stand-in; re-run with Voyage

type Hit = { cardId: string; title: string };
export type Result = Hit & { score: number };

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank), rank from 1, over every list a card appears in.
 * rrf([[a, b], [b, c]]) → b first (in both lists), then a, then c.
 */
export function rrf(lists: Hit[][], k = RRF_K): Result[] {
  const byId = new Map<string, Result>();
  for (const list of lists) {
    list.forEach((h, i) => {
      const r = byId.get(h.cardId) ?? { ...h, score: 0 };
      r.score += 1 / (k + i + 1);
      byId.set(h.cardId, r);
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

/** Nearest cards on this board by cosine distance. */
async function vectorHits({ prisma }: Pick<Deps, "prisma">, boardId: string, vector: number[], limit = TOP_K) {
  // Filtering by board after the HNSW scan can return fewer than `limit` when other boards crowd the candidates;
  // iterative scan (pgvector ≥ 0.8; a harmless unknown setting before that) keeps scanning until it has enough.
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL hnsw.iterative_scan = relaxed_order`,
    prisma.$queryRaw<(Hit & { similarity: number })[]>`
      SELECT c."id" AS "cardId", c."title", 1 - (e."embedding" <=> ${vectorLiteral(vector)}::vector) AS "similarity"
      FROM "CardEmbedding" e JOIN "Card" c ON c."id" = e."cardId" JOIN "Column" col ON col."id" = c."columnId"
      WHERE col."boardId" = ${boardId}
      ORDER BY e."embedding" <=> ${vectorLiteral(vector)}::vector
      LIMIT ${limit}`,
  ]);
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

/** Full-text matches on this board, any query word (OR), best ts_rank first. Same expression as the Card_fts index. */
function textHits({ prisma }: Pick<Deps, "prisma">, boardId: string, q: string) {
  return prisma.$queryRaw<Hit[]>`
    WITH query AS (SELECT replace(plainto_tsquery('english', ${q})::text, '&', '|')::tsquery AS tsq)
    SELECT c."id" AS "cardId", c."title"
    FROM "Card" c JOIN "Column" col ON col."id" = c."columnId", query
    WHERE col."boardId" = ${boardId} AND query.tsq <> ''::tsquery
      AND to_tsvector('english', c."title" || ' ' || c."description") @@ query.tsq
    ORDER BY ts_rank(to_tsvector('english', c."title" || ' ' || c."description"), query.tsq) DESC
    LIMIT ${TOP_K}`;
}

/**
 * Hybrid search within one board: vector top 10 + full-text top 10, fused with RRF. If the query can't be embedded
 * (RelayQ/provider down) it degrades to full-text only. `mode` exists for the eval (hybrid vs vector-only).
 * Callers check membership first.
 */
export async function searchBoard(deps: Pick<Deps, "prisma">, boardId: string, q: string, mode: "hybrid" | "vector" | "text" = "hybrid") {
  const vector = mode === "text" ? null : (await embedNow([q]))?.[0];
  const [vec, text] = await Promise.all([
    vector ? vectorHits(deps, boardId, vector) : [],
    mode === "vector" ? [] : textHits(deps, boardId, q),
  ]);
  return rrf([vec.map(({ cardId, title }) => ({ cardId, title })), text]).slice(0, TOP_K);
}

/** Existing cards on this board that a new card's text is at least DUP_THRESHOLD similar to (best first, ≤ 5). */
export async function findSimilar(deps: Pick<Deps, "prisma">, boardId: string, text: string, threshold = DUP_THRESHOLD) {
  const vector = (await embedNow([text]))?.[0];
  if (!vector) return [];
  return (await vectorHits(deps, boardId, vector, 5)).filter((h) => h.similarity >= threshold);
}
