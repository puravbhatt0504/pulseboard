// npm run eval:search → Recall@5 on eval/search.jsonl for hybrid vs vector-only vs text-only, using the real
// searchBoard() against a throwaway Postgres + pgvector holding eval/corpus.jsonl as one board's cards.
// Exit 1 unless hybrid beats vector-only.
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { textHash, cardText, vectorLiteral } from "../src/ai/embed.js";
import { searchBoard } from "../src/ai/search.js";
import { startPostgres } from "../src/test/pg.js";
import { embedAll, readJsonl } from "./lib.js";

const corpus = readJsonl<{ key: string; title: string; description: string }>("corpus.jsonl");
const queries = readJsonl<{ query: string; expected: string }>("search.jsonl");

const pg = await startPostgres(54332);
try {
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: pg.url } });
  const prisma = new PrismaClient({ datasourceUrl: pg.url });
  const board = await prisma.board.create({ data: { title: "eval" } });
  const column = await prisma.column.create({ data: { boardId: board.id, title: "c", position: "m" } });
  const idToKey = new Map<string, string>();
  const vectors = await embedAll(corpus.map((c) => cardText(c)));
  for (const [i, c] of corpus.entries()) {
    const card = await prisma.card.create({ data: { columnId: column.id, title: c.title, description: c.description, position: `p${String(i).padStart(5, "0")}` } });
    idToKey.set(card.id, c.key);
    await prisma.$executeRaw`INSERT INTO "CardEmbedding" ("cardId", "embedding", "contentHash", "model", "updatedAt")
      VALUES (${card.id}, ${vectorLiteral(vectors[i])}::vector, ${textHash(cardText(c))}, 'eval', now())`;
  }

  const recall: Record<string, number> = {};
  for (const mode of ["hybrid", "vector", "text"] as const) {
    let hits = 0;
    for (const q of queries) {
      const top5 = (await searchBoard({ prisma }, board.id, q.query, mode)).slice(0, 5).map((r) => idToKey.get(r.cardId));
      if (top5.includes(q.expected)) hits++;
    }
    recall[mode] = hits / queries.length;
  }
  await prisma.$disconnect();
  console.log(`${corpus.length} cards, ${queries.length} queries\n\nmode     Recall@5`);
  for (const [mode, r] of Object.entries(recall)) console.log(`${mode.padEnd(8)} ${r.toFixed(3)}`);
  const ok = recall.hybrid > recall.vector;
  console.log(`\nhybrid ${ok ? "beats" : "does NOT beat"} vector-only`);
  process.exitCode = ok ? 0 : 1;
} finally {
  pg.stop();
}
