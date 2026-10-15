-- AlterTable
ALTER TABLE "Board" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY['bug', 'feature', 'docs', 'chore']::TEXT[];

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "assigneeId" TEXT,
ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "priority" TEXT;

-- CreateTable
CREATE TABLE "TriageSuggestion" (
    "cardId" TEXT NOT NULL,
    "labels" TEXT[],
    "priority" TEXT,
    "assigneeId" TEXT,
    "reason" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageSuggestion_pkey" PRIMARY KEY ("cardId")
);

-- CreateTable
CREATE TABLE "TriageFeedback" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriageFeedback_boardId_idx" ON "TriageFeedback"("boardId");

-- CreateIndex
CREATE UNIQUE INDEX "TriageFeedback_cardId_field_key" ON "TriageFeedback"("cardId", "field");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageSuggestion" ADD CONSTRAINT "TriageSuggestion_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageFeedback" ADD CONSTRAINT "TriageFeedback_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

