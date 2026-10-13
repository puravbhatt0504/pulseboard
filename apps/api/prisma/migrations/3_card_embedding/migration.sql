-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "CardEmbedding" (
    "cardId" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardEmbedding_pkey" PRIMARY KEY ("cardId")
);

-- AddForeignKey
ALTER TABLE "CardEmbedding" ADD CONSTRAINT "CardEmbedding_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Not expressible in schema.prisma, so a future `prisma migrate diff` will propose dropping these two; don't let it.
-- Nearest-neighbour search by cosine distance (search.ts orders by embedding <=> query).
CREATE INDEX "CardEmbedding_embedding_hnsw" ON "CardEmbedding" USING hnsw ("embedding" vector_cosine_ops);
-- Full-text half of hybrid search: same expression as search.ts's FTS query, so the planner can use it.
CREATE INDEX "Card_fts" ON "Card" USING gin (to_tsvector('english', "title" || ' ' || "description"));
